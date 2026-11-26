// Deterministic confidence for the mutation claims dvdst makes about a tool call.
//
//   dvdst rows examples/extractors/claim-confidence.mjs <session.jsonl>
//   dvdst claim-confidence --project omakase-v2 --source all --last 50   (after copying to .dvdst/extractors/)
//
// One row per mutation claim or per named unknown. A "mutation" row says the
// call changed `target`. An "unknown" row says dvdst cannot name the files the
// call may have changed, and carries the text hints and the checks that would
// resolve it. A "session-coverage" row summarizes how complete the claim set is.
//
// The rubric is a band, not a probability. Each band has a fixed meaning and
// the checks that produced it are printed in `checks`.
//
//   verified     1.00  declared source, succeeded, result names the path
//   declared     0.90  declared source, succeeded, no independent naming
//   inferred     0.55  shell text names a static path, call succeeded
//   partial      0.35  shell text names a path, call failed without a write error on it
//   weak         0.30  claim rests on non-operator text, or outcome unfinished
//   contradicted 0.10  failed declared tool, other path, write error on this path
//   unknown      null  no path claim at all
//
// A band is deterministic input to another agent, not a statistical estimate.

import { readFileSync } from "node:fs";
import { isAbsolute, normalize, relative, resolve } from "node:path";

const SHELL_TOOLS = new Set(["bash"]);

