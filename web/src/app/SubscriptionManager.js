import api from "./Api";
import notifier from "./Notifier";
import prefs from "./Prefs";
import db from "./db";
import { topicUrl } from "./utils";
import { messageWithSequenceId } from "./notificationUtils";
import { EVENT_MESSAGE, EVENT_MESSAGE_CLEAR, EVENT_MESSAGE_DELETE } from "./events";

// Remembers the endpoint we last registered with the server, so we can remove it when the browser
// (or Apple's push service) hands out a new one. Without this, a rotated endpoint leaves the server
// with two subscriptions for one device, one of which is dead and can never be refreshed.
const webPushEndpointStorageKey = "ntfy.webPushEndpoint";

const readWebPushEndpoint = () => {
  try {
    return window.localStorage.getItem(webPushEndpointStorageKey);
  } catch {
    return null;
  }
};

const writeWebPushEndpoint = (endpoint) => {
  try {
    window.localStorage.setItem(webPushEndpointStorageKey, endpoint);
  } catch {
    // Private browsing / storage disabled: endpoint rotation cleanup is best effort.
  }
};

const clearWebPushEndpoint = () => {
  try {
    window.localStorage.removeItem(webPushEndpointStorageKey);
  } catch {
    // See above
  }
};

export class SubscriptionManager {
  constructor(dbImpl) {
    this.db = dbImpl;
  }

  /** All subscriptions, including "new count"; this is a JOIN, see https://dexie.org/docs/API-Reference#joining */
  async all() {
    const subscriptions = await this.db.subscriptions.toArray();
    return Promise.all(
      subscriptions.map(async (s) => ({
        ...s,
        new: await this.db.notifications.where({ subscriptionId: s.id, new: 1 }).count(),
      })),
    );
  }

  /**
   * List of topics for which Web Push is enabled. This excludes (a) internal topics, (b) topics that are muted,
   * and (c) topics from other hosts. Returns an empty list if Web Push is disabled.
   *
   * It is important to note that "mutedUntil" must be part of the where() query, otherwise the Dexie live query
   * will not react to it, and the Web Push topics will not be updated when the user mutes a topic.
   */
  async webPushTopics(pushPossible) {
    if (!pushPossible) {
      return [];
    }

    // the Promise.resolve wrapper is not superfluous, without it the live query breaks:
    // https://dexie.org/docs/dexie-react-hooks/useLiveQuery()#calling-non-dexie-apis-from-querier
    const enabled = await Promise.resolve(prefs.webPushEnabled());
    if (!enabled) {
      return [];
    }

    const subscriptions = await this.db.subscriptions.where({ baseUrl: config.base_url, mutedUntil: 0 }).toArray();
    return subscriptions.filter(({ internal }) => !internal).map(({ topic }) => topic);
  }

  async get(subscriptionId) {
    return this.db.subscriptions.get(subscriptionId);
  }

  async notify(subscriptionId, notification) {
    if (notification.event !== EVENT_MESSAGE) {
      return;
    }
    const subscription = await this.get(subscriptionId);
    if (subscription.mutedUntil > 0) {
      return;
    }
    const priority = notification.priority ?? 3;
    if (priority < (await prefs.minPriority())) {
      return;
    }
    await notifier.notify(subscription, notification);
  }

  /**
   * Upsert a subscription: create it if it doesn't exist yet, or merge the given fields into the
   * existing one. Merging matters for account sync, which passes the remote display name and
   * reservation -- without it, reserving/unreserving a topic you're already subscribed to would
   * never be reflected locally until the database is recreated (e.g. a fresh login). Local-only
   * state such as mutedUntil and last is preserved on merge.
   *
   * @param {string} baseUrl
   * @param {string} topic
   * @param {object} opts
   * @param {boolean} opts.internal
   * @returns
   */
  async upsert(baseUrl, topic, opts = {}) {
    const id = topicUrl(baseUrl, topic);

    const existingSubscription = await this.get(id);
    if (existingSubscription) {
      // Avoid a needless write (and the resulting Dexie live-query churn) when nothing changed.
      const changed = Object.keys(opts).some((key) => existingSubscription[key] !== opts[key]);
      if (!changed) {
        return existingSubscription;
      }
      const updatedSubscription = { ...existingSubscription, ...opts };
      await this.db.subscriptions.put(updatedSubscription);
      return updatedSubscription;
    }

    const subscription = {
      ...opts,
      id,
      baseUrl,
      topic,
      mutedUntil: 0,
      last: null,
    };

    await this.db.subscriptions.put(subscription);

    return subscription;
  }

