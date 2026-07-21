import api from "./Api";
import prefs from "./Prefs";
import subscriptionManager from "./SubscriptionManager";
import { EVENT_MESSAGE, EVENT_MESSAGE_DELETE } from "./events";

const delayMillis = 2000; // 2 seconds
const intervalMillis = 300000; // 5 minutes

class Poller {
  constructor() {
    this.timer = null;
  }

  startWorker() {
    if (this.timer !== null) {
      return;
    }
    console.log(`[Poller] Starting worker`);
    this.timer = setInterval(() => this.pollAll(), intervalMillis);
    setTimeout(() => this.pollAll(), delayMillis);
  }

  stopWorker() {
    clearTimeout(this.timer);
  }

  async pollAll() {
    console.log(`[Poller] Polling all subscriptions`);
    const subscriptions = await subscriptionManager.all();

    await Promise.all(
      subscriptions.map(async (s) => {
        try {
          await this.poll(s);
        } catch (e) {
          console.log(`[Poller] Error polling ${s.id}`, e);
        }
      }),
    );
  }

  async poll(subscription) {
    console.log(`[Poller] Polling ${subscription.id}`);

    // For new subscriptions, get messages from the last hour to avoid loading all history
    const since = subscription.last || '12h';
    const notifications = await api.poll(subscription.baseUrl, subscription.topic, since);

    // Filter out notifications older than the prune threshold
    const deleteAfterSeconds = await prefs.deleteAfter();
    const pruneThresholdTimestamp = deleteAfterSeconds > 0 ? Math.round(Date.now() / 1000) - deleteAfterSeconds : 0;
    const recentNotifications =
      pruneThresholdTimestamp > 0 ? notifications.filter((n) => n.time >= pruneThresholdTimestamp) : notifications;

    // Find the latest notification for each sequence ID
    const latestBySequenceId = this.latestNotificationsBySequenceId(recentNotifications);

    // Delete all existing notifications for which the latest notification is marked as deleted
    const deletedSequenceIds = Object.entries(latestBySequenceId)
      .filter(([, notification]) => notification.event === EVENT_MESSAGE_DELETE)
      .map(([sequenceId]) => sequenceId);
    if (deletedSequenceIds.length > 0) {
      console.log(`[Poller] Deleting notifications with deleted sequence IDs for ${subscription.id}`, deletedSequenceIds);
      await Promise.all(
        deletedSequenceIds.map((sequenceId) => subscriptionManager.deleteNotificationBySequenceId(subscription.id, sequenceId)),
      );
    }

    // Add only the latest notification for each non-deleted sequence
    const notificationsToAdd = Object.values(latestBySequenceId).filter((n) => n.event === EVENT_MESSAGE);
    if (notificationsToAdd.length > 0) {
      console.log(`[Poller] Adding ${notificationsToAdd.length} notification(s) for ${subscription.id}`);
      await subscriptionManager.addNotifications(subscription.id, notificationsToAdd);
    } else {
      console.log(`[Poller] No new notifications found for ${subscription.id}`);
    }

    // Reconcile: remove local notifications that no longer exist on the server.
    // This handles cases where the device missed WebSocket delete events (e.g., was offline).
    if (notifications.length > 0) {
      await this.reconcileDeletedNotifications(subscription, notifications);
    }
  }

  /**
   * Compares local notifications with the server response and removes any local
   * notification whose ID is not in the server response. Only removes notifications
   * that are within the time window of the server response (i.e., notifications
   * that the server should have returned if they still existed).
   */
  async reconcileDeletedNotifications(subscription, serverNotifications) {
    const serverIds = new Set(serverNotifications.map((n) => n.id));
    const localNotifications = await subscriptionManager.getNotifications(subscription.id);
    if (localNotifications.length === 0) return;

    // Find the time range of the server response
    const serverTimes = serverNotifications.map((n) => n.time);
    const minServerTime = Math.min(...serverTimes);

    // Local notifications that are within the server's time window but missing from the response
    const staleIds = localNotifications
      .filter((n) => n.time >= minServerTime && !serverIds.has(n.id))
      .map((n) => n.id);

    if (staleIds.length > 0) {
      console.log(`[Poller] Reconciling: removing ${staleIds.length} stale notification(s) for ${subscription.id}`, staleIds);
      await Promise.all(staleIds.map((id) => subscriptionManager.deleteNotification(id)));
    }
  }

  pollInBackground(subscription) {
    (async () => {
      try {
        await this.poll(subscription);
      } catch (e) {
        console.error(`[App] Error polling subscription ${subscription.id}`, e);
      }
    })();
  }

  /**
   * Groups notifications by sequenceId and returns only the latest (highest time) for each sequence.
   * Returns an object mapping sequenceId -> latest notification.
   */
  latestNotificationsBySequenceId(notifications) {
    const latestBySequenceId = {};
    notifications.forEach((notification) => {
      const sequenceId = notification.sequence_id || notification.id;
      if (!(sequenceId in latestBySequenceId) || notification.time >= latestBySequenceId[sequenceId].time) {
        latestBySequenceId[sequenceId] = notification;
      }
    });
    return latestBySequenceId;
  }
}

const poller = new Poller();
export default poller;
