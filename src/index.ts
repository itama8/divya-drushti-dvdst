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
export { deriveRows, STREAMS, ROWS_SCHEMA_VERSION, type FieldSpec, type Row, type SessionRows, type StreamName, type StreamSpec } from "./analysis/rows.js";
export { findExtractor, listExtractorFiles, loadExtractorFile, type Extractor, type LoadedExtractor } from "./analysis/extractors.js";
export { resolveSession, resolveSessions, SessionResolveError, type ResolveSessionsOptions } from "./pi/resolve-sessions.js";
export { parseBashEffects, type BashEffect, type BashEffects } from "./pi/bash-effects.js";
export { classifyCommand, classifyCommandWithReasons, type CommandClass, type CommandClassRule } from "./pi/classify-commands.js";
export { loadProjectConfig, parseConfig, type ProjectConfig } from "./config/config.js";
export { readJsonl, type SourceRecord, type SourceReference } from "./pi/read-jsonl.js";