  async syncFromRemote(remoteSubscriptions, remoteReservations) {
    console.log(`[SubscriptionManager] Syncing subscriptions from remote`, remoteSubscriptions);

    // Add remote subscriptions
    const remoteIds = await Promise.all(
      remoteSubscriptions.map(async (remote) => {
        const reservation = remoteReservations?.find((r) => remote.base_url === config.base_url && remote.topic === r.topic) || null;

        // upsert(): for topics that already exist locally this merges in the latest remote
        // display name and reservation (see upsert() for why this matters).
        const local = await this.upsert(remote.base_url, remote.topic, {
          displayName: remote.display_name, // May be undefined
          reservation, // May be null!
        });

        return local.id;
      }),
    );

    // Remove local subscriptions that do not exist remotely
    const localSubscriptions = await this.db.subscriptions.toArray();

    await Promise.all(
      localSubscriptions.map(async (local) => {
        const remoteExists = remoteIds.includes(local.id);
        if (!local.internal && !remoteExists) {
          await this.remove(local);
        }
      }),
    );
  }

  async updateWebPushSubscriptions(topics) {
    const hasWebPushTopics = topics.length > 0;
    const browserSubscription = await notifier.webPushSubscription(hasWebPushTopics);

    if (!browserSubscription) {
      console.log(
        "[SubscriptionManager] No browser subscription currently exists, so web push was never enabled or the notification permission was removed. Skipping.",
      );
      return;
    }

    const previousEndpoint = readWebPushEndpoint();

    if (hasWebPushTopics) {
      await api.updateWebPush(browserSubscription, topics);
      // The endpoint is the primary key on the server, so the POST above is idempotent. If the
      // browser rotated the endpoint, drop the old one: leaving it behind means the server keeps
      // pushing to a dead endpoint until the push service eventually reports it as gone.
      if (previousEndpoint && previousEndpoint !== browserSubscription.endpoint) {
        try {
          await api.deleteWebPush({ endpoint: previousEndpoint });
        } catch (e) {
          console.error("[SubscriptionManager] Failed to remove stale web push endpoint", e);
        }
      }
      writeWebPushEndpoint(browserSubscription.endpoint);
    } else {
      await api.deleteWebPush(browserSubscription);
      clearWebPushEndpoint();
    }
  }

  async updateState(subscriptionId, state) {
    this.db.subscriptions.update(subscriptionId, { state });
  }

  async remove(subscription) {
    await this.db.subscriptions.delete(subscription.id);
    await this.db.notifications.where({ subscriptionId: subscription.id }).delete();
  }

  async first() {
    return this.db.subscriptions.toCollection().first(); // May be undefined
  }

  async getNotifications(subscriptionId) {
    // This is quite awkward, but it is the recommended approach as per the Dexie docs.
    // It's actually fine, because the reading and filtering is quite fast. The rendering is what's
    // killing performance. See  https://dexie.org/docs/Collection/Collection.offset()#a-better-paging-approach

    return this.db.notifications
      .orderBy("time") // Sort by time
      .filter((n) => n.subscriptionId === subscriptionId)
      .reverse()
      .toArray();
  }

  async getAllNotifications() {
    return this.db.notifications
      .orderBy("time") // Efficient, see docs
      .reverse()
      .toArray();
  }

  /**
   * Adds notification, or returns false if it already exists.
   * An existing notification keeps its stored read state (e.g. the Poller inserted it first, or
   * the server re-sent a cached message after reconnect/refresh); only the last-seen marker moves.
   */
  async addNotification(subscriptionId, notification) {
    if (notification.event === EVENT_MESSAGE_DELETE || notification.event === EVENT_MESSAGE_CLEAR) {
      return false;
    }
    try {
      // Note: Service worker (sw.js) and addNotifications() duplicates this logic,
      // so if you change it here, change it there too.

      // Add notification to database; check and add in one transaction, so a poll storing the
      // same message concurrently (see addNotifications) can't slip in between
      const added = await this.db.transaction("rw", this.db.notifications, async () => {
        if (await this.db.notifications.get(notification.id)) {
          return false;
        }
        await this.db.notifications.add({
          ...messageWithSequenceId(notification),
          subscriptionId,
          new: 1, // New marker (used for bubble indicator); cannot be boolean; Dexie index limitation
        });
        return true;
      });
      if (!added) {
        // Never flip an already-read notification back to "new", but keep the last-seen marker
        // up to date, so a reconnect does not replay what we already have.
        await this.db.subscriptions.update(subscriptionId, { last: notification.id });
        return false;
      }

      // FIXME consider put() for double tab
      // Update subscription last message id (for ?since=... queries)
      await this.db.subscriptions.update(subscriptionId, {
        last: notification.id,
      });
    } catch (e) {
      console.error(`[SubscriptionManager] Error adding notification`, e);
    }
    return true;
  }

