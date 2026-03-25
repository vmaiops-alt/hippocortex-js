// @hippocortex/sdk -- Auto-instrumentation (Sentry-style)
// Import this module to automatically patch OpenAI and Anthropic SDKs.
//
// Usage:
//   import '@hippocortex/sdk/auto';
//   // All OpenAI/Anthropic calls now have memory!

import { hostname } from "node:os";
import { Hippocortex } from "./client.js";
import { resolveConfig } from "./config.js";
import { extractMemories } from "./extract.js";
import type { SynthesizeResult, CaptureEvent } from "./types.js";

const PATCHED = Symbol.for("hippocortex.auto.patched");
const DEFAULT_BASE_URL = "https://api.hippocortex.dev/v1";

let _initialized = false;

// ── Session ID ──

function generateSessionId(): string {
  const host = hostname().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32);
  const pid = process.pid;
  const start = Math.floor(Date.now() / 1000);
  return `hx_auto_${host}_${pid}_${start}`;
}

// ── Logging ──

function log(msg: string): void {
  if (process.env["HIPPOCORTEX_SILENT"] === "1") return;
  console.log(`[hippocortex] ${msg}`);
}

function warn(msg: string): void {
  if (process.env["HIPPOCORTEX_SILENT"] === "1") return;
  console.warn(`[hippocortex] ${msg}`);
}

// ── Helpers ──

function extractUserMessage(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as unknown as Record<string, unknown>;
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      if (Array.isArray(msg.content)) {
        const textPart = msg.content.find(
          (p: Record<string, unknown>) => p.type === "text",
        );
        if (textPart && typeof (textPart as unknown as Record<string, unknown>).text === "string") {
          return (textPart as unknown as Record<string, unknown>).text as string;
        }
      }
    }
  }
  return null;
}

function buildContextSystemMessage(result: SynthesizeResult): string {
  if (!result.entries || result.entries.length === 0) return "";
  const parts = result.entries.map((e) => `[${e.section}] ${e.content}`);
  return `[Hippocortex Memory Context]\n${parts.join("\n")}`;
}

function fireAndForget(hx: Hippocortex, event: CaptureEvent): void {
  try {
    hx.capture(event).catch(() => {});
  } catch {
    // Never break caller
  }
}

// ── OpenAI Patching ──

async function patchOpenAI(hx: Hippocortex, sessionId: string): Promise<boolean> {
  try {
    const openaiModule = await import("openai");
    const OpenAI = openaiModule.default ?? openaiModule;

    // Navigate to the Chat.Completions prototype
    const proto =
      OpenAI?.Chat?.Completions?.prototype ??
      OpenAI?.OpenAI?.Chat?.Completions?.prototype ??
      null;

    if (!proto || !proto.create) return false;

    // Idempotency check
    if ((proto as unknown as Record<symbol, unknown>)[PATCHED]) return false;

    const origCreate = proto.create;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (proto as any).create = async function patchedCreate(
      this: unknown,
      params: any,
      options?: any,
    ): Promise<any> {
      const messages = Array.isArray(params.messages) ? [...params.messages] : [];
      const userMsg = extractUserMessage(messages);
      let enrichedParams = { ...params };

      // Inject context
      if (userMsg) {
        try {
          const ctx = await hx.synthesize(userMsg);
          const contextText = buildContextSystemMessage(ctx);
          if (contextText) {
            const systemMsg = { role: "system" as const, content: contextText };
            enrichedParams = { ...enrichedParams, messages: [systemMsg, ...messages] };
          }
        } catch {
          // HX down, proceed without context
        }
      }

      // Detect streaming
      const isStream = !!enrichedParams.stream;

      // Call original
      const result = await origCreate.call(this, enrichedParams, options);

      // Capture
      if (userMsg) {
        if (isStream) {
          // Wrap the async iterable to collect chunks while passing through
          return wrapOpenAIStream(result, hx, sessionId, userMsg);
        } else {
          // Non-streaming: capture directly
          try {
            const resp = result as unknown as Record<string, unknown>;
            if (resp.choices && Array.isArray(resp.choices) && resp.choices.length > 0) {
              const choice = resp.choices[0] as unknown as Record<string, unknown>;
              const message = choice.message as unknown as Record<string, unknown> | undefined;
              if (message && typeof message.content === "string" && message.content) {
                fireAndForget(hx, {
                  type: "message",
                  sessionId,
                  payload: { role: "user", content: userMsg },
                });
                fireAndForget(hx, {
                  type: "message",
                  sessionId,
                  payload: { role: "assistant", content: message.content },
                });

                // Client-side memory extraction (fire-and-forget)
                // Uses origCreate (unpatched) to avoid infinite recursion!
                if (process.env["HIPPOCORTEX_EXTRACT"] !== "false") {
                  log("extracting memories (client-side)");
                  const extractClient = {
                    chat: { completions: { create: origCreate.bind(this) } },
                  };
                  extractMemories(
                    messages as Array<{ role: string; content: string }>,
                    message.content,
                    extractClient,
                  ).then((facts) => {
                    if (facts.length > 0) {
                      fireAndForget(hx, {
                        type: "message",
                        sessionId,
                        payload: { role: "system", content: "extracted_memories" },
                        metadata: { extractedMemories: facts },
                      });
                    }
                  }).catch(() => {});
                }
              }
            }
          } catch {
            // Capture failure is non-fatal
          }
        }
      }

      return result;
    };

    (proto as unknown as Record<symbol, boolean>)[PATCHED] = true;
    return true;
  } catch {
    // openai not installed or structure changed
    return false;
  }
}

