/**
 * Hippocortex adapter for OpenClaw agents.
 *
 * Provides middleware that captures agent events and injects synthesized
 * context into the system prompt.
 *
 * @example
 * ```typescript
 * import { autoMemory } from "@hippocortex/sdk/adapters";
 *
 * const memory = autoMemory({ apiKey: "hx_live_..." });
 *
 * // In your message handler:
 * const context = await memory.onMessage(userMessage);
 * if (context) {
 *   // Prepend context to your system prompt
 *   systemPrompt = context + "\n\n" + systemPrompt;
 * }
 *
 * // After generating a response:
 * await memory.onResponse(assistantMessage);
 * ```
 */

import type { CaptureEventType } from "../types.js";
import { HippocortexAdapter, buildContextText } from "./base.js";
import type { AdapterConfig, Message } from "./base.js";

export interface OpenClawAdapterConfig extends AdapterConfig {
  /** Whether to inject synthesized context (default: true) */
  injectMemory?: boolean;
  /** Whether to capture message events (default: true) */
  captureMessages?: boolean;
  /** Whether to capture tool events (default: true) */
  captureTools?: boolean;
}

export class OpenClawMemory {
  private readonly adapter: HippocortexAdapter;
  private readonly injectMemory: boolean;
  private readonly captureMessages: boolean;
  private readonly captureTools: boolean;

  constructor(config: OpenClawAdapterConfig = {}) {
    this.adapter = new HippocortexAdapter(config);
    this.injectMemory = config.injectMemory ?? true;
    this.captureMessages = config.captureMessages ?? true;
    this.captureTools = config.captureTools ?? true;
  }

  /** Session ID for this adapter instance */
  get sessionId(): string {
    return this.adapter.sessionId;
  }

  /** Whether the adapter is enabled (has API key) */
  get enabled(): boolean {
    return this.adapter.enabled;
  }

  /**
   * Process an inbound message.
   *
   * Captures the message and returns synthesized context to inject
   * into the system prompt (or null if no context available).
   */
  async onMessage(
    message: string,
    role: "user" | "assistant" = "user",
    metadata?: Record<string, unknown>
  ): Promise<string | null> {
    if (this.captureMessages) {
      await this.adapter.capture(
        "message",
        { role, content: message },
        { source: "openclaw", ...metadata }
      );
    }

    if (this.injectMemory && role === "user") {
      return this.getContext(message);
    }

    return null;
  }

  /**
   * Get synthesized context for a query.
   *
   * Returns a formatted string suitable for injection into a system
   * prompt, or null if no relevant context is available.
   */
  async getContext(
    query: string,
    maxTokens: number = 4000
  ): Promise<string | null> {
    const entries = await this.adapter.synthesize(query, { maxTokens });
    if (entries.length === 0) return null;
    return buildContextText(entries);
  }

  /**
   * Capture an outbound response.
   */
  async onResponse(
    response: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    if (this.captureMessages) {
      await this.adapter.capture(
        "message",
        { role: "assistant", content: response.slice(0, 2000) },
        { source: "openclaw", ...metadata }
      );
    }
  }

  /**
   * Capture a tool call.
   */
  async onToolCall(
    toolName: string,
    toolInput: unknown,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    if (this.captureTools) {
      let inputStr: string;
      if (typeof toolInput === "string") {
        inputStr = toolInput.slice(0, 2000);
      } else {
        try {
          inputStr = JSON.stringify(toolInput).slice(0, 2000);
        } catch {
          inputStr = String(toolInput).slice(0, 2000);
        }
      }

      await this.adapter.capture(
        "tool_call",
        { tool_name: toolName, input: inputStr },
        { source: "openclaw", ...metadata }
      );
    }
  }

  /**
   * Capture a tool result.
   */
  async onToolResult(
    toolName: string,
    result: unknown,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    if (this.captureTools) {
      const resultStr = result ? String(result).slice(0, 2000) : "";
      await this.adapter.capture(
        "tool_result",
        { tool_name: toolName, output: resultStr },
        { source: "openclaw", ...metadata }
      );
    }
  }

  /**
   * Inject synthesized context into a messages array.
   * Prepends a system message with memory context.
   */
  async injectIntoMessages(
    messages: Message[],
    query: string
  ): Promise<Message[]> {
    return this.adapter.injectContext(messages, query);
  }
}

/**
 * Create an OpenClaw auto-memory instance.
 *
 * @example
 * ```typescript
 * import { autoMemory } from "@hippocortex/sdk/adapters";
 *
 * const memory = autoMemory({ apiKey: "hx_live_..." });
 * ```
 */
export function autoMemory(
  config: OpenClawAdapterConfig = {}
): OpenClawMemory {
  return new OpenClawMemory(config);
}
