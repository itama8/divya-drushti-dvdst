// How a session oriented itself before its first edit or write: what it read,
// how much came back, and how often Pi cut a result short.
//
//   dvdst rows examples/extractors/orientation.mjs --project omakase-v2 --last 50
export default {
  description: "One row per session: the reads and result bytes before the first edit or write.",
  fields: [
    { name: "session", type: "string", description: "Session id." },
    { name: "model", type: "string|null", description: "First model of the session." },
    { name: "callsBeforeFirstMutation", type: "number", description: "Tool calls before the first edit or write, or all calls when there is none." },
    { name: "filesRead", type: "number", description: "Distinct files read in that span, through the read tool or bash." },
    { name: "resultBytes", type: "number", description: "Result bytes returned in that span." },
    { name: "truncatedResults", type: "number", description: "Results in that span that Pi cut at its output limit." },
    { name: "largestReads", type: "string[]", description: "The three files that returned the most bytes." },
  ],
  derive(session) {
    const firstMutation = session.calls.findIndex((call) => call.tool === "edit" || call.tool === "write");
    const before = firstMutation < 0 ? session.calls : session.calls.slice(0, firstMutation);
    const bytesByFile = new Map();
    for (const call of before) {
      for (const path of call.reads) bytesByFile.set(path, (bytesByFile.get(path) ?? 0) + (call.resultBytes ?? 0));
    }
    return [{
      session: session.session,
      model: session.overview.models[0] ?? null,
      callsBeforeFirstMutation: before.length,
      filesRead: bytesByFile.size,
      resultBytes: before.reduce((sum, call) => sum + (call.resultBytes ?? 0), 0),
      truncatedResults: before.filter((call) => call.truncated).length,
      largestReads: [...bytesByFile.entries()].sort((left, right) => right[1] - left[1]).slice(0, 3).map(([path]) => path),
    }];
  },
};
