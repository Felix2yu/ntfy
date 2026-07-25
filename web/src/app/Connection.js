/* eslint-disable max-classes-per-file */
import { basicAuth, bearerAuth, encodeBase64Url, topicShortUrl, topicUrlWsMulti } from "./utils";
import { EVENT_OPEN, isNotificationEvent } from "./events";

const retryBackoffSeconds = [5, 10, 20, 30, 60, 120];

export class ConnectionState {
  static Connected = "connected";

  static Connecting = "connecting";
}

/**
 * A connection manages a single WebSocket connection for one or more topics on the same
 * server with the same credentials. Messages are routed to the correct subscription by topic.
 *
 * Handles connection status, reconnect attempts, and backoff.
 */
class Connection {
  constructor(connectionId, subscriptions, baseUrl, user, onNotification, onStateChanged) {
    this.connectionId = connectionId;
    this.baseUrl = baseUrl;
    this.user = user;
    this.onNotification = onNotification;
    this.onStateChanged = onStateChanged;
    this.ws = null;
    this.retryCount = 0;
    this.retryTimeout = null;

    // subscriptions: Array<{subscriptionId, topic, since}>
    // Build lookup maps
    this.topicToSubscriptionIds = new Map(); // topic -> Set<subscriptionId>
    this.sinceMap = new Map(); // topic -> since
    this.subscriptionIds = new Set(); // all subscriptionIds in this connection

    for (const sub of subscriptions) {
      this.subscriptionIds.add(sub.subscriptionId);
      if (!this.topicToSubscriptionIds.has(sub.topic)) {
        this.topicToSubscriptionIds.set(sub.topic, new Set());
      }
      this.topicToSubscriptionIds.get(sub.topic).add(sub.subscriptionId);
      this.sinceMap.set(sub.topic, sub.since);
    }

    this.shortUrl = topicShortUrl(baseUrl, subscriptions[0].topic);
    if (subscriptions.length > 1) {
      this.shortUrl += ` (+${subscriptions.length - 1} more)`;
    }
  }

  start() {
    const wsUrl = this.wsUrl();
    const topicCount = this.topicToSubscriptionIds.size;
    console.log(`[Connection, ${this.shortUrl}, ${this.connectionId}] Opening connection to ${wsUrl} (${topicCount} topic(s))`);

    this.ws = new WebSocket(wsUrl);
    this.ws.onopen = (event) => {
      console.log(`[Connection, ${this.shortUrl}, ${this.connectionId}] Connection established`, event);
      this.retryCount = 0;
      for (const subId of this.subscriptionIds) {
        this.onStateChanged(subId, ConnectionState.Connected);
      }
    };
    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.event === EVENT_OPEN) {
          return;
        }
        const relevantAndValid = isNotificationEvent(data.event) && "id" in data && "time" in data;
        if (!relevantAndValid) {
          console.log(`[Connection, ${this.shortUrl}, ${this.connectionId}] Unexpected message. Ignoring.`);
          return;
        }
        // Route message to the correct subscription(s) by topic
        const topic = data.topic;
        const subscriptionIds = this.topicToSubscriptionIds.get(topic);
        if (subscriptionIds) {
          // Update since for this topic
          this.sinceMap.set(topic, data.id);
          for (const subId of subscriptionIds) {
            this.onNotification(subId, data);
          }
        } else {
          console.log(`[Connection, ${this.shortUrl}, ${this.connectionId}] Message for unknown topic: ${topic}`);
        }
      } catch (e) {
        console.log(`[Connection, ${this.shortUrl}, ${this.connectionId}] Error handling message: ${e}`);
      }
    };
    this.ws.onclose = (event) => {
      if (event.wasClean) {
        console.log(
          `[Connection, ${this.shortUrl}, ${this.connectionId}] Connection closed cleanly, code=${event.code} reason=${event.reason}`,
        );
        this.ws = null;
      } else {
        const retrySeconds = retryBackoffSeconds[Math.min(this.retryCount, retryBackoffSeconds.length - 1)];
        this.retryCount += 1;
        console.log(`[Connection, ${this.shortUrl}, ${this.connectionId}] Connection died, retrying in ${retrySeconds} seconds`);
        this.retryTimeout = setTimeout(() => this.start(), retrySeconds * 1000);
        for (const subId of this.subscriptionIds) {
          this.onStateChanged(subId, ConnectionState.Connecting);
        }
      }
    };
    this.ws.onerror = (event) => {
      console.log(`[Connection, ${this.shortUrl}, ${this.connectionId}] Error occurred: ${event}`, event);
    };
  }

  close() {
    console.log(`[Connection, ${this.shortUrl}, ${this.connectionId}] Closing connection`);
    const socket = this.ws;
    const { retryTimeout } = this;
    if (socket !== null) {
      socket.close();
    }
    if (retryTimeout !== null) {
      clearTimeout(retryTimeout);
    }
    this.retryTimeout = null;
    this.ws = null;
  }

  wsUrl() {
    const params = [];
    // Use the minimum since across all topics for the initial connection
    const sinceValues = Array.from(this.sinceMap.values()).filter(Boolean);
    if (sinceValues.length > 0) {
      // Use the earliest since to avoid missing messages
      const minSince = sinceValues.reduce((a, b) => (a < b ? a : b));
      params.push(`since=${minSince}`);
    }
    if (this.user) {
      params.push(`auth=${this.authParam()}`);
    }
    const topics = Array.from(this.topicToSubscriptionIds.keys());
    const wsUrl = topicUrlWsMulti(this.baseUrl, topics);
    return params.length === 0 ? wsUrl : `${wsUrl}?${params.join("&")}`;
  }

  authParam() {
    if (this.user.password) {
      return encodeBase64Url(basicAuth(this.user.username, this.user.password));
    }
    return encodeBase64Url(bearerAuth(this.user.token));
  }
}

export default Connection;
