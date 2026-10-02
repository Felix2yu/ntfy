import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import userManager from "./UserManager";
import api from "./Api";

// Api.js talks to the server through the global fetch and looks up credentials via userManager.
// (vi.mock is hoisted above the imports by vitest, so the import above receives the mock.)
vi.mock("./UserManager", () => ({ default: { get: vi.fn() } }));

let fetchMock;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  userManager.get.mockResolvedValue(undefined); // anonymous by default
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Api.poll", () => {
  it("parses newline-delimited JSON and skips lines without an id", async () => {
    const body = [
      JSON.stringify({ id: "1", message: "a" }),
      JSON.stringify({ event: "keepalive" }), // no id -> skipped
      JSON.stringify({ id: "2", message: "b" }),
    ].join("\n");
    fetchMock.mockResolvedValue(new Response(body));

    const messages = await api.poll("https://ntfy.sh", "mytopic");

    expect(messages.map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("uses the plain poll URL without a since cursor", async () => {
    fetchMock.mockResolvedValue(new Response(""));
    await api.poll("https://ntfy.sh", "mytopic");
    expect(fetchMock).toHaveBeenCalledWith("https://ntfy.sh/mytopic/json?poll=1", expect.anything());
  });

  it("uses the since URL when a cursor is given", async () => {
    fetchMock.mockResolvedValue(new Response(""));
    await api.poll("https://ntfy.sh", "mytopic", 12345);
    expect(fetchMock).toHaveBeenCalledWith("https://ntfy.sh/mytopic/json?poll=1&since=12345", expect.anything());
  });
});

describe("Api.publish", () => {
  it("PUTs the message body to the base URL", async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    await api.publish("https://ntfy.sh", "mytopic", "Hello", { priority: 5, tags: ["warning"] });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ntfy.sh",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ topic: "mytopic", message: "Hello", priority: 5, tags: ["warning"] }),
      }),
    );
  });

  it("attaches basic auth when the user has a password", async () => {
    userManager.get.mockResolvedValue({ username: "phil", password: "secret" });
    fetchMock.mockResolvedValue({ status: 200 });
    await api.publish("https://ntfy.sh", "mytopic", "Hi");
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe(`Basic ${btoa("phil:secret")}`);
  });

  it("attaches bearer auth when the user has a token", async () => {
    userManager.get.mockResolvedValue({ token: "tk_abc" });
    fetchMock.mockResolvedValue({ status: 200 });
    await api.publish("https://ntfy.sh", "mytopic", "Hi");
    const [, options] = fetchMock.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer tk_abc");
  });
});

describe("Api.topicAuth", () => {
  it("returns true for a 2xx response", async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    expect(await api.topicAuth("https://ntfy.sh", "mytopic")).toBe(true);
  });

  it("returns false for 401/403", async () => {
    fetchMock.mockResolvedValue({ status: 403 });
    expect(await api.topicAuth("https://ntfy.sh", "mytopic")).toBe(false);
  });

  it("throws for any other status", async () => {
    fetchMock.mockResolvedValue({ status: 500 });
    await expect(api.topicAuth("https://ntfy.sh", "mytopic")).rejects.toThrow("Unexpected server response 500");
  });
});

describe("Api web push", () => {
  const pushSubscription = {
    endpoint: "https://push.example/abc",
    keys: { auth: "AUTH", p256dh: "P256" },
  };

  it("updateWebPush POSTs endpoint, keys and topics to the web push URL", async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    await api.updateWebPush(pushSubscription, ["topicA", "topicB"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ntfy.sh/v1/webpush",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ endpoint: "https://push.example/abc", auth: "AUTH", p256dh: "P256", topics: ["topicA", "topicB"] }),
      }),
    );
  });

  it("deleteWebPush DELETEs just the endpoint", async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    await api.deleteWebPush(pushSubscription);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://ntfy.sh/v1/webpush",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ endpoint: "https://push.example/abc" }),
      }),
    );
  });
});

describe("Api.clearMessage", () => {
  it("GETs the read endpoint for the sequence ID", async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    await api.clearMessage("https://ntfy.sh", "mytopic", "abc123");
    expect(fetchMock).toHaveBeenCalledWith("https://ntfy.sh/mytopic/abc123/read", expect.objectContaining({ method: "GET" }));
  });
});

describe("Api.clearMessages", () => {
  it("sends a single request when everything fits into one chunk", async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const failed = await api.clearMessages("https://ntfy.sh", "mytopic", ["a", "b"]);
    expect(failed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://ntfy.sh/mytopic/a,b/read", expect.objectContaining({ method: "GET" }));
  });

  it("chunks large sequence ID lists and deduplicates them", async () => {
    fetchMock.mockResolvedValue({ status: 200 });
    const failed = await api.clearMessages("https://ntfy.sh", "mytopic", [
      ...Array.from({ length: 120 }, (_, i) => `id${i}`),
      "id0", // duplicate
    ]);
    expect(failed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 120 / 50
    expect(fetchMock.mock.calls[0][0]).toBe(`https://ntfy.sh/mytopic/${Array.from({ length: 50 }, (_, i) => `id${i}`).join(",")}/read`);
  });

  it("does not throw when the server rejects a chunk", async () => {
    fetchMock.mockRejectedValue(new Error("boom"));
    const failed = await api.clearMessages("https://ntfy.sh", "mytopic", ["a", "b"]);
    expect(failed).toBe(2);
  });

  it("does nothing for an empty list", async () => {
    expect(await api.clearMessages("https://ntfy.sh", "mytopic", [])).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Api.clearTopic", () => {
  const ndjson = (messages) => messages.map((m) => JSON.stringify(m)).join("\n");

  const mockPoll = async (messages) => {
    fetchMock.mockImplementation(async (url) => {
      if (String(url).includes("/json?")) {
        // The clearTopic impl streams the response; emulate just enough of ReadableStream.
        return new Response(ndjson(messages));
      }
      return { status: 200 };
    });
  };

  it("deletes by sequence ID, not by message ID", async () => {
    await mockPoll([{ id: "msgid1", sequence_id: "seq1", time: 1, event: "message" }]);
    await api.clearTopic("https://ntfy.sh", "mytopic", undefined);
    const deleteCalls = fetchMock.mock.calls.filter(([, opts]) => opts?.method === "DELETE");
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][0]).toBe("https://ntfy.sh/mytopic/seq1");
  });

  it("skips sequences that were already deleted", async () => {
    await mockPoll([
      { id: "msgid1", sequence_id: "seq1", time: 1, event: "message" },
      { id: "msgid2", sequence_id: "seq1", time: 2, event: "message_delete" },
      { id: "msgid3", sequence_id: "seq2", time: 3, event: "message" },
    ]);
    const deleted = await api.clearTopic("https://ntfy.sh", "mytopic", undefined);
    const deleteCalls = fetchMock.mock.calls.filter(([, opts]) => opts?.method === "DELETE");
    expect(deleted).toBe(1);
    expect(deleteCalls.map(([url]) => url)).toEqual(["https://ntfy.sh/mytopic/seq2"]);
  });
});
