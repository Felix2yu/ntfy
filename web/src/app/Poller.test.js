import { beforeEach, describe, expect, it, vi } from "vitest";

// Poller pulls in singletons (Dexie-backed db, prefs, ...) at import time. Mock them and inject our
// own fakes through the mocks below so the poller can be exercised without a browser environment.
vi.mock("./Api", () => ({ default: { poll: vi.fn() } }));
vi.mock("./Prefs", () => ({ default: { deleteAfter: vi.fn() } }));
vi.mock("./SubscriptionManager", () => ({
  default: {
    addNotifications: vi.fn(),
    deleteNotification: vi.fn(),
    deleteNotificationBySequenceId: vi.fn(),
    getNotifications: vi.fn(),
    markNotificationReadBySequenceId: vi.fn(),
  },
}));

const api = (await import("./Api")).default;
const prefs = (await import("./Prefs")).default;
const subscriptionManager = (await import("./SubscriptionManager")).default;
const poller = (await import("./Poller")).default;

const subscription = { id: "https://ntfy.sh/mytopic", baseUrl: "https://ntfy.sh", topic: "mytopic", last: "previous" };
const message = (over = {}) => ({ id: "id1", sequence_id: "seq1", time: 100, event: "message", topic: "mytopic", ...over });

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  prefs.deleteAfter.mockResolvedValue(0); // pruning disabled
  subscriptionManager.getNotifications.mockResolvedValue([]);
});

describe("Poller.latestNotificationsBySequenceId", () => {
  it("lets a delete event win over its message when both share a timestamp", () => {
    const latest = poller.latestNotificationsBySequenceId([
      message({ id: "m1", time: 500 }),
      message({ id: "m2", time: 500, event: "message_delete" }),
    ]);
    expect(latest.seq1.id).toBe("m2");
  });

  it("always prefers a delete/clear event regardless of input order", () => {
    const latest = poller.latestNotificationsBySequenceId([
      message({ id: "d1", time: 500, event: "message_delete" }),
      message({ id: "m1", time: 500 }),
    ]);
    expect(latest.seq1.id).toBe("d1");
  });

  it("still prefers the newer message of a sequence", () => {
    const latest = poller.latestNotificationsBySequenceId([
      message({ id: "old", time: 100 }),
      message({ id: "new", time: 200, sequence_id: "seq1" }),
    ]);
    expect(latest.seq1.id).toBe("new");
  });
});

describe("Poller.poll", () => {
  it("keeps a local notification when only a later clear event comes back from the server", async () => {
    // The message itself was already stored (the poll cursor sits past it), so it is legitimately
    // absent from the server response. Removing it made messages vanish on this device only.
    subscriptionManager.getNotifications.mockResolvedValue([{ id: "id1", sequenceId: "seq1", subscriptionId: subscription.id, time: 100 }]);
    api.poll.mockResolvedValue([message({ id: "clear1", time: 100, event: "message_clear" })]);

    await poller.poll(subscription);

    expect(subscriptionManager.deleteNotification).not.toHaveBeenCalled();
    expect(subscriptionManager.markNotificationReadBySequenceId).toHaveBeenCalledWith(subscription.id, "seq1");
    // The message is not re-added either: it never came back from the server in this poll window.
    expect(subscriptionManager.addNotifications).not.toHaveBeenCalled();
  });

  it("does not re-add a notification whose sequence was read in the same second", async () => {
    api.poll.mockResolvedValue([message({ id: "m1", time: 700 }), message({ id: "c1", time: 700, event: "message_clear" })]);

    await poller.poll(subscription);

    expect(subscriptionManager.markNotificationReadBySequenceId).toHaveBeenCalledWith(subscription.id, "seq1");
    expect(subscriptionManager.addNotifications).not.toHaveBeenCalled();
  });

  it("deletes a notification whose sequence was deleted in the same second", async () => {
    api.poll.mockResolvedValue([message({ id: "m1", time: 700 }), message({ id: "d1", time: 700, event: "message_delete" })]);

    await poller.poll(subscription);

    expect(subscriptionManager.deleteNotificationBySequenceId).toHaveBeenCalledWith(subscription.id, "seq1");
    expect(subscriptionManager.addNotifications).not.toHaveBeenCalled();
  });

  it("adds plain messages as usual", async () => {
    api.poll.mockResolvedValue([message({ id: "m1", time: 700 })]);

    await poller.poll(subscription);

    expect(subscriptionManager.addNotifications).toHaveBeenCalledWith(subscription.id, [message({ id: "m1", time: 700 })]);
    expect(subscriptionManager.deleteNotificationBySequenceId).not.toHaveBeenCalled();
  });
});
