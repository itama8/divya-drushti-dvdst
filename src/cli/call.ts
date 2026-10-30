import { parseArgs } from "node:util";
import { integerOption, readCall } from "../analysis/read-call.js";
import { guardStdout } from "./stdout.js";

guardStdout();
try {
  const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true, options: {
    id: { type: "string" }, seq: { type: "string" }, ref: { type: "string" }, limit: { type: "string" },
    "args-offset": { type: "string" }, "result-offset": { type: "string" }, "command-offset": { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    process.stderr.write("Usage: dvdst call <session> <--id ID | --seq N> [--limit chars]\n       dvdst call --ref <ref> [--limit chars] [--args-offset N] [--result-offset N] [--command-offset N]\nJSON output; default 4096 Unicode characters per text field; maximum 65536. Run dvdst schema call for output fields.\n");
  } else {
    if (positionals.length > 1) throw new Error("Expected at most one session. Run dvdst call --help.");
    const result = await readCall({
      ...(positionals[0] === undefined ? {} : { session: positionals[0] }),
      ...(values.id === undefined ? {} : { id: values.id }),
      ...(values.ref === undefined ? {} : { ref: values.ref }),
      ...(values.seq === undefined ? {} : { seq: integerOption(values.seq, "--seq", 1)! }),
      ...(values.limit === undefined ? {} : { limit: integerOption(values.limit, "--limit", 1, 65536)! }),
      ...(values["args-offset"] === undefined ? {} : { argsOffset: integerOption(values["args-offset"], "--args-offset", 0)! }),
      ...(values["result-offset"] === undefined ? {} : { resultOffset: integerOption(values["result-offset"], "--result-offset", 0)! }),
      ...(values["command-offset"] === undefined ? {} : { commandOffset: integerOption(values["command-offset"], "--command-offset", 0)! }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
