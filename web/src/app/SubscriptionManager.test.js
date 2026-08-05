import { beforeEach, describe, expect, it, vi } from "vitest";

// SubscriptionManager pulls in a handful of browser/Dexie-heavy singletons at import time. Mock
// them so the module imports cleanly under the node test environment; the tests construct their
// own SubscriptionManager with an in-memory fake db, so the real db singleton is never used.
vi.mock("./Api", () => ({ default: {} }));
vi.mock("./Notifier", () => ({ default: {} }));
vi.mock("./Prefs", () => ({ default: {} }));
vi.mock("./db", () => ({ default: () => ({}) }));

const { SubscriptionManager } = await import("./SubscriptionManager");

// Minimal in-memory stand-in for the Dexie "subscriptions" table, implementing just the surface
// that syncFromRemote() (and the upsert/remove/update helpers it calls) touches.
const fakeDb = () => {
  const rows = new Map();
  const notificationRows = new Map();
  return {
    rows,
    notifications: {
      get: async (id) => notificationRows.get(id),
      add: async (notification) => {
        notificationRows.set(notification.id, notification);
      },
      put: async (notification) => {
        notificationRows.set(notification.id, notification);
      },
      where: (query) => ({
        modify: async (changes) => {
          // eslint-disable-next-line guard-for-in
          for (const [id, notification] of notificationRows) {
            if (query.id && notification.id !== query.id) continue;
            if (query.subscriptionId && notification.subscriptionId !== query.subscriptionId) continue;
            notificationRows.set(id, { ...notification, ...changes });
          }
        },
      }),
    },
    subscriptions: {
      get: async (id) => rows.get(id),
      put: async (sub) => {
        rows.set(sub.id, sub);
      },
      update: async (id, changes) => {
        const existing = rows.get(id);
        if (existing) {
          rows.set(id, { ...existing, ...changes });
        }
      },
      delete: async (id) => {
        rows.delete(id);
      },
      toArray: async () => Array.from(rows.values()),
    },
  };
};

const baseUrl = "https://ntfy.sh";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("SubscriptionManager.upsert", () => {
  it("merges fields into an existing subscription without clobbering local-only state", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);

    await manager.upsert(baseUrl, "mytopic");
    await manager.setMutedUntil("https://ntfy.sh/mytopic", 123);

    const reservation = { topic: "mytopic", everyone: "deny-all" };
    await manager.upsert(baseUrl, "mytopic", { displayName: "My Topic", reservation });

    const stored = db.rows.get("https://ntfy.sh/mytopic");
    expect(stored.reservation).toEqual(reservation);
    expect(stored.displayName).toBe("My Topic");
    expect(stored.mutedUntil).toBe(123); // local-only state preserved
  });

  it("does not write when an existing subscription would not change", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);

    await manager.upsert(baseUrl, "mytopic", { internal: true });
    const putSpy = vi.spyOn(db.subscriptions, "put");

    const result = await manager.upsert(baseUrl, "mytopic", { internal: true });

    expect(putSpy).not.toHaveBeenCalled();
    expect(result.topic).toBe("mytopic");
  });
});

describe("SubscriptionManager.syncFromRemote", () => {
  it("persists a reservation onto a subscription that already exists locally", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);

    // Topic was subscribed to before it was reserved, so it already exists locally without a
    // reservation -- exactly the state when a user clicks "Reserve topic" in the navbar.
    await manager.upsert(baseUrl, "mytopic");
    expect(db.rows.get("https://ntfy.sh/mytopic").reservation).toBeFalsy();

    const reservation = { topic: "mytopic", everyone: "deny-all" };
    await manager.syncFromRemote([{ base_url: baseUrl, topic: "mytopic" }], [reservation]);

    expect(db.rows.get("https://ntfy.sh/mytopic").reservation).toEqual(reservation);
  });

  it("clears the reservation when the remote no longer reports one", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);

    await manager.upsert(baseUrl, "mytopic", { reservation: { topic: "mytopic", everyone: "deny-all" } });

    await manager.syncFromRemote([{ base_url: baseUrl, topic: "mytopic" }], []);

    expect(db.rows.get("https://ntfy.sh/mytopic").reservation).toBeNull();
  });

  it("updates the display name on an existing subscription", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);

    await manager.upsert(baseUrl, "mytopic");
    await manager.syncFromRemote([{ base_url: baseUrl, topic: "mytopic", display_name: "My Topic" }], []);

    expect(db.rows.get("https://ntfy.sh/mytopic").displayName).toBe("My Topic");
  });
});

describe("SubscriptionManager.addNotification", () => {
  const subscriptionId = `${baseUrl}/mytopic`;
  const message = { id: "abc123", time: 123, event: "message" };

  it("adds a genuinely new notification as unread", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");

    const added = await manager.addNotification(subscriptionId, message);

    expect(added).toBe(true);
    expect(db.rows.get(subscriptionId).last).toBe("abc123");
    const stored = await db.notifications.get("abc123");
    expect(stored.new).toBe(1);
  });

  it("keeps an already-read notification read when the server re-sends it", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");

    await manager.addNotification(subscriptionId, message);
    await manager.markNotificationRead("abc123");
    expect((await db.notifications.get("abc123")).new).toBe(0);

    // Server re-sends the same cached message (e.g. after a refresh/reconnect).
    const added = await manager.addNotification(subscriptionId, message);

    expect(added).toBe(false); // Must not re-trigger a notification
    expect((await db.notifications.get("abc123")).new).toBe(0); // Read state preserved
  });
});
