#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { guardStdout } from "./stdout.js";
import { collectStageFromSession, stageChanges } from "../stage/stage.js";

guardStdout();
const cancellation = new AbortController();
const cancel = () => cancellation.abort(new Error("staging interrupted"));
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);

async function findTranscript(root: string, agent: string, session: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(session)) throw new Error("invalid session identity");
  const matches: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && (agent === "claude" ? entry.name === `${session}.jsonl` : entry.name.startsWith("rollout-") && entry.name.endsWith(`-${session}.jsonl`))) matches.push(path);
    }
  }
  await visit(root);
  if (matches.length !== 1) throw new Error(`expected one ${agent} transcript for session ${session} under ${root}, found ${matches.length}; pass --session-file explicitly`);
  return matches[0]!;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv[2] === "session-stage" ? process.argv.slice(3) : process.argv.slice(2),
    options: {
      agent: { type: "string" }, session: { type: "string" }, "session-file": { type: "string" },
      repository: { type: "string" }, manifest: { type: "string" }, after: { type: "string" },
      "dry-run": { type: "boolean" }, list: { type: "boolean" }, help: { type: "boolean", short: "h" },
    }, strict: true,
  });
  if (values.help) {
    console.log("Usage: dvdst session-stage --agent claude|codex [--session <id> | --session-file <file>] [--repository <dir>] [--manifest <file>] [--after <result-event-id>] [--dry-run | --list]");
    return;
  }
  const agent = values.agent;
  if (agent !== "claude" && agent !== "codex") throw new Error("--agent must be claude or codex");
  if (values.list && (values.manifest || values["dry-run"])) throw new Error("--list cannot be combined with --manifest or --dry-run");
  if (values.manifest && (values["session-file"] || values.after)) throw new Error("--manifest cannot be combined with --session-file or --after");
  let session = values.session ?? (values["session-file"] ? undefined : agent === "claude" ? process.env.CLAUDE_CODE_SESSION_ID : process.env.CODEX_THREAD_ID);
  let file: string | undefined;
  if (!values.manifest) {
    if (values["session-file"]) file = resolve(values["session-file"]);
    else {
      if (!session) throw new Error("session identity is unavailable; pass --session-file or --session explicitly");
      const root = agent === "claude"
        ? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects")
        : join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
      file = await findTranscript(root, agent, session);
    }
    const text = await readFile(file, "utf8");
    const raw = text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as Record<string, unknown>);
    const actualAgent = raw.some(entry => entry.type === "session_meta") ? "codex" : raw.some(entry => typeof entry.sessionId === "string") ? "claude" : "pi";
    if (actualAgent !== agent) throw new Error("transcript agent does not match --agent");
    const collected = collectStageFromSession(text);
    if (session && session !== collected.sessionId) throw new Error("transcript session identity does not match --session");
    session = collected.sessionId;
    if (values.list) {
      let patches = collected.patches;
      if (values.after) {
        const cursor = patches.map(patch => patch.resultEventId).lastIndexOf(values.after);
        if (cursor === -1) throw new Error("unknown --after mutation result");
        patches = patches.slice(cursor + 1);
      }
      for (const patch of patches) console.log(JSON.stringify({ sessionId: session, resultEventId: patch.resultEventId, operation: patch.operation, path: patch.path }));
      return;
    }
  }
  if (!session) throw new Error("manifest requires an explicit or environment-provided caller session identity");
  const report = await stageChanges({
    ...(values.manifest ? { manifest: resolve(values.manifest) } : { sessionFile: file! }),
    ...(values.after === undefined ? {} : { after: values.after }),
    cwd: resolve(values.repository ?? "."), session, dryRun: values["dry-run"] === true, signal: cancellation.signal,
  });
  console.log(JSON.stringify(report));
  if (report.conflicts.length) {
    console.error(["Staging blocked. The index was not changed. Do not commit this report.", ...report.conflicts.slice(0, 8).map(issue => `${issue.path}: ${issue.reason}`)].join("\n"));
    process.exitCode = 1;
  } else {
    const action = report.dryRun ? `Dry run: ${report.staged.length} file(s) would be staged` : report.staged.length ? `Staged ${report.staged.length} file(s)` : "No new changes staged";
    console.error(`${action}. ${report.unchanged.length} unchanged.${report.excluded.length ? ` ${report.excluded.length} outside paths skipped.` : ""}${report.selection?.omitted?.length ? ` Review ${report.selection.omitted.length} intentionally omitted file mutation(s).` : ""}${report.unattributedBashCount ? ` Inspect ${report.unattributedBashCount} possible bash mutation(s) before committing.` : ""}`);
  }
}

try { await main(); }
catch (error) { console.error(`Could not stage: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
