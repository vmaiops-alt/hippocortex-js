import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HippocortexAdapter, buildContextText } from "../base.js";

// Mock fetch globally
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

function errorResponse(code: string, message: string, status = 400) {
  return new Response(
    JSON.stringify({ ok: false, error: { code, message } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

const SYNTH_DATA = {
  packId: "p-1",
  entries: [
    { section: "procedures", content: "Check disk space first", confidence: 0.85 },
    { section: "failures", content: "OOM at batch > 1000", confidence: 0.72 },
  ],
  budget: {
    limit: 4000,
    used: 200,
    compressionRatio: 0.5,
    entriesIncluded: 2,
    entriesDropped: 0,
  },
};

describe("HippocortexAdapter", () => {
  beforeEach(() => {
    vi.stubEnv("HIPPOCORTEX_API_KEY", "hx_test_vitest");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("should capture events (fire-and-forget)", async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse({ eventId: "ev-1", status: "ingested" })
    );

    const adapter = new HippocortexAdapter({ apiKey: "hx_test_1" });
    await adapter.capture("message", { role: "user", content: "hello" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/capture");
    const body = JSON.parse(init.body);
    expect(body.type).toBe("message");
    expect(body.payload.content).toBe("hello");
    expect(body.sessionId).toMatch(/^auto-/);
  });

  it("should synthesize and return entries", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(SYNTH_DATA));

    const adapter = new HippocortexAdapter({ apiKey: "hx_test_1" });
    const entries = await adapter.synthesize("deploy");

    expect(entries).toHaveLength(2);
    expect(entries[0].section).toBe("procedures");
    expect(entries[0].confidence).toBe(0.85);
  });

  it("should return empty array on synthesize error", async () => {
    mockFetch.mockResolvedValueOnce(
      errorResponse("internal", "server error", 500)
    );

    const adapter = new HippocortexAdapter({ apiKey: "hx_test_1" });
    const entries = await adapter.synthesize("test");

    expect(entries).toEqual([]);
  });

  it("should swallow capture errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network down"));

    const adapter = new HippocortexAdapter({ apiKey: "hx_test_1" });
    // Should NOT throw
    await adapter.capture("message", { role: "user", content: "test" });
  });

  it("should return empty on synthesize network error", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const adapter = new HippocortexAdapter({ apiKey: "hx_test_1" });
    const entries = await adapter.synthesize("test");
    expect(entries).toEqual([]);
  });

  it("should be disabled without API key", async () => {
    vi.unstubAllEnvs();

    const adapter = new HippocortexAdapter({ apiKey: "" });
    expect(adapter.enabled).toBe(false);

    await adapter.capture("message", { role: "user", content: "test" });
    expect(mockFetch).not.toHaveBeenCalled();

    const entries = await adapter.synthesize("test");
    expect(entries).toEqual([]);
  });

  it("should inject context as system message", async () => {
    mockFetch.mockResolvedValueOnce(okResponse(SYNTH_DATA));

    const adapter = new HippocortexAdapter({ apiKey: "hx_test_1" });
    const messages = [{ role: "user" as const, content: "deploy" }];
    const result = await adapter.injectContext(messages, "deploy");

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("system");
    expect(result[0].content).toContain("Hippocortex Memory Context");
    expect(result[0].content).toContain("disk space");
    expect(result[1]).toEqual(messages[0]);
  });

  it("should return original messages when no context", async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse({
        ...SYNTH_DATA,
        entries: [],
      })
    );

    const adapter = new HippocortexAdapter({ apiKey: "hx_test_1" });
    const messages = [{ role: "user" as const, content: "hello" }];
    const result = await adapter.injectContext(messages, "hello");

    expect(result).toBe(messages); // Same reference
  });

  it("should use custom session ID", async () => {
    mockFetch.mockResolvedValueOnce(
      okResponse({ eventId: "ev-1", status: "ingested" })
    );

    const adapter = new HippocortexAdapter({
      apiKey: "hx_test_1",
      sessionId: "custom-sess",
    });
    expect(adapter.sessionId).toBe("custom-sess");

    await adapter.capture("message", { role: "user", content: "test" });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.sessionId).toBe("custom-sess");
  });
});

describe("buildContextText", () => {
  it("should format entries correctly", () => {
    const entries = [
      { section: "procedures" as const, content: "Step 1: check", confidence: 0.9, provenance: [] },
      { section: "failures" as const, content: "Watch for OOM", confidence: 0.7, provenance: [] },
    ];

    const text = buildContextText(entries);
    expect(text).toContain("# Hippocortex Memory Context");
    expect(text).toContain("[procedures] (confidence: 0.90)");
    expect(text).toContain("[failures] (confidence: 0.70)");
    expect(text).toContain("Step 1: check");
    expect(text).toContain("Watch for OOM");
  });
});
