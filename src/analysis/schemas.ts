import { STREAMS, type StreamSpec } from "./rows.js";
import { CALL_SCHEMA } from "./read-call.js";
import { MESSAGE_SCHEMA, MESSAGES_SCHEMA, SEARCH_SCHEMA } from "./conversation-schema.js";

export const CAPABILITIES_SCHEMA: StreamSpec = {
  description: "Machine-readable built-in command catalog. No target: compact entries. One target: executable option definitions, typed input schema, output contract, constraints, and examples. Never loads project extractors.",
  fields: [
    { name: "schemaVersion", type: "number", description: "1." },
    { name: "commands", type: "object[]", description: "Entries with name, summary, group, sessionSources, effects, hasOutputSchema. Targeted entries additionally carry positionals, inputSchema, options, output, constraints, limitations, and examples." },
    { name: "notes", type: "string[]", description: "Discovery scope, extension execution, output schema coverage, and model/network boundaries." },
  ],
};

export const EXPLORATION_SCHEMAS = { call: CALL_SCHEMA, messages: MESSAGES_SCHEMA, message: MESSAGE_SCHEMA, search: SEARCH_SCHEMA, capabilities: CAPABILITIES_SCHEMA };
export const BUILTIN_SCHEMAS: Record<string, StreamSpec> = { ...STREAMS, ...EXPLORATION_SCHEMAS };
