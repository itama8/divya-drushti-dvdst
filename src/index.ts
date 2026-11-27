/**
 * The dvdst library. Import it from a script run with tsx to start from
 * parsed, typed session rows instead of raw session JSONL:
 *
 *   import { loadSessions } from "dvdst";
 *   for await (const session of loadSessions({ project: "omakase-v2", last: 50 })) {
 *     console.log(session.session, session.overview.cost, session.calls.length);
 *   }
 */
export { loadSession, loadSessionFile, loadSessionRows, loadSessions, type LoadSessionOptions, type SessionData } from "./analysis/session.js";
export { getCapabilities } from "./capabilities.js";
export { readCall, sliceText, CALL_SCHEMA, type ReadCallOptions, type TextSlice } from "./analysis/read-call.js";
export { loadConversation, conversationFromSession, listMessages, searchConversation, readMessage, type Conversation, type ConversationMessage, type ConversationQueryOptions, type EvidencePage, type MessageMetadata, type MessageRow, type ReadMessageOptions, type RoleSelection, type SearchHit, type SearchOptions, type SearchScope } from "./analysis/conversation.js";
export { MESSAGES_SCHEMA, MESSAGE_SCHEMA, SEARCH_SCHEMA } from "./analysis/conversation-schema.js";
export { MESSAGE_KINDS, classifyMessage, type KindSelection, type MessageKind } from "./analysis/message-kind.js";
export { deriveRows, STREAMS, ROWS_SCHEMA_VERSION, type FieldSpec, type Row, type SessionRows, type StreamName, type StreamSpec } from "./analysis/rows.js";
export { findExtractor, listExtractorFiles, loadExtractorFile, type Extractor, type LoadedExtractor } from "./analysis/extractors.js";
export { resolveSession, resolveSessions, SessionResolveError, type ResolveSessionsOptions } from "./pi/resolve-sessions.js";
export { parseBashEffects, type BashEffect, type BashEffects } from "./pi/bash-effects.js";
export { classifyCommand, classifyCommandWithReasons, type CommandClass, type CommandClassRule } from "./pi/classify-commands.js";
export { loadProjectConfig, parseConfig, type ProjectConfig } from "./config/config.js";
export { readJsonl, type SourceRecord, type SourceReference } from "./pi/read-jsonl.js";

export { queryInspection, type InspectionKind, type InspectionQueryOptions } from "./analysis/inspection.js";
export { FILES_SCHEMA, COMMANDS_SCHEMA, SKILLS_SCHEMA } from "./analysis/inspection-schema.js";
