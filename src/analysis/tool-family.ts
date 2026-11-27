/**
 * Cross-agent tool families. Every source keeps its own tool names (Codex
 * write_stdin and wait, Claude Code WebFetch, Pi web), so a filter on `tool`
 * does not carry across agents. The family is a fixed lookup on the canonical
 * tool name; it never inspects arguments, and an unlisted name is `other`.
 */
export const TOOL_FAMILIES = ["shell", "poll", "read", "edit", "write", "search", "web", "other"] as const;
export type ToolFamily = typeof TOOL_FAMILIES[number];

const FAMILY: Record<string, ToolFamily> = {
  // Commands and scripts. Codex shell tools are already canonical `bash`;
  // `exec` is a Codex code-mode cell whose script dvdst leaves opaque.
  bash: "shell", exec: "shell", powershell: "shell",
  // Waiting on, or feeding input to, a command that is already running.
  write_stdin: "poll", wait: "poll", sleep: "poll", bashoutput: "poll", monitor: "poll", taskoutput: "poll",
  read: "read", view_image: "read", notebookread: "read",
  edit: "edit", apply_patch: "edit", multiedit: "edit", notebookedit: "edit",
  write: "write",
  grep: "search", find: "search", ls: "search", glob: "search",
  web: "web", websearch: "web", webfetch: "web", web_search: "web", web_fetch: "web",
};

export function toolFamily(tool: string): ToolFamily {
  return FAMILY[tool.toLowerCase()] ?? "other";
}

export const TOOL_FAMILY_DESCRIPTION = "Cross-agent tool family from the canonical tool name: shell (bash; Codex exec cells; powershell), poll (write_stdin, wait, sleep, BashOutput, Monitor, TaskOutput), read (read, view_image), edit (edit, apply_patch, MultiEdit, NotebookEdit), write, search (grep, find, ls, glob), web (web, WebSearch, WebFetch, web_search), or other (including MCP tools). Filter with --family; tool keeps the raw name.";
