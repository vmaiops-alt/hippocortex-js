// @hippocortex/sdk -- postinstall hint
// Prints a friendly setup reminder after npm install.
// Does NOT run interactive prompts (npm best practice).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { env, stdout } from "node:process";

function main(): void {
  // Skip in CI
  if (env["CI"] === "true") return;

  // Skip if not a TTY
  if (!stdout.isTTY) return;

  // Skip if API key already configured
  if (env["HIPPOCORTEX_API_KEY"]) return;

  // Skip if config file exists in cwd
  if (existsSync(join(process.cwd(), ".hippocortex.json"))) return;

  console.log("");
  console.log("  [hippocortex] To enable auto-memory, set HIPPOCORTEX_API_KEY or run:");
  console.log("    npx hippocortex init");
  console.log("");
}

main();
