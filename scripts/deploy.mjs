#!/usr/bin/env node
/**
 * Deploys the built server into the location GitHub Copilot loads it from
 * (~/.copilot/mcp-servers/atlassian/dist), keeping a timestamped backup of the
 * previous build so a bad deploy can be rolled back by hand.
 */
import { cp, mkdir, readdir, rename, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDist = join(projectRoot, "dist");
const targetRoot = join(homedir(), ".copilot", "mcp-servers", "atlassian");
const targetDist = join(targetRoot, "dist");

if (!existsSync(sourceDist)) {
  console.error(`No build found at ${sourceDist}. Run "npm run build" first.`);
  process.exit(1);
}

const entries = await readdir(sourceDist);
const jsFiles = entries.filter((name) => name.endsWith(".js"));
if (jsFiles.length === 0) {
  console.error(`Build at ${sourceDist} contains no .js files. Aborting.`);
  process.exit(1);
}

await mkdir(targetRoot, { recursive: true });

if (existsSync(targetDist)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(targetRoot, `dist.backup-${stamp}`);
  await rename(targetDist, backup);
  console.log(`Previous build moved to ${backup}`);
}

// Compiled tests live in dist/__tests__ but have no business running inside
// the deployed server.
await cp(sourceDist, targetDist, {
  recursive: true,
  filter: (source) => !source.includes("__tests__"),
});

// The server is launched directly by Copilot, so node_modules must resolve
// from the deployed location too.
const targetModules = join(targetRoot, "node_modules");
if (!existsSync(targetModules)) {
  await cp(join(projectRoot, "node_modules"), targetModules, { recursive: true });
  console.log("Copied node_modules into deploy target");
}

const deployedIndex = join(targetDist, "index.js");
const info = await stat(deployedIndex);
console.log(`Deployed ${jsFiles.length} files to ${targetDist}`);
console.log(`index.js: ${info.size} bytes`);
console.log("Restart the GitHub Copilot app to pick up the new build.");
