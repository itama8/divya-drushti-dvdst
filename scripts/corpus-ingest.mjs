#!/usr/bin/env node
/**
 * Read-only corpus ingestion for CP6.
 *
 * Discovers Pi sessions under a root, ingests every one into the evidence
 * store without writing to the sources, and writes an aggregate report.
 * Run it once to ingest, then again to confirm a repeat run performs no
 * writes (every session reports "unchanged").
 *
 * Usage:
 *   node --import tsx scripts/corpus-ingest.mjs <session-root> \
 *     --store <dir> [--report <path>] [--limit N]
 *
 * Measure wall time and peak memory externally, for example:
 *   /usr/bin/time -v node --import tsx scripts/corpus-ingest.mjs ... 
 */
import { readFile, stat, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSessions } from "../src/pi/sessions.js";
import { ingestSessionFile } from "../src/store/ingest-session.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function parseArgs() {
  const positionals = [];
  const options = {};
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        const value = arg.slice(eq + 1);
        options[key] = value;
      } else {
        const next = process.argv[process.argv.indexOf(arg) + 1];
        if (next !== undefined && !next.startsWith("--")) {
          options[arg.slice(2)] = next;
        } else {
          options[arg.slice(2)] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options };
}

const { positionals, options } = parseArgs();
const sessionRoot = positionals[0];
if (!sessionRoot) {
  console.error("Usage: node --import tsx scripts/corpus-ingest.mjs <session-root> --store <dir> [--report <path>] [--limit N]");
  process.exit(2);
}
// Keep the store out of the corpus by default; a persistent --store lets a
// repeat run verify that unchanged sessions perform no writes.
const store = options.store && options.store !== true ? resolve(options.store) : resolve(root, ".dvdst", "store-corpus");
const reportPath = options.report && options.report !== true ? resolve(options.report) : resolve(root, "docs/corpus-report.json");
const limit = options.limit && options.limit !== true ? Number.parseInt(options.limit, 10) : undefined;

const started = Date.now();
const sourceFiles = await discoverSessions([sessionRoot]);
const selected = limit ? sourceFiles.slice(0, limit) : sourceFiles;

/** Sample source hashes before ingestion; verify they are unchanged after. */
const sampleCount = Math.min(20, selected.length);
const preHashes = [];
for (let index = 0; index < sampleCount; index += 1) {
  const file = selected[index];
  if (file === undefined) break;
  const data = await readFile(file.path);
  preHashes.push({ path: file.path, sha256: createHash("sha256").update(data).digest("hex") });
}

const byStatus = new Map();
const byManifestStatus = new Map();
const byChangeClass = new Map();
const diagnosticsByType = new Map();
const diagnosticCategories = {
  "invalid-json": "invalid JSON",
  "not-an-object": "line must be a JSON object",
  "header-version-type": "session version must be a number",
  "header-cwd-type": "session cwd must be a string",
  "header-timestamp-type": "session timestamp must be a string",
};
const diagnosticsTotal = { count: 0, categories: Object.fromEntries(Object.keys(diagnosticCategories).map((key) => [key, 0])) };
const entryTypeCounts = new Map();
const perSession = [];
const failed = [];