function wrapOpenAIStream(
  stream: unknown,
  hx: Hippocortex,
  sessionId: string,
  userMsg: string,
): unknown {
  // The OpenAI SDK returns a Stream object that is async-iterable
  // and also has helper methods like .toReadableStream()
  // We wrap the async iterator to collect chunks while passing them through.

  const original = stream as AsyncIterable<unknown> & Record<string, unknown>;

  // Collect content deltas
  const chunks: string[] = [];

  const originalIterator = original[Symbol.asyncIterator].bind(original);

  const wrappedIterator = async function* () {
    try {
      for await (const chunk of { [Symbol.asyncIterator]: originalIterator }) {
        // Collect text content from delta
        try {
          const c = chunk as unknown as Record<string, unknown>;
          if (c.choices && Array.isArray(c.choices) && c.choices.length > 0) {
            const delta = (c.choices[0] as unknown as Record<string, unknown>).delta as unknown as Record<string, unknown> | undefined;
            if (delta && typeof delta.content === "string") {
              chunks.push(delta.content);
            }
          }
        } catch {
          // Don't break iteration on collection failure
        }
        yield chunk;
      }
    } finally {
      // Stream finished, capture the full response
      const fullContent = chunks.join("");
      if (fullContent) {
        fireAndForget(hx, {
          type: "message",
          sessionId,
          payload: { role: "user", content: userMsg },
        });
        fireAndForget(hx, {
          type: "message",
          sessionId,
          payload: { role: "assistant", content: fullContent },
        });
      }
    }
  };

  // Create a proxy that delegates everything to the original stream
  // but overrides the async iterator
  const proxy = new Proxy(original, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return () => wrappedIterator();
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return proxy;
}

// ── Anthropic Patching ──

async function patchAnthropic(hx: Hippocortex, sessionId: string): Promise<boolean> {
  try {
    const anthropicModule = await import("@anthropic-ai/sdk");
    const Anthropic = anthropicModule.default ?? anthropicModule;

    const proto =
      Anthropic?.Messages?.prototype ??
      Anthropic?.Anthropic?.Messages?.prototype ??
      null;

    if (!proto || !proto.create) return false;

    // Idempotency check
    if ((proto as unknown as Record<symbol, unknown>)[PATCHED]) return false;

    const origCreate = proto.create;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (proto as any).create = async function patchedCreate(
      this: unknown,
      params: any,
      options?: any,
    ): Promise<any> {
      const messages = Array.isArray(params.messages) ? [...params.messages] : [];
      const userMsg = extractUserMessage(messages);
      let enrichedParams = { ...params };

      // Inject context
      if (userMsg) {
        try {
          const ctx = await hx.synthesize(userMsg);
          const contextText = buildContextSystemMessage(ctx);
          if (contextText) {
            const existingSystem = params.system;
            if (typeof existingSystem === "string" && existingSystem) {
              enrichedParams = { ...enrichedParams, system: `${contextText}\n\n${existingSystem}` };
            } else {
              enrichedParams = { ...enrichedParams, system: contextText };
            }
          }
        } catch {
          // HX down, proceed
        }
      }

      const isStream = !!enrichedParams.stream;

      // Call original
      const result = await origCreate.call(this, enrichedParams, options);

      // Capture
      if (userMsg) {
        if (isStream) {
          return wrapAnthropicStream(result, hx, sessionId, userMsg);
        } else {
          try {
            const resp = result as unknown as Record<string, unknown>;
            if (resp.content && Array.isArray(resp.content)) {
              const textBlocks = resp.content.filter(
                (b: Record<string, unknown>) => b.type === "text",
              );
              const assistantContent = textBlocks
                .map((b: Record<string, unknown>) => b.text)
                .join("");
              if (assistantContent) {
                fireAndForget(hx, {
                  type: "message",
                  sessionId,
                  payload: { role: "user", content: userMsg },
                });
                fireAndForget(hx, {
                  type: "message",
                  sessionId,
                  payload: { role: "assistant", content: assistantContent },
                });

                // Client-side memory extraction (fire-and-forget)
                // Uses origCreate (unpatched) to avoid infinite recursion!
                if (process.env["HIPPOCORTEX_EXTRACT"] !== "false") {
                  log("extracting memories (client-side)");
                  const extractClient = {
                    messages: { create: origCreate.bind(this) },
                  };
                  extractMemories(
                    messages as Array<{ role: string; content: string }>,
                    assistantContent,
                    extractClient,
                  ).then((facts) => {
                    if (facts.length > 0) {
                      fireAndForget(hx, {
                        type: "message",
                        sessionId,
                        payload: { role: "system", content: "extracted_memories" },
                        metadata: { extractedMemories: facts },
                      });
                    }
                  }).catch(() => {});
                }
              }
            }
          } catch {
            // Capture failure is non-fatal
          }
        }
      }

      return result;
    };

    (proto as unknown as Record<symbol, boolean>)[PATCHED] = true;
    return true;
  } catch {
    // anthropic not installed or structure changed
    return false;
  }
}

function wrapAnthropicStream(
  stream: unknown,
  hx: Hippocortex,
  sessionId: string,
  userMsg: string,
): unknown {
  const original = stream as AsyncIterable<unknown> & Record<string, unknown>;
  const chunks: string[] = [];

  const originalIterator = original[Symbol.asyncIterator].bind(original);

  const wrappedIterator = async function* () {
    try {
      for await (const event of { [Symbol.asyncIterator]: originalIterator }) {
        try {
          const ev = event as unknown as Record<string, unknown>;
          // Anthropic streaming events have type: 'content_block_delta'
          if (ev.type === "content_block_delta") {
            const delta = ev.delta as unknown as Record<string, unknown> | undefined;
            if (delta && typeof delta.text === "string") {
              chunks.push(delta.text);
            }
          }
        } catch {
          // Don't break iteration
        }
        yield event;
      }
    } finally {
      const fullContent = chunks.join("");
      if (fullContent) {
        fireAndForget(hx, {
          type: "message",
          sessionId,
          payload: { role: "user", content: userMsg },
        });
        fireAndForget(hx, {
          type: "message",
          sessionId,
          payload: { role: "assistant", content: fullContent },
        });
      }
    }
  };

  const proxy = new Proxy(original, {
    get(target, prop, receiver) {
      if (prop === Symbol.asyncIterator) {
        return () => wrappedIterator();
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  return proxy;
}

// ── Init ──

async function init(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  const config = resolveConfig();
  if (!config) {
    warn("no API key found. Set HIPPOCORTEX_API_KEY or create .hippocortex.json. Auto-instrumentation disabled.");
    return;
  }

  const hx = new Hippocortex({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
  });

  const sessionId = generateSessionId();

  const [openaiPatched, anthropicPatched] = await Promise.all([
    patchOpenAI(hx, sessionId),
    patchAnthropic(hx, sessionId),
  ]);

  if (openaiPatched || anthropicPatched) {
    // Extract tenant hint from API key
    const tenantHint = config.apiKey.slice(0, 12) + "...";
    const sdks = [openaiPatched && "OpenAI", anthropicPatched && "Anthropic"]
      .filter(Boolean)
      .join(", ");
    log(`auto-instrumentation active for ${sdks} (capturing to ${tenantHint})`);
  } else {
    log("auto-instrumentation loaded but no supported SDKs found (OpenAI/Anthropic).");
  }
}

// Self-executing initialization
init().catch(() => {
  // Never crash the host process
});

// Exports for testing
export {
  generateSessionId as _generateSessionId,
  extractUserMessage as _extractUserMessage,
  buildContextSystemMessage as _buildContextSystemMessage,
  PATCHED as _PATCHED,
  init as _init,
};
