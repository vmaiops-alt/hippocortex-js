// @hippocortex/sdk -- Transparent wrap() for OpenAI and Anthropic clients

import { Hippocortex } from "./client.js";
import { resolveConfig } from "./config.js";
import { extractMemories } from "./extract.js";
import type { SynthesizeResult } from "./types.js";

const DEFAULT_BASE_URL = "https://api.hippocortex.dev/v1";

export interface WrapOptions {
  /** Hippocortex API key. Falls back to env / .hippocortex.json. */
  apiKey?: string;
  /** Hippocortex API base URL. */
  baseUrl?: string;
  /** Explicit session ID. Auto-generated if omitted. */
  sessionId?: string;
  /** Enable client-side memory extraction (default: true). */
  extract?: boolean;
}

function generateSessionId(): string {
  return `hx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── Type helpers (duck-typing, no external deps) ──

interface OpenAILikeClient {
  chat: {
    completions: {
      create: (...args: unknown[]) => unknown;
    };
  };
}

interface AnthropicLikeClient {
  messages: {
    create: (...args: unknown[]) => unknown;
  };
}

function isOpenAIClient(client: unknown): client is OpenAILikeClient {
  return (
    typeof client === "object" &&
    client !== null &&
    "chat" in client &&
    typeof (client as Record<string, unknown>).chat === "object" &&
    (client as Record<string, Record<string, unknown>>).chat !== null &&
    "completions" in (client as Record<string, Record<string, unknown>>).chat
  );
}

function isAnthropicClient(client: unknown): client is AnthropicLikeClient {
  return (
    typeof client === "object" &&
    client !== null &&
    "messages" in client &&
    typeof (client as Record<string, unknown>).messages === "object" &&
    (client as Record<string, Record<string, unknown>>).messages !== null &&
    "create" in (client as Record<string, Record<string, unknown>>).messages
  );
}

// ── Helpers ──

function extractUserMessage(messages: unknown[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      // Handle array content (multimodal)
      if (Array.isArray(msg.content)) {
        const textPart = msg.content.find(
          (p: Record<string, unknown>) => p.type === "text",
        );
        if (textPart && typeof (textPart as Record<string, unknown>).text === "string") {
          return (textPart as Record<string, unknown>).text as string;
        }
      }
    }
  }
  return null;
}

function buildContextSystemMessage(result: SynthesizeResult): string {
  if (!result.entries || result.entries.length === 0) return "";
  const parts = result.entries.map(
    (e) => `[${e.section}] ${e.content}`,
  );
  return `[Hippocortex Memory Context]\n${parts.join("\n")}`;
}

// ── OpenAI wrapping ──

function wrapOpenAI<T extends OpenAILikeClient>(
  client: T,
  hx: Hippocortex,
  sessionId: string,
  enableExtract: boolean,
): T {
  const originalCreate = client.chat.completions.create.bind(
    client.chat.completions,
  );

  client.chat.completions.create = async function wrappedCreate(
    ...args: unknown[]
  ): Promise<unknown> {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    const messages = (params.messages ?? []) as unknown[];

    // 1. Synthesize context (fault-tolerant)
    const userMsg = extractUserMessage(messages);
    if (userMsg) {
      try {
        const ctx = await hx.synthesize(userMsg);
        const contextText = buildContextSystemMessage(ctx);
        if (contextText) {
          // Prepend as system message
          const systemMsg = { role: "system" as const, content: contextText };
          params.messages = [systemMsg, ...messages];
        }
      } catch {
        // Hippocortex unavailable; proceed with original messages
      }
    }

    // 2. Call the original method
    const response = await (originalCreate as Function)(params, ...args.slice(1));

    // 3. Capture conversation (fault-tolerant, fire-and-forget)
    if (userMsg) {
      try {
        let assistantContent = "";
        // response could be a ChatCompletion object
        const resp = response as Record<string, unknown>;
        if (resp.choices && Array.isArray(resp.choices) && resp.choices.length > 0) {
          const choice = resp.choices[0] as Record<string, unknown>;
          const message = choice.message as Record<string, unknown> | undefined;
          if (message && typeof message.content === "string") {
            assistantContent = message.content;
          }
        }
        if (assistantContent) {
          hx.capture({
            type: "message",
            sessionId,
            payload: {
              role: "user",
              content: userMsg,
            },
          }).catch(() => {});
          hx.capture({
            type: "message",
            sessionId,
            payload: {
              role: "assistant",
              content: assistantContent,
            },
          }).catch(() => {});

          // Client-side memory extraction (fire-and-forget)
          // Uses originalCreate (unpatched) to avoid infinite recursion!
          if (enableExtract) {
            if (process.env["HIPPOCORTEX_SILENT"] !== "1") {
              console.log("[hippocortex] extracting memories (client-side)");
            }
            extractMemories(
              messages as Array<{ role: string; content: string }>,
              assistantContent,
              client,
              originalCreate,
            ).then((facts) => {
              if (facts.length > 0) {
                hx.capture({
                  type: "message",
                  sessionId,
                  payload: {
                    role: "system",
                    content: "extracted_memories",
                  },
                  metadata: { extractedMemories: facts },
                }).catch(() => {});
              }
            }).catch(() => {});
          }
        }
      } catch {
        // Capture failure is non-fatal
      }
    }

    return response;
  } as typeof client.chat.completions.create;

  return client;
}

// ── Anthropic wrapping ──

function wrapAnthropic<T extends AnthropicLikeClient>(
  client: T,
  hx: Hippocortex,
  sessionId: string,
  enableExtract: boolean,
): T {
  const originalCreate = client.messages.create.bind(client.messages);

  client.messages.create = async function wrappedCreate(
    ...args: unknown[]
  ): Promise<unknown> {
    const params = (args[0] ?? {}) as Record<string, unknown>;
    const messages = (params.messages ?? []) as unknown[];

    // 1. Synthesize context (fault-tolerant)
    const userMsg = extractUserMessage(messages);
    if (userMsg) {
      try {
        const ctx = await hx.synthesize(userMsg);
        const contextText = buildContextSystemMessage(ctx);
        if (contextText) {
          // For Anthropic, prepend or augment the system param
          const existingSystem = params.system;
          if (typeof existingSystem === "string" && existingSystem) {
            params.system = `${contextText}\n\n${existingSystem}`;
          } else {
            params.system = contextText;
          }
        }
      } catch {
        // Hippocortex unavailable; proceed normally
      }
    }

    // 2. Call the original method
    const response = await (originalCreate as Function)(params, ...args.slice(1));

    // 3. Capture conversation (fault-tolerant)
    if (userMsg) {
      try {
        let assistantContent = "";
        const resp = response as Record<string, unknown>;
        if (resp.content && Array.isArray(resp.content)) {
          const textBlocks = resp.content.filter(
            (b: Record<string, unknown>) => b.type === "text",
          );
          assistantContent = textBlocks
            .map((b: Record<string, unknown>) => b.text)
            .join("");
        }
        if (assistantContent) {
          hx.capture({
            type: "message",
            sessionId,
            payload: { role: "user", content: userMsg },
          }).catch(() => {});
          hx.capture({
            type: "message",
            sessionId,
            payload: { role: "assistant", content: assistantContent },
          }).catch(() => {});

          // Client-side memory extraction (fire-and-forget)
          // Uses originalCreate (unpatched) to avoid infinite recursion!
          if (enableExtract) {
            if (process.env["HIPPOCORTEX_SILENT"] !== "1") {
              console.log("[hippocortex] extracting memories (client-side)");
            }
            extractMemories(
              messages as Array<{ role: string; content: string }>,
              assistantContent,
              client,
              originalCreate,
            ).then((facts) => {
              if (facts.length > 0) {
                hx.capture({
                  type: "message",
                  sessionId,
                  payload: {
                    role: "system",
                    content: "extracted_memories",
                  },
                  metadata: { extractedMemories: facts },
                }).catch(() => {});
              }
            }).catch(() => {});
          }
        }
      } catch {
        // Capture failure is non-fatal
      }
    }

    return response;
  } as typeof client.messages.create;

  return client;
}

// ── Public API ──

/**
 * Transparently wrap an OpenAI or Anthropic client to auto-capture and
 * auto-inject Hippocortex memory context.
 *
 * @example
 * ```typescript
 * import { wrap } from '@hippocortex/sdk';
 * import OpenAI from 'openai';
 *
 * const openai = wrap(new OpenAI(), { apiKey: 'hx_live_...' });
 * // Every chat.completions.create() now has memory!
 * ```
 *
 * If Hippocortex is unreachable, all calls pass through transparently.
 */
export function wrap<T>(client: T, options?: WrapOptions): T {
  const config = resolveConfig({
    apiKey: options?.apiKey,
    baseUrl: options?.baseUrl,
  });

  if (!config) {
    // No Hippocortex config found; return client unchanged
    return client;
  }

  const hx = new Hippocortex({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
  });

  const sessionId = options?.sessionId ?? generateSessionId();
  const enableExtract = options?.extract !== false;

  if (isOpenAIClient(client)) {
    return wrapOpenAI(client as unknown as OpenAILikeClient, hx, sessionId, enableExtract) as unknown as T;
  }

  if (isAnthropicClient(client)) {
    return wrapAnthropic(client as unknown as AnthropicLikeClient, hx, sessionId, enableExtract) as unknown as T;
  }

  // Unknown client type; return unchanged
  return client;
}
