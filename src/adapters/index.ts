/**
 * @hippocortex/sdk/adapters — Auto-memory adapters for agent frameworks.
 */

export { HippocortexAdapter, buildContextText } from "./base.js";
export type { AdapterConfig, Message } from "./base.js";

export { OpenClawMemory, autoMemory } from "./openclaw.js";
export type { OpenClawAdapterConfig } from "./openclaw.js";
