// @hippocortex/sdk — Type definitions

// ── Configuration ──

export interface HippocortexConfig {
  /** API key (hx_live_... or hx_test_...) */
  apiKey: string;
  /** Base URL (default: https://api.hippocortex.dev/v1) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Enable debug logging (logs requests, responses, latencies to console) */
  debug?: boolean;
  /** Suppress the one-time update warning when a newer SDK version is available */
  suppressUpdateWarning?: boolean;
}

// ── Capture ──

export type CaptureEventType =
  | "message"
  | "tool_call"
  | "tool_result"
  | "file_edit"
  | "test_run"
  | "command_exec"
  | "browser_action"
  | "api_result";

export interface CaptureEvent {
  type: CaptureEventType;
  sessionId: string;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface CaptureResult {
  eventId: string;
  status: "ingested" | "duplicate";
  salienceScore?: number;
  traceId?: string;
  reason?: string;
}

export interface BatchCaptureResult {
  results: CaptureResult[];
  summary: {
    total: number;
    ingested: number;
    duplicates: number;
    errors: number;
  };
}

// ── Learn ──

export type ArtifactType =
  | "task_schema"
  | "failure_playbook"
  | "causal_pattern"
  | "decision_policy";

export interface LearnOptions {
  /** Full recompilation or delta since last run */
  scope?: "full" | "incremental";
  /** Minimum pattern strength (0-1) */
  minPatternStrength?: number;
  /** Which artifact types to extract */
  artifactTypes?: ArtifactType[];
}

export interface LearnResult {
  runId: string;
  status: "completed" | "partial" | "failed";
  artifacts: {
    created: number;
    updated: number;
    unchanged: number;
    byType: Record<string, number>;
  };
  stats: {
    memoriesProcessed: number;
    patternsFound: number;
    compilationMs: number;
  };
}

// ── Synthesize ──

export type ReasoningSection =
  | "procedures"
  | "failures"
  | "decisions"
  | "facts"
  | "causal"
  | "context";

export interface SynthesizeOptions {
  /** Token budget for output (default: 4000) */
  maxTokens?: number;
  /** Which reasoning sections to include */
  sections?: ReasoningSection[];
  /** Minimum confidence threshold (default: 0.3) */
  minConfidence?: number;
  /** Attach source references (default: true) */
  includeProvenance?: boolean;
}

export interface ProvenanceRef {
  sourceType: string;
  sourceId: string;
  artifactType?: string;
  evidenceCount?: number;
}

export interface SynthesisEntry {
  section: ReasoningSection;
  content: string;
  confidence: number;
  provenance?: ProvenanceRef[];
}

export interface SynthesizeResult {
  packId: string;
  entries: SynthesisEntry[];
  budget: {
    limit: number;
    used: number;
    compressionRatio: number;
    entriesIncluded: number;
    entriesDropped: number;
  };
}

// ── Artifacts ──

export type ArtifactStatus = "active" | "deprecated" | "superseded";
export type ArtifactSortField = "createdAt" | "updatedAt" | "confidence" | "evidenceCount";

export interface ArtifactListOptions {
  type?: ArtifactType;
  status?: ArtifactStatus;
  sort?: ArtifactSortField;
  order?: "asc" | "desc";
  limit?: number;
  cursor?: string;
}

export interface Artifact {
  id: string;
  type: ArtifactType;
  status: ArtifactStatus;
  title: string;
  content: Record<string, unknown>;
  confidence: number;
  evidenceCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactListResult {
  artifacts: Artifact[];
  pagination: {
    hasMore: boolean;
    cursor?: string;
    total: number;
  };
}

// ── Metrics ──

export interface MetricsOptions {
  period?: "1h" | "24h" | "7d" | "30d";
  granularity?: "minute" | "hour" | "day";
}

export interface MetricsResult {
  period: {
    start: string;
    end: string;
    granularity: string;
  };
  usage: {
    events: {
      total: number;
      ingested: number;
      duplicates: number;
      errors: number;
      byType: Record<string, number>;
    };
    compilations: {
      total: number;
      artifactsCreated: number;
      artifactsUpdated: number;
    };
    syntheses: {
      total: number;
      avgTokensUsed: number;
      avgCompressionRatio: number;
    };
  };
  quota: {
    plan: string;
    eventsLimit: number;
    eventsUsed: number;
    eventsRemaining: number;
    resetDate: string;
  };
}

// ── Vault ──

export interface VaultQueryOptions {
  /** Filter by tags */
  tags?: string[];
  /** Filter by item type (e.g., "api_key", "password", "token") */
  itemType?: string;
  /** Maximum number of results (default: 20, max: 50) */
  limit?: number;
}

export interface VaultQueryMatch {
  id: string;
  vaultId: string;
  vaultName: string;
  title: string;
  itemType: string;
  serviceName: string | null;
  tags: string[];
  sensitivity: string;
  description: string | null;
  createdAt: string;
  relevance: number;
}

export interface VaultQueryResult {
  matches: VaultQueryMatch[];
  total: number;
  query: string;
}

export interface VaultRevealResult {
  value: string;
}

// ── Internal ──

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown[];
  };
  meta?: {
    requestId: string;
    tenantId: string;
    durationMs: number;
  };
}
