#!/usr/bin/env node
import { CLI_OPTIONS, parserOptions } from "./command-options.js";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { guardStdout } from "./stdout.js";
import { sessionIdFromFilename } from "../pi/sessions.js";
import { detectSource } from "../sources/read-session.js";
import { collectStageFromFile, inspectBash, stageChanges } from "../stage/stage.js";

guardStdout();
const cancellation = new AbortController();
const cancel = () => cancellation.abort(new Error("staging interrupted"));
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);

function transcriptName(agent: string, name: string, session: string): boolean {
  if (agent === "claude") return name === `${session}.jsonl`;
  if (agent === "pi") return sessionIdFromFilename(name) === session;
  return name.startsWith("rollout-") && name.endsWith(`-${session}.jsonl`);
}

// Pi's own storage roots: PI_CODING_AGENT_SESSION_DIR, else PI_CODING_AGENT_DIR/sessions.
// A --session-dir flag or settings-file location is only visible through PI_SESSION_FILE.
function transcriptRoot(agent: string): string {
  if (agent === "claude") return join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "projects");
  if (agent === "codex") return join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions");
  return process.env.PI_CODING_AGENT_SESSION_DIR ?? join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
}

function environmentSession(agent: string): string | undefined {
  return agent === "claude" ? process.env.CLAUDE_CODE_SESSION_ID : agent === "codex" ? process.env.CODEX_THREAD_ID : process.env.PI_SESSION_ID;
}

const BASH_NOTE = "bash edits are never attributed, listed, or staged";

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
      else if (entry.isFile() && transcriptName(agent, entry.name, session)) matches.push(path);
    }
  }
  await visit(root);
  if (matches.length !== 1) throw new Error(`expected one ${agent} transcript for session ${session} under ${root}, found ${matches.length}; pass --session-file explicitly`);
  return matches[0]!;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv[2] === "session-stage" ? process.argv.slice(3) : process.argv.slice(2),
    options: parserOptions(CLI_OPTIONS.sessionStage), strict: true,
  });
  if (values.help) {
    console.error("Usage: dvdst session-stage --agent pi|claude|codex [--session <id> | --session-file <file>] [--repository <dir>] [--manifest <file>] [--after <result-event-id>] [--dry-run | --list]");
    console.error("Discovery without --session-file: Pi uses PI_SESSION_FILE, else PI_SESSION_ID; Claude uses CLAUDE_CODE_SESSION_ID; Codex uses CODEX_THREAD_ID. Bash edits are never attributed or staged. Never commits.");
    return;
  }
  const agent = values.agent;
  if (agent !== "pi" && agent !== "claude" && agent !== "codex") throw new Error("--agent must be pi, claude, or codex");
  if (values.list && (values.manifest || values["dry-run"])) throw new Error("--list cannot be combined with --manifest or --dry-run");
  if (values.manifest && (values["session-file"] || values.after)) throw new Error("--manifest cannot be combined with --session-file or --after");
  let session = values.session ?? (values["session-file"] ? undefined : environmentSession(agent));
  let file: string | undefined;
  if (!values.manifest) {
    if (values["session-file"]) file = resolve(values["session-file"]);
    // Pi exports the exact current transcript to its bash tool. An explicit
    // --session still names its own transcript, and PI_SESSION_ID must agree.
    else if (agent === "pi" && values.session === undefined && process.env.PI_SESSION_FILE) file = resolve(process.env.PI_SESSION_FILE);
    else {
      if (!session) throw new Error("session identity is unavailable; pass --session-file or --session explicitly");
      file = await findTranscript(transcriptRoot(agent), agent, session);
    }
    const text = await readFile(file, "utf8");
    const raw = text.split("\n").filter(line => line.trim()).map((line, index) => ({ value: JSON.parse(line) as unknown, source: { line: index + 1, byteStart: 0, byteEnd: 0 } }));
    const actualAgent = detectSource(raw);
    if (actualAgent !== agent) throw new Error(`transcript is a ${actualAgent} session, not --agent ${agent}`);
    const collected = await collectStageFromFile(file);
    if (session && session !== collected.sessionId) throw new Error("transcript session identity does not match the requested session (--session or the agent environment)");
    session = collected.sessionId;
    if (values.list) {
      const suspicious = inspectBash(collected.bash).length;
      if (suspicious) console.error(`${suspicious} successful bash command(s) look file-mutating; ${BASH_NOTE}. Inspect them before selecting or committing scope.`);
      const unsupported = collected.bash.filter(call => call.unsupportedPatch);
      if (unsupported.length) console.error(`Incomplete mutation coverage: ${unsupported.length} exec cell(s) contain unsupported apply_patch syntax. Review these calls before selecting or committing scope.`);
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
    console.error(`${action}. ${report.unchanged.length} unchanged.${report.excluded.length ? ` ${report.excluded.length} outside paths skipped.` : ""}${report.selection?.omitted?.length ? ` Review ${report.selection.omitted.length} intentionally omitted file mutation(s).` : ""}${report.unattributedBashCount ? ` Inspect ${report.unattributedBashCount} possible bash mutation(s) before committing; ${BASH_NOTE}.` : ""}`);
  }
}

try { await main(); }
catch (error) { console.error(`Could not stage: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 2; }
finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