for (const file of selected) {
  try {
    const result = await ingestSessionFile(file.path, store);
    byStatus.set(result.status, (byStatus.get(result.status) ?? 0) + 1);
    byManifestStatus.set(String(result.manifestStatus), (byManifestStatus.get(String(result.manifestStatus)) ?? 0) + 1);
    byChangeClass.set(result.change.class, (byChangeClass.get(result.change.class) ?? 0) + 1);
    // Diagnostics and per-type counts live on the manifest.
    const snapshotDir = result.snapshot;
    const manifest = JSON.parse(await readFile(join(snapshotDir, "manifest.json"), "utf8"));
    diagnosticsTotal.count += manifest.counts?.diagnostics ?? 0;
    for (const diagnostic of manifest.diagnostics ?? []) {
      const message = String(diagnostic.message ?? "");
      let category = "unknown";
      for (const [key, prefix] of Object.entries(diagnosticCategories)) {
        if (message.startsWith(prefix)) {
          category = key;
          break;
        }
      }
      diagnosticsTotal.categories[category] = (diagnosticsTotal.categories[category] ?? 0) + 1;
      if (!diagnosticsByType.has(category)) diagnosticsByType.set(category, []);
      diagnosticsByType.get(category).push({ file: file.path, line: diagnostic.line });
    }
    for (const [type, count] of Object.entries(manifest.counts?.byType ?? {})) {
      entryTypeCounts.set(type, (entryTypeCounts.get(type) ?? 0) + (typeof count === "number" ? count : 0));
    }
    perSession.push({
      sessionId: result.sessionId,
      source: file.path,
      status: result.status,
      manifestStatus: String(result.manifestStatus),
      change: result.change.class,
      bytes: result.bytes,
      lines: result.lines,
      snapshot: result.snapshot,
    });
  } catch (error) {
    failed.push({ source: file.path, error: error instanceof Error ? error.message : String(error) });
    byStatus.set("failed", (byStatus.get("failed") ?? 0) + 1);
  }
}

// Verify sources are unchanged (read-only guarantee) on the hashed sample.
for (const sample of preHashes) {
  const data = await readFile(sample.path);
  const hash = createHash("sha256").update(data).digest("hex");
  if (hash !== sample.sha256) failed.push({ source: sample.path, error: "source file changed during ingestion" });
}

// Store size on disk and deduplication ratio.
let storeBytes = 0;
try {
  const entries = await readdir(store, { recursive: true });
  for (const entry of entries) {
    if (typeof entry !== "string") continue;
    const path = join(store, entry);
    try {
      const info = await stat(path);
      if (info.isFile()) storeBytes += info.size;
    } catch {
      // ignore raced deletes and permission failures
    }
  }
} catch {
  storeBytes = 0;
}

const elapsedMs = Date.now() - started;
const sourceTotalBytes = selected.reduce((sum, file) => sum + file.bytes, 0);
const report = {
  schemaVersion: 1,
  kind: "corpus-ingestion",
  root: sessionRoot,
  store,
  runtimeMs: elapsedMs,
  peakRssKb: process.resourceUsage().maxRSS,
  discovered: sourceFiles.length,
  ingested: perSession.length,
  failed: failed.length,
  byStatus: Object.fromEntries(byStatus),
  byManifestStatus: Object.fromEntries(byManifestStatus),
  byChangeClass: Object.fromEntries(byChangeClass),
  entryTypeCounts: Object.fromEntries([...entryTypeCounts.entries()].sort((left, right) => right[1] - left[1])),
  diagnostics: {
    total: diagnosticsTotal.count,
    categories: diagnosticsTotal.categories,
  },
  sourcesChanged: preHashes.length > 0 && failed.some((entry) => String(entry.error).includes("changed during")),
  sizes: {
    sourceTotalBytes,
    storeBytes,
    dedupRatio: storeBytes > 0 ? Number((sourceTotalBytes / storeBytes).toFixed(3)) : 0,
  },
  failures: failed,
  perSession,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(JSON.stringify({
  schemaVersion: 1,
  root: sessionRoot,
  discovered: report.discovered,
  ingested: report.ingested,
  failed: report.failed,
  runtimeMs: report.runtimeMs,
  byStatus: report.byStatus,
  byManifestStatus: report.byManifestStatus,
  byChangeClass: report.byChangeClass,
  peakRssKb: report.peakRssKb,
  diagnosticsTotal: report.diagnostics.total,
  diagnosticCategories: report.diagnostics.categories,
  sourceTotalBytes: report.sizes.sourceTotalBytes,
  storeBytes: report.sizes.storeBytes,
  report: reportPath,
}, null, 2));
