// @hippocortex/sdk -- Client-side memory extraction
// Uses the user's own LLM client to extract memorable facts from conversations.
// This eliminates server-side LLM costs entirely.

const EXTRACTION_PROMPT = `Extract key facts, preferences, decisions, and important information from this conversation turn. Return as a JSON array of short strings. Only include genuinely memorable facts. If nothing notable, return [].

User: {user_message}
Assistant: {assistant_response}`;

const EXTRACTION_TIMEOUT_MS = 3000;

// Cheaper models preferred for extraction to minimize token overhead
const OPENAI_EXTRACTION_MODEL = "gpt-4o-mini";
const ANTHROPIC_EXTRACTION_MODEL = "claude-3-haiku-20240307";

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

function buildExtractionPrompt(userMessage: string, assistantResponse: string): string {
  return EXTRACTION_PROMPT
    .replace("{user_message}", userMessage)
    .replace("{assistant_response}", assistantResponse);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Extraction timeout")), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function parseExtractedFacts(text: string): string[] {
  try {
    // Try to find JSON array in the response
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item: unknown) => typeof item === "string" && item.trim().length > 0);
  } catch {
    return [];
  }
}

async function extractViaOpenAI(
  client: OpenAILikeClient,
  userMessage: string,
  assistantResponse: string,
  createFn?: (...args: unknown[]) => unknown,
): Promise<string[]> {
  const prompt = buildExtractionPrompt(userMessage, assistantResponse);
  const create = createFn ?? client.chat.completions.create.bind(client.chat.completions);

  const response = await withTimeout(
    create({
      model: OPENAI_EXTRACTION_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 512,
    }) as Promise<unknown>,
    EXTRACTION_TIMEOUT_MS,
  );

  const resp = response as Record<string, unknown>;
  if (resp.choices && Array.isArray(resp.choices) && resp.choices.length > 0) {
    const choice = resp.choices[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;
    if (message && typeof message.content === "string") {
      return parseExtractedFacts(message.content);
    }
  }

  return [];
}

async function extractViaAnthropic(
  client: AnthropicLikeClient,
  userMessage: string,
  assistantResponse: string,
  createFn?: (...args: unknown[]) => unknown,
): Promise<string[]> {
  const prompt = buildExtractionPrompt(userMessage, assistantResponse);
  const create = createFn ?? client.messages.create.bind(client.messages);

  const response = await withTimeout(
    create({
      model: ANTHROPIC_EXTRACTION_MODEL,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 512,
    }) as Promise<unknown>,
    EXTRACTION_TIMEOUT_MS,
  );

  const resp = response as Record<string, unknown>;
  if (resp.content && Array.isArray(resp.content)) {
    const textBlocks = resp.content.filter(
      (b: Record<string, unknown>) => b.type === "text",
    );
    const text = textBlocks.map((b: Record<string, unknown>) => b.text).join("");
    return parseExtractedFacts(text);
  }

  return [];
}

/**
 * Extract memorable facts from a conversation turn using the user's own LLM client.
 *
 * Uses a cheap/small model (gpt-4o-mini or claude-3-haiku) to minimize cost.
 * Returns an empty array if extraction fails for any reason.
 *
 * @param messages - The conversation messages (used to find the last user message)
 * @param response - The assistant's response text
 * @param client - An OpenAI or Anthropic client instance
 * @param originalCreateFn - Optional: the original (unpatched) create function to avoid recursion
 */
export async function extractMemories(
  messages: Array<{ role: string; content: string }>,
  response: string,
  client: unknown,
  originalCreateFn?: (...args: unknown[]) => unknown,
): Promise<string[]> {
  // Check env var to disable globally
  if (process.env["HIPPOCORTEX_EXTRACT"] === "false") {
    return [];
  }

  try {
    // Find the last user message
    let userMessage = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === "user") {
        userMessage = messages[i]!.content;
        break;
      }
    }

    if (!userMessage || !response) {
      return [];
    }

    if (isOpenAIClient(client)) {
      return await extractViaOpenAI(client, userMessage, response, originalCreateFn);
    }

    if (isAnthropicClient(client)) {
      return await extractViaAnthropic(client, userMessage, response, originalCreateFn);
    }

    // Unknown client type
    return [];
  } catch (err) {
    // Extraction failure is never fatal
    const msg = err instanceof Error ? err.message : "unknown error";
    if (process.env["HIPPOCORTEX_SILENT"] !== "1") {
      console.warn(`[hippocortex] memory extraction failed (non-fatal): ${msg}`);
    }
    return [];
  }
}

// Export internals for testing
export {
  buildExtractionPrompt as _buildExtractionPrompt,
  parseExtractedFacts as _parseExtractedFacts,
  EXTRACTION_TIMEOUT_MS as _EXTRACTION_TIMEOUT_MS,
  OPENAI_EXTRACTION_MODEL as _OPENAI_EXTRACTION_MODEL,
  ANTHROPIC_EXTRACTION_MODEL as _ANTHROPIC_EXTRACTION_MODEL,
};
