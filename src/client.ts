// @hippocortex/sdk — Client implementation

import type {
  HippocortexConfig,
  CaptureEvent,
  CaptureResult,
  BatchCaptureResult,
  LearnOptions,
  LearnResult,
  SynthesizeOptions,
  SynthesizeResult,
  ArtifactListOptions,
  ArtifactListResult,
  Artifact,
  MetricsOptions,
  MetricsResult,
  VaultQueryOptions,
  VaultQueryResult,
  VaultRevealResult,
  ApiResponse,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.hippocortex.dev/v1";
const DEFAULT_TIMEOUT_MS = 30_000;

// Current SDK version — read from package.json at build time
const SDK_VERSION = "1.2.0";

// Module-level flag: only warn about updates ONCE per process
let _updateWarningEmitted = false;

/**
 * Compare two semver strings. Returns true if `latest` is newer than `current`.
 */
export function isNewerVersion(current: string, latest: string): boolean {
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [cMaj = 0, cMin = 0, cPat = 0] = parse(current);
  const [lMaj = 0, lMin = 0, lPat = 0] = parse(latest);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

/**
 * Reset the update warning flag. For testing only.
 * @internal
 */
export function _resetUpdateWarning(): void {
  _updateWarningEmitted = false;
}

export class HippocortexError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details?: unknown[];

  constructor(code: string, message: string, statusCode: number, details?: unknown[]) {
    super(message);
    this.name = "HippocortexError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class Hippocortex {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly debug: boolean;
  private readonly suppressUpdateWarning: boolean;

  /** The installed SDK version. */
  static readonly VERSION = SDK_VERSION;

  constructor(config: HippocortexConfig) {
    if (!config.apiKey) {
      throw new Error(
        "API key is required.\n" +
        "  → Get one at https://dashboard.hippocortex.dev\n" +
        "  → Or set HIPPOCORTEX_API_KEY environment variable\n" +
        "  → Usage: new Hippocortex({ apiKey: 'hx_...' })"
      );
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.debug = config.debug ?? false;
    this.suppressUpdateWarning = config.suppressUpdateWarning ?? false;
  }

  // ── Core Primitives ──

  /**
   * Capture an agent event into Hippocortex memory.
   *
   * @example
   * ```typescript
   * await hx.capture({
   *   type: 'message',
   *   sessionId: 'sess-42',
   *   payload: { role: 'user', content: 'Deploy to staging' }
   * });
   * ```
   */
  async capture(event: CaptureEvent): Promise<CaptureResult> {
    return this.post<CaptureResult>("/capture", event);
  }

  /**
   * Capture multiple events in a single request.
   */
  async captureBatch(events: CaptureEvent[]): Promise<BatchCaptureResult> {
    return this.post<BatchCaptureResult>("/capture/batch", { events });
  }

  /**
   * Trigger the Memory Compiler to learn from accumulated experience.
   *
   * @example
   * ```typescript
   * const result = await hx.learn();
   * console.log(`Created ${result.artifacts.created} new artifacts`);
   * ```
   */
  async learn(options?: LearnOptions): Promise<LearnResult> {
    return this.post<LearnResult>("/learn", {
      scope: options?.scope ?? "incremental",
      options: {
        minPatternStrength: options?.minPatternStrength,
        artifactTypes: options?.artifactTypes,
      },
    });
  }

  /**
   * Synthesize compressed context from all memory layers for a query.
   *
   * @example
   * ```typescript
   * const ctx = await hx.synthesize('deploy payment service');
   * // Use ctx.entries in your LLM prompt
   * ```
   */
  async synthesize(query: string, options?: SynthesizeOptions): Promise<SynthesizeResult> {
    return this.post<SynthesizeResult>("/synthesize", { query, options });
  }

  // ── Artifacts & Metrics ──

  /** List compiled knowledge artifacts with filtering and pagination. */
  async listArtifacts(options?: ArtifactListOptions): Promise<ArtifactListResult> {
    const params = new URLSearchParams();
    if (options?.type) params.set("type", options.type);
    if (options?.status) params.set("status", options.status);
    if (options?.sort) params.set("sort", options.sort);
    if (options?.order) params.set("order", options.order);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.cursor) params.set("cursor", options.cursor);
    const qs = params.toString();
    return this.get<ArtifactListResult>(`/artifacts${qs ? `?${qs}` : ""}`);
  }

  /** Get a single compiled artifact by ID. */
  async getArtifact(id: string): Promise<Artifact> {
    return this.get<Artifact>(`/artifacts/${encodeURIComponent(id)}`);
  }

  // ── Vault ──

  /**
   * Search the vault for secrets by natural language query.
   * Returns metadata only (titles, types, tags) — never decrypted values.
   *
   * @example
   * ```typescript
   * const results = await hx.vaultQuery('stripe api key');
   * for (const match of results.matches) {
   *   console.log(`${match.title} (${match.itemType}) — relevance: ${match.relevance}`);
   * }
   * ```
   */
  async vaultQuery(query: string, options?: VaultQueryOptions): Promise<VaultQueryResult> {
    const body: Record<string, unknown> = { query };
    if (options?.tags) body.tags = options.tags;
    if (options?.itemType) body.itemType = options.itemType;
    if (options?.limit) body.limit = options.limit;
    return this.post<VaultQueryResult>("/vault/query", body);
  }

  /**
   * Reveal (decrypt) a specific vault secret by item ID.
   * Requires reveal permission. All access is audited and rate-limited.
   *
   * @example
   * ```typescript
   * const secret = await hx.vaultReveal('item-abc123');
   * console.log(secret.value); // the decrypted secret
   * ```
   */
  async vaultReveal(itemId: string): Promise<VaultRevealResult> {
    return this.post<VaultRevealResult>(`/vault/query/${encodeURIComponent(itemId)}/reveal`, {});
  }

  /** Get usage and performance metrics. */
  async getMetrics(options?: MetricsOptions): Promise<MetricsResult> {
    const params = new URLSearchParams();
    if (options?.period) params.set("period", options.period);
    if (options?.granularity) params.set("granularity", options.granularity);
    const qs = params.toString();
    return this.get<MetricsResult>(`/usage-metrics${qs ? `?${qs}` : ""}`);
  }

  // ── HTTP Layer ──

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startMs = Date.now();

    if (this.debug) {
      console.log(`[hippocortex] ${method} ${url}${body ? ` (${JSON.stringify(body).length} bytes)` : ""}`);
    }

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Client": "hippocortex-js-sdk",
        "X-Hippocortex-SDK-Version": `js/${SDK_VERSION}`,
      };

      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }

      const res = await fetch(url, init);

      if (this.debug) {
        const durationMs = Date.now() - startMs;
        console.log(`[hippocortex] ${res.status} ${method} ${path} (${durationMs}ms)`);
      }

      // Check for SDK update (once per process)
      if (!_updateWarningEmitted && !this.suppressUpdateWarning) {
        const latestSdkJs = res.headers.get("X-Hippocortex-Latest-SDK-JS");
        if (latestSdkJs && isNewerVersion(SDK_VERSION, latestSdkJs)) {
          _updateWarningEmitted = true;
          console.warn(
            `⚠️ @hippocortex/sdk v${SDK_VERSION} is outdated. Latest: v${latestSdkJs}\n` +
            `  Update: npm install @hippocortex/sdk@latest`,
          );
        }
      }

      const json = (await res.json()) as ApiResponse<T>;

      if (!json.ok || json.error) {
        const errCode = json.error?.code ?? "unknown_error";
        const errMsg = json.error?.message ?? `HTTP ${res.status}`;

        // Provide actionable error messages for common issues
        let hint = "";
        if (res.status === 401) {
          hint = "\n  → Check your API key is valid and not expired";
        } else if (res.status === 403) {
          hint = "\n  → Your plan may not include this feature";
        } else if (res.status === 429) {
          hint = "\n  → Rate limit exceeded. Wait and retry, or upgrade your plan";
        } else if (res.status === 503) {
          hint = "\n  → Service temporarily unavailable. Retry after a few seconds";
        }

        throw new HippocortexError(
          errCode,
          `${errMsg}${hint}`,
          res.status,
          json.error?.details,
        );
      }

      return json.data as T;
    } catch (err) {
      // Handle network/timeout errors with friendly messages
      if (err instanceof HippocortexError) throw err;

      if (err instanceof DOMException && err.name === "AbortError") {
        throw new HippocortexError(
          "timeout",
          `Request timed out after ${this.timeoutMs}ms. Consider increasing timeoutMs.`,
          0,
        );
      }

      // Network error
      const msg = err instanceof Error ? err.message : String(err);
      throw new HippocortexError(
        "network_error",
        `Failed to connect to ${this.baseUrl}: ${msg}\n  → Check your network and baseUrl configuration`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  private post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }
}
