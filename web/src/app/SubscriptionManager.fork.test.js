import { beforeEach, describe, expect, it, vi } from "vitest";

// The read-state sync paths (markNotificationsRead / markAllNotificationsRead / syncNotificationsRead
// / markNotificationReadAndSync) are fork-only additions, so they are tested here rather than in
// SubscriptionManager.test.js, which mirrors the upstream file and runs against the real Dexie
// schema. These tests drive an in-memory fake db instead, so no IndexedDB is needed.
vi.mock("./Api", () => ({ default: { clearMessages: vi.fn() } }));
vi.mock("./Notifier", () => ({ default: {} }));
vi.mock("./Prefs", () => ({ default: {} }));
vi.mock("./db", () => ({ default: () => ({}) }));

const { SubscriptionManager } = await import("./SubscriptionManager");
const api = (await import("./Api")).default;

// Minimal in-memory stand-in for the Dexie "subscriptions" table, implementing just the surface
// that syncFromRemote() (and the upsert/remove/update helpers it calls) touches.
const fakeDb = () => {
  const rows = new Map();
  const notificationRows = new Map();
  return {
    rows,
    // Dexie runs fn inside a readwrite transaction over the given tables; the fake has no
    // concurrent writer to isolate, so it just calls fn.
    transaction: async (_mode, _tables, fn) => fn(),
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
          for (const [id, notification] of notificationRows) {
            const matchesId = !query.id || notification.id === query.id;
            const matchesSubscription = !query.subscriptionId || notification.subscriptionId === query.subscriptionId;
            if (matchesId && matchesSubscription) {
              notificationRows.set(id, { ...notification, ...changes });
            }
          }
        },
        toArray: async () =>
          Array.from(notificationRows.values()).filter((notification) =>
            Object.entries(query).every(([key, value]) => notification[key] === value),
          ),
      }),
      bulkGet: async (ids) => ids.map((id) => notificationRows.get(id)),
      bulkPut: async (notifications) => {
        notifications.forEach((notification) => notificationRows.set(notification.id, notification));
      },
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
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const addNotification = (db, subscriptionId, notification) =>
  db.notifications.add({ sequenceId: undefined, ...notification, subscriptionId });

describe("SubscriptionManager.markNotificationsRead", () => {
  const subscriptionId = `${baseUrl}/mytopic`;

  it("marks every unread notification read and returns the affected sequence IDs", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");
    await addNotification(db, subscriptionId, { id: "id1", sequenceId: "seq1", new: 1, time: 1 });
    await addNotification(db, subscriptionId, { id: "id2", sequenceId: "seq2", new: 1, time: 2 });
    await addNotification(db, subscriptionId, { id: "id3", sequenceId: "seq3", new: 0, time: 3 }); // already read

    const sequenceIds = await manager.markNotificationsRead(subscriptionId);

    expect(sequenceIds.sort()).toEqual(["seq1", "seq2"]); // only what actually changed
    expect((await db.notifications.get("id1")).new).toBe(0);
    expect((await db.notifications.get("id2")).new).toBe(0);
    expect((await db.notifications.get("id3")).new).toBe(0);
  });

  it("falls back to the message ID for notifications without a stored sequence ID", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");
    await addNotification(db, subscriptionId, { id: "legacy1", new: 1, time: 1 });

    expect(await manager.markNotificationsRead(subscriptionId)).toEqual(["legacy1"]);
  });

  it("returns an empty list when there is nothing to do", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");

    expect(await manager.markNotificationsRead(subscriptionId)).toEqual([]);
  });
});

describe("SubscriptionManager.syncNotificationsRead", () => {
  const subscriptionId = `${baseUrl}/mytopic`;

  it("publishes the sequence IDs so the other devices see the same read state", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");
    api.clearMessages.mockResolvedValue(0);

    await manager.syncNotificationsRead(subscriptionId, ["seq1", "seq2"]);

    expect(api.clearMessages).toHaveBeenCalledWith(baseUrl, "mytopic", ["seq1", "seq2"]);
  });

  it("swallows server errors -- the local read state stands either way", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");
    api.clearMessages.mockRejectedValue(new Error("offline"));

    await expect(manager.syncNotificationsRead(subscriptionId, ["seq1"])).resolves.toBeUndefined();
  });

  it("does nothing for an unknown subscription or an empty list", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.syncNotificationsRead("https://ntfy.sh/unknown", ["seq1"]);
    await manager.syncNotificationsRead(`${baseUrl}/mytopic`, []);
    expect(api.clearMessages).not.toHaveBeenCalled();
  });
});

describe("SubscriptionManager.markNotificationReadAndSync", () => {
  const subscriptionId = `${baseUrl}/mytopic`;

  it("syncs a single notification and then marks it read locally", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");
    await addNotification(db, subscriptionId, { id: "id1", sequenceId: "seq1", new: 1, time: 1 });
    api.clearMessages.mockResolvedValue(0);

    await manager.markNotificationReadAndSync({ id: "id1", sequenceId: "seq1", subscriptionId });

    expect(api.clearMessages).toHaveBeenCalledWith(baseUrl, "mytopic", ["seq1"]);
    expect((await db.notifications.get("id1")).new).toBe(0);
  });

  it("still marks read locally when publishing the read state fails", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");
    await addNotification(db, subscriptionId, { id: "id1", sequenceId: "seq1", new: 1, time: 1 });
    api.clearMessages.mockRejectedValue(new Error("no write permission"));

    await manager.markNotificationReadAndSync({ id: "id1", sequenceId: "seq1", subscriptionId });

    expect((await db.notifications.get("id1")).new).toBe(0);
  });
});

describe("SubscriptionManager.markAllNotificationsRead", () => {
  const subscriptionId = `${baseUrl}/mytopic`;

  it("marks everything read locally, publishes the read state, and returns the count", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");
    await addNotification(db, subscriptionId, { id: "id1", sequenceId: "seq1", new: 1, time: 1 });
    await addNotification(db, subscriptionId, { id: "id2", sequenceId: "seq2", new: 1, time: 2 });
    await addNotification(db, subscriptionId, { id: "id3", sequenceId: "seq3", new: 0, time: 3 });
    api.clearMessages.mockResolvedValue(0);

    const count = await manager.markAllNotificationsRead(subscriptionId);

    expect(count).toBe(2);
    expect(api.clearMessages).toHaveBeenCalledWith(baseUrl, "mytopic", ["seq1", "seq2"]);
    expect((await db.notifications.get("id1")).new).toBe(0);
    expect((await db.notifications.get("id2")).new).toBe(0);
  });

  it("returns 0 and does not call the server when nothing is unread", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");
    await addNotification(db, subscriptionId, { id: "id1", sequenceId: "seq1", new: 0, time: 1 });

    expect(await manager.markAllNotificationsRead(subscriptionId)).toBe(0);
    expect(api.clearMessages).not.toHaveBeenCalled();
  });

  it("keeps the local read state when publishing fails", async () => {
    const db = fakeDb();
    const manager = new SubscriptionManager(db);
    await manager.upsert(baseUrl, "mytopic");
    await addNotification(db, subscriptionId, { id: "id1", sequenceId: "seq1", new: 1, time: 1 });
    api.clearMessages.mockRejectedValue(new Error("no write permission"));

    expect(await manager.markAllNotificationsRead(subscriptionId)).toBe(1);
    expect((await db.notifications.get("id1")).new).toBe(0);
  });
});
