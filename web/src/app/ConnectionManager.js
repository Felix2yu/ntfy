import Connection from "./Connection";
import { hashCode } from "./utils";

/**
 * Generates a connection group key from baseUrl + user credentials.
 * Subscriptions with the same key share a single WebSocket connection.
 */
const makeConnectionGroupKey = (baseUrl, user) => {
  if (user) {
    return hashCode(`${baseUrl}|${user.username}|${user.password ?? ""}|${user.token ?? ""}`);
  }
  return hashCode(`${baseUrl}|anonymous`);
};

/**
 * The connection manager keeps track of active connections (WebSocket connections, see Connection).
 *
 * Subscriptions are grouped by (baseUrl, user credentials). All subscriptions in the same group
 * share a single WebSocket connection using the server's comma-separated topic support
 * (e.g. wss://ntfy.sh/topic1,topic2/topic3/ws).
 *
 * Its refresh() method reconciles state changes with the target state by closing/opening connections
 * as required.
 */
class ConnectionManager {
  constructor() {
    this.connections = new Map(); // groupKey -> Connection
    this.groupSubscriptions = new Map(); // groupKey -> Array<{subscriptionId, topic, since}>
    this.sinceMap = new Map(); // subscriptionId -> latest since (persists across reconnects)
    this.stateListener = null;
    this.messageListener = null;
  }

  registerStateListener(listener) {
    this.stateListener = listener;
  }

  resetStateListener() {
    this.stateListener = null;
  }

  registerMessageListener(listener) {
    this.messageListener = listener;
  }

  resetMessageListener() {
    this.messageListener = null;
  }

  /**
   * Reconciles current connections with the target subscription state.
   *
   * Groups subscriptions by (baseUrl, user). Each group gets one shared WebSocket connection.
   * When a group's membership changes, the old connection is closed and a new one is created
   * with the latest since values.
   */
  async refresh(subscriptions, users) {
    if (!subscriptions || !users) {
      return;
    }
    console.log(`[ConnectionManager] Refreshing connections`);

    // Build target groups: groupKey -> Array<{subscriptionId, topic, since}>
    const targetGroups = new Map();
    for (const sub of subscriptions) {
      const user = users.find((u) => u.baseUrl === sub.baseUrl);
      const groupKey = makeConnectionGroupKey(sub.baseUrl, user);
      if (!targetGroups.has(groupKey)) {
        targetGroups.set(groupKey, { baseUrl: sub.baseUrl, user, subs: [] });
      }
      const since = this.sinceMap.get(sub.id) ?? sub.last;
      targetGroups.get(groupKey).subs.push({
        subscriptionId: sub.id,
        topic: sub.topic,
        since,
      });
    }

    // Close connections for groups that no longer exist or have changed
    for (const [groupKey, connection] of this.connections) {
      const target = targetGroups.get(groupKey);
      const currentSubIds = this.groupSubscriptions.get(groupKey)?.map((s) => s.subscriptionId).sort() ?? [];
      const targetSubIds = target?.subs.map((s) => s.subscriptionId).sort() ?? [];

      const groupChanged =
        !target ||
        currentSubIds.length !== targetSubIds.length ||
        currentSubIds.some((id, i) => id !== targetSubIds[i]);

      if (groupChanged) {
        console.log(`[ConnectionManager] Closing connection ${groupKey} (group changed)`);
        connection.close();
        this.connections.delete(groupKey);
        this.groupSubscriptions.delete(groupKey);
      }
    }

    // Create connections for new or changed groups
    for (const [groupKey, { baseUrl, user, subs }] of targetGroups) {
      if (this.connections.has(groupKey)) {
        continue; // Already connected with correct membership
      }
      const connection = new Connection(
        groupKey,
        subs,
        baseUrl,
        user,
        (subId, notification) => this.notificationReceived(subId, notification),
        (subId, state) => this.stateChanged(subId, state),
      );
      this.connections.set(groupKey, connection);
      this.groupSubscriptions.set(groupKey, subs);
      console.log(
        `[ConnectionManager] Starting new connection ${groupKey} (${subs.length} topic(s), user: ${
          user ? user.username : "anonymous"
        })`,
      );
      connection.start();
    }
  }

  stateChanged(subscriptionId, state) {
    if (this.stateListener) {
      try {
        this.stateListener(subscriptionId, state);
      } catch (e) {
        console.error(`[ConnectionManager] Error updating state of ${subscriptionId} to ${state}`, e);
      }
    }
  }

  notificationReceived(subscriptionId, notification) {
    // Persist the latest since for this subscription across reconnects
    if (notification.id) {
      this.sinceMap.set(subscriptionId, notification.id);
    }
    if (this.messageListener) {
      try {
        this.messageListener(subscriptionId, notification);
      } catch (e) {
        console.error(`[ConnectionManager] Error handling notification for ${subscriptionId}`, e);
      }
    }
  }
}

const connectionManager = new ConnectionManager();
export default connectionManager;
