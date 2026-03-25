// @hippocortex/sdk — Entry point

export { Hippocortex, HippocortexError, isNewerVersion, _resetUpdateWarning } from "./client.js";
export { wrap } from "./wrap.js";
export { extractMemories } from "./extract.js";
export { loadConfig, resolveConfig } from "./config.js";
export type { WrapOptions } from "./wrap.js";
export type { HippocortexFileConfig } from "./config.js";

export type {
  HippocortexConfig,
  CaptureEvent,
  CaptureEventType,
  CaptureResult,
  BatchCaptureResult,
  LearnOptions,
  LearnResult,
  ArtifactType,
  SynthesizeOptions,
  SynthesizeResult,
  SynthesisEntry,
  ReasoningSection,
  ProvenanceRef,
  ArtifactListOptions,
  ArtifactListResult,
  Artifact,
  ArtifactStatus,
  ArtifactSortField,
  MetricsOptions,
  MetricsResult,
  VaultQueryOptions,
  VaultQueryMatch,
  VaultQueryResult,
  VaultRevealResult,
} from "./types.js";
