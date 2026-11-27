import type { FieldSpec, StreamSpec } from "./rows.js";

const field = (name: string, type: string, description: string): FieldSpec => ({ name, type, description });
const identity = [field("session", "string", "Recorded session ID; multiple segment files may share it."), field("source", "string", "pi, claude, or codex."), field("path", "string", "Absolute segment path.")];
const KIND = "human, injected, skill-expansion, notification, agent, tool, or unknown. User role: structure first (Pi message entries, surviving Claude Code prompts, Codex inputs with a submitted echo; Codex user items without one are injected), anchored text markers refine or decide when structure is silent. human means entered through the prompt path without a harness marker, not verified authorship; unknown is never guessed as human. assistant is agent, toolResult is tool, system/developer are injected.";
const text = "TextSlice: {text, offset, totalChars, nextOffset, truncated}. Unicode code-point offsets; source conversion joins visible text blocks with newlines.";

export const MESSAGES_SCHEMA: StreamSpec = {
  description: "One canonical message with bounded visible text and exact snapshot reference. Default roles: user,assistant; default 20 rows and 240 characters per row; --full returns complete text. Assistant messages holding only thinking or tool calls appear with text.totalChars 0; --nonempty skips them without renumbering seq. Output: jsonl rows by default, a bare JSON array with --format json, or a {rows, matched, offset, returned, nextOffset, ...} envelope with --page.",
  fields: [
    ...identity,
    field("seq", "number", "1-based message position in the unfiltered canonical conversation, including tool-only messages."),
    field("id", "string|null", "Canonical record ID, where recorded or generated during conversion."),
    field("role", "string", "Recorded role, typically user, assistant, toolResult, system, or developer."),
    field("kind", "string", KIND),
    field("channel", "string|null", "Recorded message channel, verbatim. Codex: the item's channel, else its phase (newer rollouts record phase commentary or final_answer; older ones may record analysis/commentary/final). Null when the source records neither, as with Pi and Claude Code; do not treat analysis or commentary as the final user-facing reply."),
    field("line", "number", "First source line of the canonical message. A merged Claude message may span several records."),
    field("byteStart", "number", "Start of the first source entry in raw bytes."),
    field("byteEnd", "number", "End of the first source entry in raw bytes (exclusive)."),
    field("sources", "object[]", "Source line/byte ranges for this message's visible text and call blocks. Entry ranges, not substring byte ranges."),
    field("turn", "number|null", "Assistant turn index joining turns.turn and calls.turn; null for other roles."),
    field("userTurn", "number", "Number of canonical user messages encountered so far."),
    field("callIds", "string[]", "Tool calls dispatched by this assistant message."),
    field("callRefs", "string[]", "References usable with dvdst call --ref, in callIds order."),
    field("resultCallId", "string|null", "Tool call ID named by a tool result, including orphan results."),
    field("resultCallRef", "string|null", "Joined call reference when uniquely identifiable; null for unmatched/ambiguous results."),
    field("ref", "string", "Use with dvdst message --ref; pins exact segment bytes, message position, line, and ID."),
    field("text", "object", text),
  ],
};

export const SEARCH_SCHEMA: StreamSpec = {
  description: "First literal match per selected message/command/result. Default: user/assistant messages, 20 hits, 240-character excerpts (--full: the whole matched text). --ignore-case uses Unicode simple folding; no user regex is executed. Output: jsonl rows by default, a bare JSON array with --format json, or a {rows, matched, offset, returned, nextOffset, ...} envelope with --page.",
  fields: [
    ...identity,
    field("kind", "string", "message, command, or result."),
    field("role", "string", "Role of the source message: commands are assistant; results are toolResult."),
    field("messageKind", "string", `kind of the enclosing message (messages schema): ${KIND}`),
    field("channel", "string|null", "Channel of the enclosing message (messages schema): Codex channel or phase, where recorded."),
    field("line", "number", "Source line of the first matched text/call block, which may be later than its canonical message's first line."),
    field("sources", "object[]", "Raw source entry ranges intersecting the match. Multiple entries can support a cross-block match."),
    field("messageSeq", "number", "Position of the enclosing canonical message."),
    field("messageRef", "string", "Use with dvdst message --ref to inspect surrounding conversation."),
    field("callId", "string|null", "Call ID for command/result hits; null for conversation text."),
    field("ref", "string", "Message ref for message/orphan-result hits; call ref for joined command/result hits."),
    field("refKind", "string", "message or call: which reader accepts ref. messageRef always accepts dvdst message --ref."),
    field("match", "object", "{offset, chars}: first match in the complete rendered text, in Unicode code points."),
    field("excerpt", "object", text),
  ],
};

export const MESSAGE_SCHEMA: StreamSpec = {
  description: "One JSON object (not rows): {schemaVersion, source, session, path, fingerprint, anchorSeq, messages, beforeRef, afterRef}. The anchor and its neighbors are messages-schema rows under messages; select the anchor with seq === anchorSeq. One exact message and a bounded canonical neighborhood. Accepts message refs or call refs (requesting assistant). Default two messages before/after, 2000 characters per message. Includes tool-only messages/results; omits thinking/reasoning blocks and binary payloads.",
  fields: [
    field("schemaVersion", "number", "1."), ...identity,
    field("fingerprint", "string", "SHA-256 of the exact raw segment bytes read."),
    field("anchorSeq", "number", "Selected message position; --text-offset applies only to this message."),
    field("messages", "object[]", "messages schema rows, in canonical order, with bounded text."),
    field("beforeRef", "string|null", "Nearest omitted message before the window; use message --ref to continue."),
    field("afterRef", "string|null", "Nearest omitted message after the window; use message --ref to continue."),
  ],
};
