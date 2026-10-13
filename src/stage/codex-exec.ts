export interface LiteralToolCall { name: string; argument: unknown }

/** A small literal grammar, never eval: no bindings, control flow, getters or interpolation. */
export function literalToolCalls(input: string): LiteralToolCall[] | undefined {
  let rest = input.trim();
  const calls: LiteralToolCall[] = [];
  const take = (pattern: RegExp): string => {
    const match = pattern.exec(rest);
    if (!match) throw new Error("unsupported exec syntax");
    rest = rest.slice(match[0].length).trimStart();
    return match[0];
  };
  const value = (depth = 0): unknown => {
    if (depth > 40) throw new Error("literal nesting limit");
    if (rest.startsWith('"')) return JSON.parse(take(/^"(?:[^"\\]|\\.)*"/));
    if (rest.startsWith("{")) {
      take(/^\{/);
      const result: Record<string, unknown> = Object.create(null);
      while (!rest.startsWith("}")) {
        const key = rest.startsWith('"') ? value(depth + 1) as string : take(/^[A-Za-z_$][\w$]*/);
        take(/^:/);
        result[key] = value(depth + 1);
        if (!rest.startsWith(",")) break;
        take(/^,/);
      }
      take(/^\}/);
      return result;
    }
    if (rest.startsWith("[")) {
      take(/^\[/);
      const result: unknown[] = [];
      while (!rest.startsWith("]")) {
        result.push(value(depth + 1));
        if (!rest.startsWith(",")) break;
        take(/^,/);
      }
      take(/^\]/);
      return result;
    }
    return JSON.parse(take(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/));
  };
  try {
    while (rest) {
      // Harness metadata lookup: fixed, side-effect-free projection only.
      if (rest.startsWith("text(ALL_TOOLS")) {
        take(/^text\(ALL_TOOLS\.filter\(x=>\/[A-Za-z0-9.*| _-]+\/\.test\(x\.name\+" "\+x\.description\)\)\.map\(x=>\(\{name:x\.name,description:x\.description\.slice\(0,\d+\)\}\)\)\);?/);
        calls.push({ name: "tool_catalog", argument: null });
        continue;
      }
      // A local image result can be displayed without altering tool bindings.
      if (rest.startsWith("const ")) {
        const binding = take(/^const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+tools\.view_image\(/).match(/^const\s+([A-Za-z_$][\w$]*)/)![1]!;
        if (["tools", "text", "image", "ALL_TOOLS"].includes(binding)) return undefined;
        const argument = value();
        take(/^\)\s*;/);
        const display = `image(${binding}.image_url);`;
        if (!rest.startsWith(display)) return undefined;
        rest = rest.slice(display.length).trimStart();
        calls.push({ name: "view_image", argument });
        continue;
      }
      take(/^text\(\s*await\s+tools\./);
      const name = take(/^(?:apply_patch|exec_command|write_stdin)\b/);
      take(/^\(/);
      const argument = value();
      take(/^\)\s*\)\s*;?/);
      if (name === "apply_patch" && typeof argument !== "string") return undefined;
      calls.push({ name, argument });
    }
    return calls.length ? calls : undefined;
  } catch { return undefined; }
}
