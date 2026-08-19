#!/usr/bin/env node
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { guardStdout } from "./stdout.js";
import { exists } from "../store/fs-util.js";

guardStdout();

const DEFAULT_STORE = ".dvdst/store";

function usage(status = 2): never {
  console.error("Usage: dvdst cleanup [--store <directory>] [--yes]");
  console.error("Removes a dvdst evidence store. Sources outside the store are never touched.");
  process.exit(status);
}

/**
 * Deletes an evidence store after confirming it is one. Requires the store
 * marker plus an explicit --yes so a typo cannot delete an unrelated directory.
 */
export async function cleanupStore(store: string, force: boolean): Promise<{ removed: boolean; store: string }> {
  const resolved = resolve(store);
  const marker = await exists(resolve(resolved, "store.json"));
  if (!marker) {
    throw new Error(`Refusing to remove ${resolved}: it does not contain a store.json marker. Pass [--store <dir>] for a dvdst store.`);
  }
  if (!force) {
    throw new Error(`Refusing to remove ${resolved}: pass --yes to confirm. The raw Pi sessions outside the store are never touched.`);
  }
  await rm(resolved, { recursive: true, force: true });
  return { removed: true, store: resolved };
}

async function main(): Promise<void> {
  // The dispatcher calls this script with: node --import tsx cleanup.ts cleanup [--store dir] [--yes]
  const stripped = process.argv[2] === "cleanup" ? process.argv.slice(3) : process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: stripped,
    options: {
      store: { type: "string", short: "s" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) usage(0);
  if (positionals.length > 0) usage();
  const result = await cleanupStore(values.store ?? DEFAULT_STORE, values.yes === true);
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: "cleanup", ...result })}\n`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
