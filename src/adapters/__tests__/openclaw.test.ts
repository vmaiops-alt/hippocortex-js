import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OpenClawMemory, autoMemory } from "../openclaw.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function okResponse(data: unknown) {
  return new Response(
    JSON.stringify({
      ok: true,
      data,
      meta: { requestId: "r-1", tenantId: "t-1", durationMs: 5 },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

const CAPTURE_OK = { eventId: "ev-1", status: "ingested" };

const SYNTH_DATA = {
  packId: "p-1",
  entries: [
    {
      section: "procedures",
      content: "Always validate inputs",
      confidence: 0.88,
    },
  ],
  budget: {
    limit: 4000,
    used: 50,
    compressionRatio: 0.5,
    entriesIncluded: 1,
    entriesDropped: 0,
  },
};

const SYNTH_EMPTY = {
  packId: "p-e",
  entries: [],
  budget: {
    limit: 4000,
    used: 0,
    compressionRatio: 0,
    entriesIncluded: 0,
    entriesDropped: 0,
  },
};

describe("OpenClawMemory", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("should capture user messages via onMessage", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(CAPTURE_OK))
      .mockResolvedValueOnce(okResponse(SYNTH_DATA));

    const memory = new OpenClawMemory({ apiKey: "hx_test_oc" });
    const context = await memory.onMessage("hello world");

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call = capture
    const captureBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(captureBody.type).toBe("message");
    expect(captureBody.payload.role).toBe("user");
    expect(captureBody.payload.content).toBe("hello world");

    // Should return context
    expect(context).toContain("Hippocortex Memory Context");
    expect(context).toContain("validate inputs");
  });

  it("should return null when no context available", async () => {
    mockFetch
      .mockResolvedValueOnce(okResponse(CAPTURE_OK))
      .mockResolvedValueOnce(okResponse(SYNTH_EMPTY));

    const memory = new OpenClawMemory({ apiKey: "hx_test_oc" });
    const context = await memory.onMessage("hello");

    expect(context).toBeNull();
  });

  it("should capture assistant responses", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(CAPTURE_OK));

    const memory = new OpenClawMemory({ apiKey: "hx_test_oc" });
    await memory.onResponse("Here is the answer");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.payload.role).toBe("assistant");
    expect(body.payload.content).toBe("Here is the answer");
  });

  it("should capture tool calls", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(CAPTURE_OK));

    const memory = new OpenClawMemory({ apiKey: "hx_test_oc" });
    await memory.onToolCall("exec", { command: "ls -la" });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.type).toBe("tool_call");
    expect(body.payload.tool_name).toBe("exec");
  });

  it("should capture tool results", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(CAPTURE_OK));

    const memory = new OpenClawMemory({ apiKey: "hx_test_oc" });
    await memory.onToolResult("exec", "file1.txt\nfile2.txt");

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.type).toBe("tool_result");
    expect(body.payload.tool_name).toBe("exec");
  });

  it("should inject context into messages array", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(SYNTH_DATA));

    const memory = new OpenClawMemory({ apiKey: "hx_test_oc" });
    const messages = [{ role: "user" as const, content: "deploy" }];
    const result = await memory.injectIntoMessages(messages, "deploy");

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("Hippocortex");
  });

  it("should survive server errors gracefully", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const memory = new OpenClawMemory({ apiKey: "hx_test_oc" });

    // None of these should throw
    const context = await memory.onMessage("test");
    expect(context).toBeNull();

    await memory.onResponse("response");
    await memory.onToolCall("kubectl", {});
    await memory.onToolResult("kubectl", "output");
  });
});

describe("autoMemory", () => {
  it("should create an OpenClawMemory instance", () => {
    const memory = autoMemory({ apiKey: "hx_test_auto" });
    expect(memory).toBeInstanceOf(OpenClawMemory);
    expect(memory.enabled).toBe(true);
  });

  it("should be disabled without API key", () => {
    const memory = autoMemory({ apiKey: "" });
    expect(memory.enabled).toBe(false);
  });
});