const WRITE_API = /\b(?:write_text|write_bytes|writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|copyFileSync|copyFile|renameSync|rename|unlinkSync|unlink|removeSync|rmSync|rmtree|mkdirSync|mkdir)\b|open\s*\([^)]*,\s*['"][wa]/;
const WRITE_VERB = /\b(?:cat|tee|dd|truncate)\s*>|\bsed\s+(?:-[a-zA-Z]*i\b|--in-place)|(?:^|[|;&]\s*)(?:rm|mv|cp|install)\s|\bgit\s+(?:apply|am|checkout|restore|reset|stash|clean|revert)\b|\bpatch\s+-p|\bapply_patch\s*\(/;
const SHELL_TARGET = /\b(?:cat|tee)\s*>>?\s*([^\s'"'|;&]+)|\bsed\s+-[a-zA-Z]*i[^\n]*?\s([^\s'"'|;&-][^\s'"'|;&]*)/g;
const WRITE_ERROR = /permission denied|read-only file system|no such file or directory|is a directory|no space left|unexpected EOF|syntax error|not found|cannot create|failed to (?:create|write|open)/i;
const INTERPRETER = /\b(?:python3?|node|perl|ruby|tsx|bun|deno)\b[^\n]*(?:<<|-[ec]\b|--input-type)/;
const PATH_HINT = /['"]((?:\.{0,2}\/)?[\w@%+.-]+(?:\/[\w@%+.-]+)*\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx|css|html|json|jsonl|md|py|sh|bash|yml|yaml|toml|sql|ipynb))['"]/g;

function text(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((part) => part && typeof part === "object" && typeof part.text === "string").map((part) => part.text).join("\n");
  }
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

function resolvePath(cwd, value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const base = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
  return isAbsolute(value) ? normalize(value) : resolve(base, value);
}

function within(cwd, path) {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const rel = relative(cwd, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function resultNamesPath(resultText, path, cwd) {
  if (!resultText) return false;
  const forms = new Set([path]);
  if (typeof cwd === "string" && cwd.length > 0) forms.add(relative(cwd, path));
  const base = path.split("/").pop() ?? path;
  // Require a full path, or the basename as a standalone token.
  return [...forms].some((form) => resultText.includes(form))
    || new RegExp(`(?:^|[\\s'"(\\[/])${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[\\s'",:)\\]\\.])`).test(resultText);
}

function pathConflict(resultText, path) {
  if (!resultText) return null;
  // Only trust result text that explicitly names a written file.
  const named = /^(?:The file|File created successfully at:)\s+(\/\S+)/.exec(resultText.trim());
  if (named === null) return null;
  const echoed = named[1];
  return echoed === path ? "match" : "differ";
}

function writeErrorFor(resultText, path) {
  if (!resultText) return false;
  const base = path.split("/").pop() ?? path;
  return resultText.split("\n").some((line) => WRITE_ERROR.test(line) && line.includes(base));
}

function applyPatchOperations(patch) {
  const operations = [];
  if (typeof patch !== "string") return operations;
  for (const match of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    operations.push({ kind: match[1].toLowerCase(), path: match[2].trim() });
  }
  for (const match of patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) {
    operations.push({ kind: "move", path: match[1].trim() });
  }
  return operations;
}

function patchHasEmptyHunk(patch) {
  if (typeof patch !== "string") return false;
  for (const block of patch.split(/^\*\*\* (?:Add|Update|Delete) File: .+$/m).slice(1)) {
    for (const hunk of block.split(/^@@.*$/m).slice(1)) {
      const lines = hunk.split("\n").filter((line) => line.length > 0 && line !== "*** End of File");
      if (lines.length > 0 && lines.every((line) => line.startsWith("+"))) return true;
    }
  }
  return false;
}

function hintsFromScript(script, cwd) {
  const found = new Map();
  const add = (value) => {
    if (!value || /\$|^-|^https?:/.test(value) || value.startsWith("node_modules/")) return;
    const absolute = resolvePath(cwd, value);
    if (absolute !== null) found.set(absolute, absolute);
  };
  // Shell targets are write intent even without an interpreter API.
  for (const match of script.matchAll(SHELL_TARGET)) add(match[1]);
  if (!WRITE_API.test(script)) return [...found.values()].slice(0, 12);
  // Path literals bound to a variable that a write API uses.
  const bindings = new Map();
  for (const match of script.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*(?:Path\()?['"]([^'"\n]+)['"]/g)) {
    bindings.set(match[1], match[2]);
  }
  for (const [name, value] of bindings) {
    const used = new RegExp(`(?:open|write_text|write_bytes|writeFile\w*|appendFile\w*|createWriteStream|copyFile\w*|rename\w*|unlink\w*|rm\w*|mkdir\w*|json\\.dump)\\s*\\([^)]*\\b${name.replace(/[$]/g, "\\$")}\\b|\\b${name.replace(/[$]/g, "\\$")}\\.write(?:ln|File\w*)?\\s*\\(`).test(script);
    if (used) add(value);
  }
  // Literals directly inside a write call.
  for (const match of script.matchAll(/(?:write_text|write_bytes|writeFile\w*|appendFile\w*|createWriteStream)\s*\(\s*['"]([^'"\n]+)['"]/g)) {
    add(match[1]);
  }
  for (const match of script.matchAll(/open\s*\(\s*['"]([^'"\n]+)['"]\s*,\s*['"][wa]/g)) add(match[1]);
  return [...found.values()].slice(0, 12);
}

function lineOf(call) {
  return typeof call.line === "number" ? call.line : null;
}

function refOf(call) {
  return typeof call.ref === "string" ? call.ref : null;
}

function unknownReason(reason) {
  if (/inline .*script/i.test(reason)) return "inline-interpreter";
  if (/git apply|patch/i.test(reason)) return "git-apply";
  if (/computed path/i.test(reason)) return "computed-path";
  if (/xargs|find runs/i.test(reason)) return "xargs-or-find-exec";
  return "opaque-command";
}

function sessionRow(session, counts) {
  const unknowns = counts.unknownLikely + counts.unknownPossible;
  const unknownInside = counts.unknownInside;
  let band = "complete";
  let confidence = 1;
  let explanation = "Every mutation claim names a path, and no call is left without a parse.";
  if (counts.sidechain > 0) {
    band = "partial";
    confidence = 0.5;
    explanation = `${counts.sidechain} Claude sidechain/subagent entries are excluded from this claim set; they can contain edits.`;
  } else if (unknowns > 0) {
    if (counts.unknownLikely > 0 && counts.unknownHints === 0 && (counts.unknownInside > 0 || counts.unknownNoHint > 0)) {
      band = "unknown";
      confidence = 0.2;
      explanation = `${counts.unknownLikely} write-capable call(s) name no usable path; the change set may be incomplete.`;
    } else if (counts.unknownInside > 0) {
      band = "partial";
      confidence = 0.5;
      explanation = `${counts.unknownInside} write-capable call(s) inside the session cwd are not attributed; inspect their hints and refs.`;
    } else {
      band = "near-complete";
      confidence = 0.75;
      explanation = `${unknowns} unattributed call(s), but none names a write target inside the session cwd.`;
    }
  } else if (counts.contradicted > 0) {
    band = "partial";
    confidence = 0.8;
    explanation = `${counts.contradicted} mutation claim(s) are contradicted by the recorded result and must not be used as change evidence.`;
  }
  return {
    session: session.session,
    source: session.source,
    path: session.path,
    claim: "session-coverage",
    tool: null,
    seq: null,
    line: null,
    target: null,
    confidence,
    band,
    attribution: null,
    outcome: null,
    stageability: null,
    reason: null,
    risk: null,
    checks: [
      `mutationClaims=${counts.mutation}`,
      `verified=${counts.verified}`,
      `declared=${counts.declared}`,
      `inferred=${counts.inferred}`,
      `partial=${counts.partial}`,
      `weak=${counts.weak}`,
      `contradicted=${counts.contradicted}`,
      `unknownCalls=${counts.unknown}`,
      `unknownLikelyWrite=${counts.unknownLikely}`,
      `unknownInsideCwd=${counts.unknownInside}`,
      `unknownWithoutHints=${counts.unknownNoHint}`,
      `unparsedExecWithoutWriteSignal=${counts.unparsedClean}`,
      `sidechainEntries=${counts.sidechain}`,
    ],
    explanations: [explanation],
    hints: [],
    resolve: [
      `dvdst calls ${session.path} --fields seq,tool,path,mutates,opaque,isError`,
      `dvdst files ${session.path} --contract exploration --path <path>`,
    ],
  };
}

export default {
  name: "claim-confidence",
  description: "Mutation claims with deterministic confidence bands, and named unknowns that need inspection.",
  fields: [
    { name: "session", type: "string", description: "Session id." },
    { name: "source", type: "string", description: "pi, claude, or codex." },
    { name: "path", type: "string", description: "Session file." },
    { name: "claim", type: "string", description: "mutation, unknown, or session-coverage." },
    { name: "tool", type: "string|null", description: "Tool name, when the row is one call." },
    { name: "seq", type: "number|null", description: "Call sequence in the session." },
    { name: "line", type: "number|null", description: "Source line of the call." },
    { name: "callId", type: "string|null", description: "Tool call id, for dvdst call --id." },
    { name: "target", type: "string|null", description: "Claimed or hinted path." },
    { name: "scope", type: "string|null", description: "inside, outside, or mixed relative to the session cwd." },
    { name: "confidence", type: "number|null", description: "Band score; null for an unknown." },
    { name: "band", type: "string", description: "verified, declared, inferred, partial, weak, contradicted, unknown, complete, near-complete." },
    { name: "reason", type: "string|null", description: "Unknown reason code; null for mutation and coverage rows." },
    { name: "risk", type: "string|null", description: "likely, possible, or null, for unknown rows." },
    { name: "attribution", type: "string|null", description: "declared, inferred, or none." },
    { name: "outcome", type: "string|null", description: "succeeded, failed, or unfinished." },
    { name: "stageability", type: "string|null", description: "exact, conditional, or unsupported." },
    { name: "checks", type: "string[]", description: "Deterministic checks that produced the band." },
    { name: "explanations", type: "string[]", description: "Why the claim scores as it does, and what is not known." },
    { name: "hints", type: "string[]", description: "Paths the text mentions without proving a write." },
    { name: "resolve", type: "string[]", description: "Commands or readers that would resolve an unknown." },
  ],
  derive(session) {
    const cwd = typeof session.cwd === "string" ? session.cwd : null;
    const rows = [];
    const counts = {
      mutation: 0, verified: 0, declared: 0, inferred: 0, partial: 0, weak: 0, contradicted: 0,
      unknown: 0, unknownLikely: 0, unknownPossible: 0, unknownInside: 0, unknownHints: 0, unknownNoHint: 0, unparsedClean: 0, sidechain: 0,
    };

    // Raw source is only used for caveats the canonical rows cannot carry:
    // Claude sidechain entries and original tool names.
    const originalNames = new Map();
    if (session.source === "claude") {
      try {
        for (const line of readFileSync(session.path, "utf8").split("\n")) {
          if (line.trim().length === 0) continue;
          const entry = JSON.parse(line);
          if (entry?.isSidechain === true) counts.sidechain += 1;
          if (entry?.type === "assistant" && Array.isArray(entry?.message?.content)) {
            for (const block of entry.message.content) {
              if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") originalNames.set(block.id, block.name);
            }
          }
        }
      } catch { /* the canonical rows still carry the claims */ }
    }

    for (const call of session.calls) {
      const tool = String(call.tool ?? "");
      const args = call.args && typeof call.args === "object" ? call.args : {};
      const outcome = call.isError === false ? "succeeded" : call.isError === true ? "failed" : "unfinished";
      const line = lineOf(call);
      const ref = refOf(call);
      const resultText = typeof call.resultText === "string" ? call.resultText : "";
      const base = {
        session: session.session,
        source: session.source,
        path: session.path,
        claim: "mutation",
        tool,
        seq: call.seq ?? null,
        line,
        callId: typeof call.callId === "string" ? call.callId : null,
        scope: null,
        confidence: null,
        band: "unknown",
        attribution: null,
        outcome,
        stageability: null,
        checks: [],
        explanations: [],
        hints: [],
        resolve: [],
      };

      const scopeOf = (path) => within(cwd, path) === true ? "inside" : within(cwd, path) === false ? "outside" : null;
      const finish = (target, confidence, band, attribution, stageability, checks, explanations, hints = []) => {
        counts.mutation += 1;
        counts[band] += 1;
        rows.push({ ...base, target, scope: scopeOf(target), confidence, band, attribution, stageability, checks, explanations, hints });
      };

      if (tool === "edit") {
        const path = resolvePath(cwd, args.path ?? args.file_path);
        const edits = Array.isArray(args.edits) ? args.edits : [];
        if (path === null || edits.length === 0) {
          rows.push({ ...base, target: path, band: "unknown", attribution: "declared", checks: ["malformed-declared-evidence"], explanations: ["The edit tool call has no path or no replacement pair; dvdst cannot name a target."], resolve: [`dvdst call --ref ${ref ?? "<ref>"}`] });
          counts.unknown += 1; counts.unknownPossible += 1;
          continue;
        }
        const checks = ["attribution=declared", "anchors-present"];
        const explanations = ["The edit tool binds a path and replacement text; success means the agent's edit tool reported applying it."];
        let score = 0.9, band = "declared";
        if (outcome === "succeeded" && resultNamesPath(resultText, path, cwd)) {
          score = 1; band = "verified"; checks.push("result-names-path");
          explanations.push("The successful result text names this file, an independent confirmation from the same call.");
        } else if (outcome === "succeeded") {
          checks.push("result-no-path-echo");
        }
        if (outcome === "unfinished") { score = Math.min(score, 0.3); band = "weak"; checks.push("no-result"); explanations.push("No tool result was recorded, so success is not confirmed."); }
        if (outcome === "failed") { score = 0.1; band = "contradicted"; checks.push("result-failed"); explanations.push("The call reported an error; do not treat this path as changed by this call. A string replacement is atomic, so a failed edit normally wrote nothing."); }
        if (pathConflict(resultText, path) === "differ") { score = 0.1; band = "contradicted"; checks.push("result-names-other-path"); explanations.push("The successful result names a different path than the argument; compare worktree and cwd."); }
        if (edits.some((edit) => typeof edit?.oldText !== "string" || edit.oldText.length === 0)) { checks.push("empty-anchor"); explanations.push("An empty oldText is an insertion whose position cannot be replayed from text alone."); }
        const stageability = edits.some((edit) => typeof edit?.oldText !== "string" || edit.oldText.length === 0) ? "unsupported" : "exact";
        finish(path, score, band, "declared", stageability, checks, explanations);
        continue;
      }

      if (tool === "write") {
        const path = resolvePath(cwd, args.path ?? args.file_path);
        if (path === null || typeof args.content !== "string") {
          rows.push({ ...base, target: path, band: "unknown", attribution: "declared", checks: ["malformed-declared-evidence"], explanations: ["The write tool call has no path or no string content; dvdst cannot name a target."], resolve: [`dvdst call --ref ${ref ?? "<ref>"}`] });
          counts.unknown += 1; counts.unknownPossible += 1;
          continue;
        }
        const checks = ["attribution=declared", "whole-file-content"];
        const explanations = ["The write tool carries the complete new file body; success means the agent's write tool reported creating the file."];
        let score = 0.9, band = "declared";
        if (outcome === "succeeded" && resultNamesPath(resultText, path, cwd)) {
          score = 1; band = "verified"; checks.push("result-names-path");
          explanations.push("The successful result text names this file.");
        } else if (outcome === "succeeded") {
          checks.push("result-no-path-echo");
        } else if (outcome === "unfinished") {
          score = 0.3; band = "weak"; checks.push("no-result"); explanations.push("No tool result was recorded, so success is not confirmed.");
        } else {
          score = 0.1; band = "contradicted"; checks.push("result-failed"); explanations.push("The call reported an error; do not treat this path as changed by this call.");
        }
        if (pathConflict(resultText, path) === "differ") { score = 0.1; band = "contradicted"; checks.push("result-names-other-path"); explanations.push("The successful result names a different path than the argument; compare worktree and cwd."); }
        explanations.push("A whole-file write has no before-image. dvdst can stage it only when the path is absent from HEAD.");
        finish(path, score, band, "declared", "conditional", checks, explanations);
        continue;
      }

      if (tool === "apply_patch") {
        const operations = applyPatchOperations(args.patch);
        const paths = Array.isArray(args.paths) && args.paths.length > 0
          ? args.paths
          : operations.map((operation) => operation.path);
        if (paths.length === 0) {
          rows.push({ ...base, target: null, band: "unknown", attribution: "declared", checks: ["malformed-declared-evidence"], explanations: ["The apply_patch call has no recoverable file header; dvdst cannot name a target."], resolve: [`dvdst call --ref ${ref ?? "<ref>"}`] });
          counts.unknown += 1; counts.unknownPossible += 1;
          continue;
        }
        for (const raw of paths) {
          const path = resolvePath(cwd, raw);
          if (path === null) continue;
          const operation = operations.find((candidate) => resolvePath(cwd, candidate.path) === path);
          const kind = operation?.kind ?? "update";
          const checks = [`attribution=declared`, `patch=${kind}`];
          const explanations = ["The patch envelope names this file and carries the exact hunks; the exec wrapper reported the script completed."];
          let score = 0.9, band = "declared";
          if (outcome === "unfinished") { score = 0.3; band = "weak"; checks.push("no-result"); explanations.push("No tool result was recorded, so the patch is not confirmed."); }
          if (outcome === "failed") { score = 0.1; band = "contradicted"; checks.push("result-failed"); explanations.push("The script reported failure; apply_patch is applied as one patch, so no file in it should be treated as changed by this call."); }
          if (kind === "update" && patchHasEmptyHunk(args.patch)) { checks.push("hunk-without-before-text"); explanations.push("A hunk carries only added lines, so its exact insertion point cannot be replayed from the patch alone."); }
          const stageability = kind === "add" ? "conditional" : kind === "update" ? (patchHasEmptyHunk(args.patch) ? "unsupported" : "exact") : "unsupported";
          if (kind === "delete" || kind === "move") explanations.push(`dvdst analysis claims the path, but staging has no ownership pre-image for a ${kind}.`);
          finish(path, score, band, "declared", stageability, checks, explanations);
        }
        continue;
      }

      if (SHELL_TOOLS.has(tool)) {
        const command = typeof call.command === "string" ? call.command : String(args.command ?? "");
        for (const raw of Array.isArray(call.mutates) ? call.mutates : []) {
          const path = resolvePath(cwd, raw);
          if (path === null) continue;
          const checks = ["attribution=inferred", "operator-names-path"];
          const explanations = ["The shell text names this path through a mutating operator; the call reported success. The write is inferred from text, not from tool semantics."];
          let score = 0.55, band = "inferred";
          if (outcome === "unfinished") { score = 0.3; band = "weak"; checks.push("no-result"); explanations.push("No tool result was recorded, so the command's outcome is unknown."); }
          if (outcome === "failed") {
            if (writeErrorFor(resultText, path)) {
              score = 0.1; band = "contradicted"; checks.push("result-failed", "write-error-names-path");
              explanations.push("The result names this path in a write failure, so the write itself should not be treated as applied.");
            } else {
              score = 0.35; band = "partial"; checks.push("result-failed", "write-may-precede-failure");
              explanations.push("The shell call reported failure, but shell commands can write before the failing step. The text still names this path; check the file or the result tail.");
            }
          }
          if (pathConflict(resultText, path) === "differ") { checks.push("result-names-other-path"); }
          finish(path, score, band, "inferred", "unsupported", checks, explanations);
        }
        for (const reason of Array.isArray(call.opaque) ? call.opaque : []) {
          const hints = hintsFromScript(command, cwd);
          const code = unknownReason(reason);
          const likely = code !== "opaque-command" && code !== "xargs-or-find-exec";
          counts.unknown += 1;
          if (likely) counts.unknownLikely += 1; else counts.unknownPossible += 1;
          if (hints.length > 0) counts.unknownHints += 1;
          else if (likely) counts.unknownNoHint += 1;
          if (hints.some((hint) => within(cwd, hint))) counts.unknownInside += 1;
          rows.push({
            ...base,
            claim: "unknown",
            target: null,
            band: "unknown",
            attribution: "none",
            confidence: null,
            stageability: "unsupported",
            reason: code,
            risk: likely ? "likely" : "possible",
            checks: ["attribution=opaque", `reason=${reason}`, ...(hints.length > 0 ? ["text-names-candidate-paths"] : [])],
            explanations: [
              `${reason}: the command can change files that its text does not name, so dvdst makes no path claim.`,
              ...(hints.length > 0 ? ["The script text mentions candidate paths. They are hints, not proof of a write."] : []),
            ],
            hints,
            scope: hints.length === 0 ? null : hints.every((hint) => within(cwd, hint) === true) ? "inside" : hints.every((hint) => within(cwd, hint) === false) ? "outside" : "mixed",
            resolve: [
              `dvdst call --ref ${ref ?? "<ref>"} --limit 4000`,
              ...(hints.slice(0, 3).map((hint) => `git diff -- ${hint}`)),
            ],
          });
        }
        continue;
      }

      if (tool === "exec") {
        const script = typeof args.input === "string" ? args.input : text(args);
        const scan = script.replace(/\\n/g, "\n").replace(/\\"/g, '"');
        const patchPaths = [...scan.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((match) => (match[1] ?? match[2]).trim());
        const form = /const\s+\w+\s*=\s*"/.test(script)
          ? "patch stored in a local variable"
          : /tools\.apply_patch\(\s*\w/.test(script)
            ? "patch argument computed at runtime"
            : "unsupported exec syntax (bindings, loops, or conditionals)";
        const looksWriter = /apply_patch/.test(script);
        const writes = WRITE_API.test(script) || WRITE_VERB.test(script) || INTERPRETER.test(script);
        const replChars = /write_stdin\([^)]*chars\s*:\s*"(?!")/.test(script);
        const unknownTool = [...script.matchAll(/tools\.([A-Za-z_$][\w$]*)\s*\(/g)]
          .map((match) => match[1])
          .filter((name) => !["exec_command", "write_stdin", "apply_patch", "view_image", "wait", "sleep"].includes(name));
        const risky = looksWriter || writes || replChars || unknownTool.length > 0;
        if (!risky) { counts.unparsedClean += 1; continue; }
        const hints = looksWriter
          ? patchPaths.map((path) => resolvePath(cwd, path)).filter((path) => path !== null)
          : writes || replChars
            ? hintsFromScript(script, cwd)
            : [];
        counts.unknown += 1;
        if (looksWriter || writes || replChars) counts.unknownLikely += 1; else counts.unknownPossible += 1;
        if (hints.length > 0) counts.unknownHints += 1;
        else if (looksWriter || writes || replChars) counts.unknownNoHint += 1;
        if (hints.some((hint) => within(cwd, hint))) counts.unknownInside += 1;
        const why = looksWriter
          ? "The script contains an apply_patch call, so a file mutation is stated in the text but not attributed to a path."
          : writes
            ? "The script contains a shell write or inline interpreter pattern; the target may be inside the workspace."
            : replChars
              ? "The script feeds non-empty input to a running process, which can change files the text does not name."
              : `The script calls an unmodelled tool (${unknownTool.join(", ")}), which may perform its own writes.`;
        rows.push({
          ...base,
          claim: "unknown",
          target: null,
          band: "unknown",
          attribution: "none",
          confidence: null,
          stageability: "unsupported",
          reason: "unparsed-exec",
          risk: "likely",
          checks: ["attribution=unparsed-exec", ...(looksWriter ? [`apply_patch=${form}`] : []), ...(risky ? ["write-signal"] : []), ...(unknownTool.length > 0 ? [`unmodelled-tools=${unknownTool.join(",")}`] : [])],
          explanations: [
            `dvdst did not expand this exec script (${form}), so it makes no nested tool-call claims.`,
            why,
          ],
          hints,
          scope: hints.length === 0 ? null : hints.every((hint) => within(cwd, hint) === true) ? "inside" : hints.every((hint) => within(cwd, hint) === false) ? "outside" : "mixed",
          resolve: [
            `dvdst call --ref ${ref ?? "<ref>"} --limit 4000`,
            ...(hints.slice(0, 3).map((hint) => `git diff -- ${hint}`)),
          ],
        });
        continue;
      }

      if (tool === "write_stdin") {
        const chars = typeof args.chars === "string" ? args.chars : "";
        if (chars.length > 0) {
          counts.unknown += 1; counts.unknownLikely += 1;
          rows.push({
            ...base,
            claim: "unknown",
            target: null,
            band: "unknown",
            attribution: "none",
            confidence: null,
            stageability: "unsupported",
            reason: "stdin-input",
            risk: "likely",
            checks: ["attribution=stdin-input", "non-empty-chars"],
            explanations: ["The call feeds input to a running process. That process can write files the transcript does not name."],
            hints: [],
            scope: null,
            resolve: [`dvdst call --ref ${ref ?? "<ref>"} --limit 4000`],
          });
        }
        continue;
      }

      const original = originalNames.get(String(call.callId ?? ""));
      if (original === "NotebookEdit" || /^(?:MultiEdit)$/.test(original ?? "")) {
        const path = resolvePath(cwd, args.notebook_path ?? args.path ?? args.file_path);
        counts.unknown += 1; counts.unknownPossible += 1;
        rows.push({
          ...base,
          claim: "unknown",
          target: path,
          band: "unknown",
          attribution: "declared",
          reason: "not-modelled-tool",
          risk: "possible",
          checks: [`tool=${original}`, "not-modeled"],
          explanations: [
            original === "NotebookEdit"
              ? "NotebookEdit changes a notebook cell; dvdst does not model notebook cell replacement or its path semantics."
              : "MultiEdit carries per-edit replace_all flags that the canonical edit arguments do not preserve; staging may replay it as a single replacement.",
          ],
          resolve: [`dvdst call --ref ${ref ?? "<ref>"} --limit 4000`],
        });
        continue;
      }
      if (typeof (args.path ?? args.file_path ?? args.notebook_path) === "string" && /(?:write|edit|patch|delete|move|rename|save)/i.test(tool)) {
        const path = resolvePath(cwd, args.path ?? args.file_path ?? args.notebook_path);
        counts.unknown += 1; counts.unknownPossible += 1;
        rows.push({
          ...base,
          claim: "unknown",
          target: path,
          band: "unknown",
          attribution: "declared",
          reason: "not-modelled-tool",
          risk: "possible",
          checks: [`tool=${tool}`, "not-modeled"],
          explanations: ["The tool takes a file path and its name suggests a mutation, but dvdst does not model its semantics; no mutation claim is made."],
          resolve: [`dvdst call --ref ${ref ?? "<ref>"} --limit 4000`],
        });
      }
    }

    rows.push(sessionRow(session, counts));
    if (counts.sidechain > 0) {
      rows.push({
        session: session.session,
        source: session.source,
        path: session.path,
        claim: "unknown",
        tool: "sidechain",
        seq: null,
        line: null,
        callId: null,
        target: null,
        scope: "mixed",
        confidence: null,
        band: "unknown",
        attribution: "none",
        outcome: null,
        stageability: "unsupported",
        reason: "sidechain-excluded",
        risk: "likely",
        checks: [`sidechainEntries=${counts.sidechain}`],
        explanations: ["Claude subagent (sidechain) entries are excluded from the canonical stream. Files they changed are not in this claim set."],
        hints: [],
        resolve: [`rg -n '"isSidechain":true' ${session.path}`],
      });
    }
    return rows;
  },
};
