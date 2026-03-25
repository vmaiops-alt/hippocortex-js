// @hippocortex/sdk -- Zero-config: load .hippocortex.json

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";

export interface HippocortexFileConfig {
  apiKey: string;
  baseUrl?: string;
}

/**
 * Search for `.hippocortex.json` starting from `cwd` and walking up to the
 * filesystem root. Returns the parsed config or `null` if nothing is found.
 */
export function loadConfig(cwd?: string): HippocortexFileConfig | null {
  let dir = cwd ?? process.cwd();

  // Walk upward (max 64 levels to avoid infinite loops on weird fs)
  for (let i = 0; i < 64; i++) {
    try {
      const filePath = join(dir, ".hippocortex.json");
      const raw = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.apiKey === "string" && parsed.apiKey) {
        return {
          apiKey: parsed.apiKey,
          baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
        };
      }
    } catch {
      // File does not exist or is invalid, keep walking
    }

    const parent = dirname(dir);
    if (parent === dir) break; // reached root
    dir = parent;
  }

  return null;
}

/**
 * Resolve API key and base URL from (in priority order):
 * 1. Explicit options
 * 2. Environment variables (HIPPOCORTEX_API_KEY, HIPPOCORTEX_BASE_URL)
 * 3. `.hippocortex.json` file (cwd and parent dirs)
 */
export function resolveConfig(options?: {
  apiKey?: string;
  baseUrl?: string;
}): HippocortexFileConfig | null {
  const apiKey =
    options?.apiKey ||
    process.env["HIPPOCORTEX_API_KEY"] ||
    undefined;

  const baseUrl =
    options?.baseUrl ||
    process.env["HIPPOCORTEX_BASE_URL"] ||
    undefined;

  if (apiKey) {
    return { apiKey, baseUrl };
  }

  // Try file-based config
  const fileConfig = loadConfig();
  if (fileConfig) {
    return {
      apiKey: fileConfig.apiKey,
      baseUrl: baseUrl || fileConfig.baseUrl,
    };
  }

  return null;
}
