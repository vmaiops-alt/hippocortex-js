/**
 * Hippocortex adapter core — shared logic for all framework adapters.
 *
 * Key behaviors:
 * - All capture calls are fire-and-forget (never block the agent).
 * - All errors are swallowed with console.warn (agent must never crash).
 * - Synthesize returns empty array on any failure.
 * - Session IDs auto-generated if not provided.
 */

import { Hippocortex } from "../client.js";
import type {
  CaptureEvent,
  CaptureEventType,
  SynthesisEntry,
  SynthesizeOptions,
  HippocortexConfig,
} from "../types.js";
import { randomUUID } from "node:crypto";

export interface AdapterConfig {
  /** Hippocortex API key (falls back to HIPPOCORTEX_API_KEY env var) */
  apiKey?: string;
  /** API base URL override */
  baseUrl?: string;
  /** Explicit session ID (auto-generated if omitted) */
  sessionId?: string;
  /** Request timeout in ms (default: 10000 — lower for adapters) */
  timeoutMs?: number;
}

export interface Message {
  role: "system" | "user" | "assistant" | "function" | "tool";
  content: string;
  [key: string]: unknown;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class HippocortexAdapter {
  private readonly client: Hippocortex | null;
  readonly sessionId: string;
  readonly enabled: boolean;

  constructor(config: AdapterConfig = {}) {
    const apiKey = config.apiKey || process.env.HIPPOCORTEX_API_KEY || "";

    if (!apiKey) {
      console.warn(
        "[hippocortex] No API key provided. Set HIPPOCORTEX_API_KEY or pass apiKey. " +
          "Memory features will be disabled."
      );
      this.client = null;
      this.enabled = false;
      this.sessionId = config.sessionId || `auto-${randomUUID().slice(0, 12)}`;
      return;
    }

    this.client = new Hippocortex({
      apiKey,
      baseUrl: config.baseUrl || process.env.HIPPOCORTEX_BASE_URL,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.sessionId = config.sessionId || `auto-${randomUUID().slice(0, 12)}`;
    this.enabled = true;
  }

  /**
   * Fire-and-forget capture. Never throws, never blocks.
   */
  async capture(
    type: CaptureEventType,
    payload: Record<string, unknown>,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.capture({
        type,
        sessionId: this.sessionId,
        payload,
        metadata,
      });
    } catch (err) {
      console.warn("[hippocortex] capture failed (swallowed):", err);
    }
  }

  /**
   * Synthesize context. Returns empty array on any failure.
   */
  async synthesize(
    query: string,
    options?: SynthesizeOptions
  ): Promise<SynthesisEntry[]> {
    if (!this.client) return [];
    try {
      const result = await this.client.synthesize(query, options);
      return result.entries;
    } catch (err) {
      console.warn("[hippocortex] synthesize failed (swallowed):", err);
      return [];
    }
  }

  /**
   * Synthesize context and prepend as a system message.
   * Returns a new messages array (never modifies input).
   */
  async injectContext(
    messages: Message[],
    query: string,
    maxTokens: number = 4000
  ): Promise<Message[]> {
    const entries = await this.synthesize(query, { maxTokens });
    if (entries.length === 0) return messages;

    const contextText = buildContextText(entries);
    const systemMsg: Message = { role: "system", content: contextText };

    return [systemMsg, ...messages];
  }
}

/**
 * Build a formatted context string from synthesis entries.
 */
export function buildContextText(entries: SynthesisEntry[]): string {
  const parts = entries.map(
    (e) =>
      `[${e.section}] (confidence: ${e.confidence.toFixed(2)})\n${e.content}`
  );

  return (
    "# Hippocortex Memory Context\n" +
    "The following is synthesized context from past experience. " +
    "Use it to inform your responses.\n\n" +
    parts.join("\n\n")
  );
}