  /** Adds notifications, skipping ones that already exist; will not throw if they exist.
   *  Skipping instead of re-writing keeps the stored read state of the existing row. */
  async addNotifications(subscriptionId, notifications) {
    // Skip notifications that are already stored (e.g. delivered via WebSocket while this poll
    // was in flight), so overwriting them doesn't drop their "new" marker
    await this.db.transaction("rw", this.db.notifications, async () => {
      const existing = await this.db.notifications.bulkGet(notifications.map((n) => n.id));
      const notificationsWithSubscriptionId = notifications
        .filter((_, i) => !existing[i])
        .map((notification) => ({
          ...messageWithSequenceId(notification),
          subscriptionId,
          new: 0, // Added by the Poller: shown, but not unread
        }));
      await this.db.notifications.bulkPut(notificationsWithSubscriptionId);
    });
    const lastNotificationId = notifications.at(-1).id;
    await this.db.subscriptions.update(subscriptionId, {
      last: lastNotificationId,
    });
  }

  async updateNotification(notification) {
    const exists = await this.db.notifications.get(notification.id);
    if (!exists) {
      return false;
    }
    try {
      await this.db.notifications.put({ ...notification });
    } catch (e) {
      console.error(`[SubscriptionManager] Error updating notification`, e);
    }
    return true;
  }

  async deleteNotification(notificationId) {
    await this.db.notifications.delete(notificationId);
  }

  async deleteNotificationBySequenceId(subscriptionId, sequenceId) {
    await this.db.notifications.where({ subscriptionId, sequenceId }).delete();
  }

  async deleteNotifications(subscriptionId) {
    await this.db.notifications.where({ subscriptionId }).delete();
  }

  async markNotificationRead(notificationId) {
    await this.db.notifications.where({ id: notificationId }).modify({ new: 0 });
  }

  async markNotificationReadBySequenceId(subscriptionId, sequenceId) {
    await this.db.notifications.where({ subscriptionId, sequenceId }).modify({ new: 0 });
  }

  /**
   * Marks every notification of a subscription as read and returns the sequence IDs that changed
   * state. The caller publishes those IDs to the server (see syncNotificationsRead) so that other
   * devices end up with the same read state and unread count.
   */
  async markNotificationsRead(subscriptionId) {
    const unread = await this.db.notifications.where({ subscriptionId, new: 1 }).toArray();
    const sequenceIds = unread.map((notification) => notification.sequenceId || notification.id);
    if (unread.length > 0) {
      await this.db.notifications.bulkPut(unread.map((notification) => ({ ...notification, new: 0 })));
    }
    return sequenceIds;
  }

  /**
   * Explicit "mark all as read" for a topic: marks every notification of the subscription as read
   * locally and publishes the read state to the server so other devices converge. Returns the
   * number of notifications that actually changed state (0 if nothing was unread).
   *
   * This is the only bulk read path; navigating to a topic never marks anything as read.
   */
  async markAllNotificationsRead(subscriptionId) {
    const sequenceIds = await this.markNotificationsRead(subscriptionId);
    await this.syncNotificationsRead(subscriptionId, sequenceIds);
    return sequenceIds.length;
  }

  /**
   * Publishes the read state for the given sequence IDs so every other subscriber of the topic
   * (other devices, tabs, service worker) marks the same messages as read.
   *
   * Failures -- offline, no write permission, rate limited -- are logged and swallowed: the local
   * read state stands either way, matching how the single-notification read button behaves.
   */
  async syncNotificationsRead(subscriptionId, sequenceIds) {
    if (!sequenceIds || sequenceIds.length === 0) {
      return;
    }
    const subscription = await this.get(subscriptionId);
    if (!subscription) {
      console.error(`[SubscriptionManager] Not syncing read state, unknown subscription ${subscriptionId}`);
      return;
    }
    try {
      await api.clearMessages(subscription.baseUrl, subscription.topic, sequenceIds);
    } catch (e) {
      console.error(`[SubscriptionManager] Failed to sync read state for ${subscriptionId}`, e);
    }
  }

  /**
   * Marks a single notification as read, both locally and on the server. Used by the read button and
   * by user actions that carry `clear: true`.
   */
  async markNotificationReadAndSync(notification) {
    await this.syncNotificationsRead(notification.subscriptionId, [notification.sequenceId || notification.id]);
    await this.markNotificationRead(notification.id);
  }

  async setMutedUntil(subscriptionId, mutedUntil) {
    await this.db.subscriptions.update(subscriptionId, {
      mutedUntil,
    });
  }

  async setDisplayName(subscriptionId, displayName) {
    await this.db.subscriptions.update(subscriptionId, {
      displayName,
    });
  }

  async setReservation(subscriptionId, reservation) {
    await this.db.subscriptions.update(subscriptionId, {
      reservation,
    });
  }

  async update(subscriptionId, params) {
    await this.db.subscriptions.update(subscriptionId, params);
  }

  async pruneNotifications(thresholdTimestamp) {
    await this.db.notifications.where("time").below(thresholdTimestamp).delete();
  }
}

export default new SubscriptionManager(db());
