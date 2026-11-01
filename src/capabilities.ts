import { COMMANDS, type CommandDefinition, type CommandGroup } from "./cli/commands.js";
import type { CatalogOption } from "./cli/command-options.js";

/** JSON-compatible value schemas describe typed values before argv serialization. */
function optionSchema(option: CatalogOption): Record<string, unknown> {
  const type = option.type === "boolean" ? "boolean" : option.valueType ?? "string";
  const result: Record<string, unknown> = { type, description: option.description };
  if (option.choices !== undefined) result.enum = option.choices;
  for (const key of ["minimum", "maximum", "minLength", "const"] as const) if (option[key] !== undefined) result[key] = option[key];
  const fallback = option.effectiveDefault ?? option.default;
  if (option.defaultDescription === undefined && fallback !== undefined) result.default = type === "integer" ? Number(fallback) : fallback;
  if (option.defaultDescription !== undefined) result["x-default-description"] = option.defaultDescription;
  if (option.short !== undefined) result["x-cli-short"] = option.short;
  return result;
}

function inputSchema(command: CommandDefinition): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object", additionalProperties: false,
    description: "Typed normal-invocation values before argv serialization. Cross-field selection modes and environment fallback are described in constraints, not fully encoded here. --help is a separate mode.",
    properties: {
      positionals: { type: "array", items: { type: "string" }, minItems: command.positionals.min,
        ...(command.positionals.max === undefined ? {} : { maxItems: command.positionals.max }), description: command.positionals.description },
      options: { type: "object", additionalProperties: false,
        properties: Object.fromEntries(Object.entries(command.options).map(([name, option]) => [name, optionSchema(option)])), required: command.requiredOptions },
    },
    required: [...(command.positionals.min > 0 ? ["positionals"] : []), ...(command.requiredOptions.length > 0 ? ["options"] : [])],
  };
}

const notes = [
  "Catalog lists built-ins only and never discovers/imports project extractor modules. The dispatcher uses the same command registry; CLI parsers use the same option definitions.",
  "Detailed output schemas are shared with dvdst schema where available. Legacy outputs without a shared field schema explicitly return schema:null; their shape/format descriptions are not a substitute for a field schema.",
  "Core commands make no model calls or network requests. Caller-selected extractor code may perform arbitrary IO, model calls, or network requests.",
  "Effects describe material persistent writes and caller-code execution, not stdout or temporary implementation files. Support for transcript analysis does not imply a bundled live adapter.",
];

export function getCapabilities(target?: string, group?: CommandGroup) {
  if (target !== undefined && group !== undefined) throw new Error("Choose a command target OR --group, not both.");
  if (target !== undefined && !Object.hasOwn(COMMANDS, target)) throw new Error(`Unknown built-in command ${JSON.stringify(target)}. Run dvdst capabilities for the catalog. Project extractors are not loaded.`);
  if (group !== undefined && !Object.values(COMMANDS).some(command => command.group === group)) throw new Error(`Unknown command group ${JSON.stringify(group)}.`);
  const selected = target === undefined ? Object.entries(COMMANDS).filter(([, command]) => group === undefined || command.group === group) : [[target, COMMANDS[target]!]] as const;
  const commands = selected.map(([name, command]) => {
    const compact = { name, summary: command.summary, group: command.group, sessionSources: command.sessionSources, effects: command.effects, hasOutputSchema: command.output.schema !== null };
    return target === undefined ? compact : { ...compact, positionals: command.positionals, inputSchema: inputSchema(command), options: command.options,
      output: command.output, constraints: command.constraints, limitations: command.limitations, examples: command.examples };
  });
  // Callers may modify returned descriptors without mutating live parser options.
  return structuredClone({ schemaVersion: 1, commands, notes });
}
