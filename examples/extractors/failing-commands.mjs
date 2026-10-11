// The bash commands that fail most often across the selected sessions.
// `summarize` turns the per-session rows into one ranking.
//
//   dvdst rows examples/extractors/failing-commands.mjs --project omakase-v2 --last 50
function signature(command) {
  // Drop a leading `cd <dir> &&` and trailing output filters, so the same
  // command run from two places counts once.
  return command.replace(/^cd\s+\S+\s*(&&|;)\s*/, "").replace(/\s*(2>&1)?\s*\|\s*(tail|head)\b.*$/s, "").split("\n")[0].slice(0, 120);
}

export default {
  description: "Failing bash commands ranked by how often they failed, across sessions.",
  fields: [
    { name: "command", type: "string", description: "First line of the command, without a leading cd or a trailing tail or head." },
    { name: "failures", type: "number", description: "Failed runs." },
    { name: "sessions", type: "number", description: "Sessions with at least one failed run." },
    { name: "exitCodes", type: "number[]", description: "Distinct exit codes." },
    { name: "wastedMs", type: "number", description: "Time the failed runs took." },
  ],
  derive(session) {
    return session.calls
      .filter((call) => call.tool === "bash" && call.isError === true)
      .map((call) => ({ session: session.session, command: signature(call.command ?? ""), exitCode: call.exitCode, durationMs: call.durationMs ?? 0 }));
  },
  summarize(rows) {
    const byCommand = new Map();
    for (const row of rows) {
      const entry = byCommand.get(row.command) ?? { command: row.command, failures: 0, sessions: new Set(), exitCodes: new Set(), wastedMs: 0 };
      entry.failures += 1;
      entry.sessions.add(row.session);
      if (row.exitCode !== null) entry.exitCodes.add(row.exitCode);
      entry.wastedMs += row.durationMs;
      byCommand.set(row.command, entry);
    }
    return [...byCommand.values()]
      .map((entry) => ({ ...entry, sessions: entry.sessions.size, exitCodes: [...entry.exitCodes].sort((left, right) => left - right) }))
      .sort((left, right) => right.failures - left.failures || left.command.localeCompare(right.command));
  },
};
