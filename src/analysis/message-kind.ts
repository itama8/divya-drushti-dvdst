import { parseSkillBlock } from "../pi/skill-block.js";

/**
 * What a canonical message is, as far as its record can tell.
 *
 * User-role text is classified from record structure first: Pi `message`
 * entries, surviving Claude Code prompts, and Codex inputs with a submitted
 * echo entered through the prompt path; a Codex user item without an echo (in
 * a file that echoes inputs) was built by the harness. Text markers only
 * refine that, or decide when the structure gives no signal. Nothing defaults
 * to `human`: an unsignalled, unmarked user message is `unknown`.
 */
export const MESSAGE_KINDS = ["human", "injected", "skill-expansion", "notification", "agent", "tool", "unknown"] as const;
export type MessageKind = typeof MESSAGE_KINDS[number];
export type KindSelection = readonly string[];

/** Harness, client, or parent-agent material placed in the user role. Anchored at the start of the text. */
const INJECTED_MARKERS: RegExp[] = [
  /^# AGENTS\.md instructions for /, // Codex project instructions
  /^<(?:user_instructions|environment_context|permissions instructions|system-reminder|recommended_plugins)>/,
  /^The following is the Codex agent history\b/, // Codex reviewer/fork prompt
  /^\[Historical user; /, // Codex compaction replay
  /^Context handoff \([a-z_]+\):/, // T3 Code provider handoff
  /^Delegated task node:/, // T3 Code delegated task prompt
];

/** Command echoes, task and background notifications, interrupt markers. */
const NOTIFICATION_MARKERS: RegExp[] = [
  /^<(?:task-notification|command-name|command-message|command-args|local-command-(?:stdout|stderr|caveat))\b/,
  /^\[Request interrupted by user/,
  /^Background command completed \(/, // T3 Code background command notification
];

function markerKind(text: string): MessageKind | undefined {
  // The same expanded-skill grammar the skills command counts as an explicit invocation.
  if (parseSkillBlock(text) !== undefined) return "skill-expansion";
  const start = text.trimStart();
  if (NOTIFICATION_MARKERS.some(marker => marker.test(start))) return "notification";
  if (INJECTED_MARKERS.some(marker => marker.test(start))) return "injected";
  return undefined;
}

export interface KindEvidence {
  source: string;
  entryType: unknown;
  role: string;
  /** Converter structural hint: "submitted", "injected", or absent (no signal). */
  origin: unknown;
  text: string;
}

export function classifyMessage({ source, entryType, role, origin, text }: KindEvidence): MessageKind {
  if (role === "assistant") return "agent";
  if (role === "toolResult") return "tool";
  if (role === "system" || role === "developer") return "injected";
  if (role !== "user") return "unknown";
  // Pi writes typed prompts as `message` entries; extensions use separate custom entries.
  const structure = source === "pi" ? (entryType === "message" ? "submitted" : undefined)
    : origin === "submitted" || origin === "injected" ? origin : undefined;
  const marker = markerKind(text);
  if (structure === "injected") return marker ?? "injected";
  if (structure === "submitted") return marker ?? "human";
  return marker ?? "unknown";
}

export function parseKinds(value: string | undefined): KindSelection | undefined {
  if (value === undefined) return undefined;
  const kinds = value.split(",");
  validateKinds(kinds);
  return kinds;
}

export function validateKinds(kinds: KindSelection | undefined): void {
  if (kinds === undefined) return;
  if (kinds.length === 0 || new Set(kinds).size !== kinds.length || kinds.some(kind => !MESSAGE_KINDS.includes(kind as MessageKind))) {
    throw new Error(`--kind must be comma-separated ${MESSAGE_KINDS.join(",")} (without duplicates).`);
  }
}
