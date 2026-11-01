import { parseArgs } from "node:util";
import { getCapabilities } from "../capabilities.js";
import { CLI_OPTIONS, parserOptions } from "./command-options.js";
import type { CommandGroup } from "./commands.js";
import { guardStdout } from "./stdout.js";

guardStdout();
try {
  const { values, positionals } = parseArgs({ args: process.argv.slice(3), allowPositionals: true, options: parserOptions(CLI_OPTIONS.capabilities) });
  if (values.help) {
    console.error("Usage: dvdst capabilities [command] [--group exploration|inspection|storage|live|staging|utility] [--format json|text]");
    console.error("No target: compact built-in catalog. A command target adds typed inputs, output schema where available, source support, effects, constraints, and examples. Never loads project extractors.");
  } else {
    if (positionals.length > 1) throw new Error("Expected at most one built-in command target.");
    const format = values.format ?? "json";
    if (format !== "json" && format !== "text") throw new Error("--format must be json or text.");
    const catalog = getCapabilities(positionals[0], values.group as CommandGroup | undefined);
    if (format === "json") process.stdout.write(`${JSON.stringify(catalog)}\n`);
    else for (const command of catalog.commands) {
      process.stdout.write(`${command.name} (${command.group}): ${command.summary}\n`);
      process.stdout.write(`  Transcript sources: ${command.sessionSources.join(", ") || "not a transcript reader"}\n`);
      for (const effect of command.effects) process.stdout.write(`  ${effect.kind}: ${effect.when}\n`);
      if ("options" in command) for (const [name, option] of Object.entries(command.options)) process.stdout.write(`  --${name}: ${option.description}\n`);
      if ("output" in command) process.stdout.write(`  Output: ${command.output.shape}; default ${command.output.defaultFormat}; field schema ${command.hasOutputSchema ? "available" : "not yet declared"}\n`);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
