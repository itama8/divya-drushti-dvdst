import { isAbsolute, join, normalize } from "node:path";

export const BASH_EFFECTS_VERSION = 1;

export interface BashEffect {
  effect: "read" | "mutation";
  /** The command or shell feature that names the path, for example `sed`, `rm`, or `redirect`. */
  via: string;
  /** Absolute, or relative to the directory the command started in. */
  path: string;
}

export interface BashEffects {
  effects: BashEffect[];
  /** Reasons the command may change files that this parser cannot name. */
  opaque: string[];
}

interface Word {
  kind: "word";
  text: string;
  /** The value depends on expansion, so it does not name one known path. */
  dynamic: boolean;
}

interface Operator {
  kind: "op";
  text: string;
}

type Token = Word | Operator;

const HEREDOC = /(?<!<)<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/** Drops heredoc bodies. They are data for the command, not shell syntax. */
function stripHeredocs(command: string): string {
  const kept: string[] = [];
  let delimiter: string | undefined;
  for (const line of command.split("\n")) {
    if (delimiter !== undefined) {
      if (line.trim() === delimiter) delimiter = undefined;
      continue;
    }
    const match = HEREDOC.exec(line);
    if (match === null) {
      kept.push(line);
      continue;
    }
    delimiter = match[2]!;
    kept.push(line.replace(HEREDOC, " "));
  }
  return kept.join("\n");
}

function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let dynamic = false;
  let open = false;
  const flush = (): void => {
    if (open) tokens.push({ kind: "word", text, dynamic });
    text = "";
    dynamic = false;
    open = false;
  };
  const op = (value: string): void => {
    flush();
    tokens.push({ kind: "op", text: value });
  };

  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    const next = command[index + 1];
    if (char === "\\") {
      if (next !== undefined && next !== "\n") text += next;
      open = true;
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      text += command.slice(index + 1, end < 0 ? command.length : end);
      open = true;
      index = end < 0 ? command.length : end + 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      while (index < command.length && command[index] !== '"') {
        if (command[index] === "\\" && index + 1 < command.length) index += 1;
        else if (command[index] === "$" || command[index] === "`") dynamic = true;
        text += command[index];
        index += 1;
      }
      open = true;
      index += 1;
      continue;
    }
    if (char === "`" || (char === "$" && next === "(")) {
      // Keep a command substitution inside its word; its output is unknown.
      const close = char === "`" ? "`" : ")";
      let depth = 0;
      let end = index + (char === "`" ? 1 : 2);
      for (; end < command.length; end += 1) {
        if (close === ")" && command[end] === "(") depth += 1;
        else if (command[end] === close) {
          if (depth === 0) break;
          depth -= 1;
        }
      }
      text += command.slice(index, end + 1);
      dynamic = true;
      open = true;
      index = end + 1;
      continue;
    }
    if (char === " " || char === "\t") {
      flush();
      index += 1;
      continue;
    }
    if (char === "\n" || char === ";") {
      op(";");
      index += 1;
      continue;
    }
    if (char === "&" && next === "&") {
      op(";");
      index += 2;
      continue;
    }
    if (char === "|") {
      op(next === "|" ? ";" : "|");
      index += next === "|" || next === "&" ? 2 : 1;
      continue;
    }
    if (char === "(" || char === ")") {
      op(";");
      index += 1;
      continue;
    }
    if (char === ">" || char === "<" || (char === "&" && next === ">")) {
      // A leading file descriptor such as `2>` belongs to the redirection.
      if (/^\d+$/.test(text)) {
        text = "";
        open = false;
      }
      if (char === "&") index += 1;
      let symbol = command[index]!;
      if (command[index + 1] === symbol) {
        symbol += symbol;
        index += 1;
      }
      index += 1;
      if (command[index] === "&") {
        // `2>&1` duplicates a descriptor and names no file.
        index += 1;
        while (index < command.length && /[\d-]/.test(command[index]!)) index += 1;
        flush();
        continue;
      }
      if (symbol === "<<") {
        // A here-string; its word is data.
        if (command[index] === "<") index += 1;
        op("<<<");
        continue;
      }
      op(symbol);
      continue;
    }
    if (char === "&") {
      op(";");
      index += 1;
      continue;
    }
    if (char === "$" || char === "*" || char === "?" || char === "[" || char === "{" || (char === "~" && !open)) dynamic = true;
    text += char;
    open = true;
    index += 1;
  }
  flush();
  return tokens;
}

const KEYWORDS = new Set(["do", "done", "then", "else", "elif", "fi", "if", "while", "until", "!", "{", "}", "time", "sudo", "command", "nohup", "exec"]);
const READ_VERBS = new Set(["cat", "nl", "wc", "less", "more", "bat", "tac", "sort", "uniq", "cut", "head", "tail", "diff", "cmp", "md5sum", "sha256sum", "xxd", "strings"]);
const SEARCH_VERBS = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);
const INLINE_INTERPRETERS = new Set(["node", "python", "python3", "perl", "ruby", "tsx", "bun", "deno"]);

const VALUE_FLAGS: Record<string, string[]> = {
  head: ["-n", "-c"],
  tail: ["-n", "-c"],
  cut: ["-d", "-f", "-c", "-b"],
  sort: ["-k", "-t", "-o", "-S", "-T"],
  uniq: ["-f", "-s", "-w"],
  sed: ["-e", "-f", "-l"],
  awk: ["-F", "-v", "-f"],
  search: [
    "-e", "-f", "-m", "-A", "-B", "-C", "-g", "-t", "-T", "-M", "-j", "-d", "-r", "-E",
    "--include", "--exclude", "--exclude-dir", "--glob", "--iglob", "--type", "--type-not", "--max-columns", "--max-depth",
    "--max-count", "--replace", "--sort", "--sortr", "--context", "--after-context", "--before-context", "--encoding", "--max-filesize", "--regexp", "--file",
  ],
  jq: ["-f", "--from-file", "--indent", "-L"],
  tee: [],
  truncate: ["-s", "-r"],
  perl: ["-e", "-E", "-I", "-M"],
  ruby: ["-e", "-I", "-r"],
  cp: ["-t", "--target-directory"],
  mv: ["-t", "--target-directory"],
};

interface Parsed {
  flags: string[];
  values: Map<string, string[]>;
  operands: Word[];
}

function parseArguments(words: Word[], valueFlags: string[]): Parsed {
  const flags: string[] = [];
  const values = new Map<string, string[]>();
  const operands: Word[] = [];
  let optionsEnded = false;
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (optionsEnded || !word.text.startsWith("-") || word.text === "-") {
      operands.push(word);
      continue;
    }
    if (word.text === "--") {
      optionsEnded = true;
      flags.push("--");
      continue;
    }
    flags.push(word.text);
    if (valueFlags.includes(word.text) && index + 1 < words.length) {
      index += 1;
      values.set(word.text, [...(values.get(word.text) ?? []), words[index]!.text]);
    }
  }
  return { flags, values, operands };
}

/** A path whose last segment has an extension, so a search operand is a file and not a directory scope. */
function looksLikeFile(path: string): boolean {
  if (path.endsWith("/")) return false;
  const name = path.split("/").pop() ?? "";
  return /^[^.].*\.[A-Za-z0-9]{1,10}$/.test(name) || /^\.[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,10}$/.test(name);
}

function isDevice(path: string): boolean {
  return path.startsWith("/dev/") || path.startsWith("/proc/");
}

/**
 * Names the files a bash command reads and mutates, as far as its text shows.
 *
 * Agents read files with `cat`, `sed -n`, and `rg` and change them with
 * `sed -i`, redirections, and `rm` as often as with the dedicated tools. This
 * parser recovers those paths from the command text. It follows literal `cd`
 * steps, ignores heredoc bodies, and skips any word that needs expansion. A
 * command that may change files it cannot name is reported in `opaque` rather
 * than guessed at. The result is an inference from text: the command may have
 * failed, and a script may touch files the text never mentions.
 */
export function parseBashEffects(command: string): BashEffects {
  const effects: BashEffect[] = [];
  const opaque: string[] = [];
  const seen = new Set<string>();
  /** Directory of the current simple command, relative to where the command started. Undefined after a `cd` that cannot be followed. */
  let base: string | undefined = "";

  const addOpaque = (reason: string): void => {
    if (!opaque.includes(reason)) opaque.push(reason);
  };
  const add = (effect: "read" | "mutation", via: string, word: Word, directory: string | undefined = base): void => {
    if (word.text.length === 0 || word.text === "-") return;
    if (word.dynamic) {
      if (effect === "mutation") addOpaque(`${via} with a computed path`);
      return;
    }
    if (isDevice(word.text)) return;
    let path: string;
    if (isAbsolute(word.text)) path = normalize(word.text);
    else if (directory === undefined) {
      if (effect === "mutation") addOpaque(`${via} after a cd that cannot be followed`);
      return;
    } else path = normalize(join(directory, word.text));
    const key = `${effect}\u0000${via}\u0000${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    effects.push({ effect, via, path });
  };

  const run = (words: Word[]): void => {
    let start = 0;
    while (start < words.length && (KEYWORDS.has(words[start]!.text) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!.text))) start += 1;
    const head = words[start];
    if (head === undefined) return;
    const verb = head.text.split("/").pop() ?? head.text;
    const rest = words.slice(start + 1);

    if (verb === "cd") {
      const target = rest.find((word) => !word.text.startsWith("-"));
      if (target === undefined || target.dynamic || target.text === "-") base = undefined;
      else if (isAbsolute(target.text)) base = normalize(target.text);
      else base = base === undefined ? undefined : normalize(join(base, target.text));
      return;
    }
    if (verb === "timeout" || verb === "env") {
      run(rest.filter((word, index) => !(verb === "timeout" && index === 0)));
      return;
    }
    if ((verb === "bash" || verb === "sh" || verb === "zsh") && rest.some((word) => word.text === "-c")) {
      const script = rest[rest.findIndex((word) => word.text === "-c") + 1];
      if (script === undefined || script.dynamic) addOpaque(`${verb} -c with a computed script`);
      else runScript(script.text);
      return;
    }
    if (verb === "xargs") {
      const inner = rest.map((word) => word.text);
      if (inner.includes("rm") || inner.includes("mv") || (inner.includes("sed") && inner.some((word) => /^(-i|--in-place)/.test(word)))) addOpaque("xargs runs a mutating command");
      return;
    }
    if (verb === "find") {
      if (rest.some((word) => word.text === "-delete" || word.text === "-exec" || word.text === "-execdir")) addOpaque("find runs -delete or -exec");
      return;
    }

    if (READ_VERBS.has(verb)) {
      const parsed = parseArguments(rest, VALUE_FLAGS[verb] ?? []);
      for (const operand of parsed.operands) add("read", verb, operand);
      return;
    }
    if (SEARCH_VERBS.has(verb)) {
      const parsed = parseArguments(rest, VALUE_FLAGS.search!);
      const patternGiven = ["-e", "-f", "--regexp", "--file"].some((flag) => parsed.values.has(flag)) || parsed.flags.includes("--files");
      for (const operand of parsed.operands.slice(patternGiven ? 0 : 1)) {
        if (looksLikeFile(operand.text)) add("read", verb, operand);
      }
      return;
    }
    if (verb === "sed") {
      const parsed = parseArguments(rest, VALUE_FLAGS.sed!);
      const inPlace = parsed.flags.some((flag) => /^-[a-zA-Z]*i/.test(flag) || flag.startsWith("--in-place"));
      const scriptGiven = parsed.values.has("-e") || parsed.values.has("-f");
      for (const operand of parsed.operands.slice(scriptGiven ? 0 : 1)) add(inPlace ? "mutation" : "read", inPlace ? "sed -i" : "sed", operand);
      return;
    }
    if (verb === "awk" || verb === "gawk") {
      const parsed = parseArguments(rest, VALUE_FLAGS.awk!);
      for (const operand of parsed.operands.slice(parsed.values.has("-f") ? 0 : 1)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(operand.text)) add("read", "awk", operand);
      }
      return;
    }
    if (verb === "jq") {
      const operands: Word[] = [];
      let filterGiven = false;
      for (let index = 0; index < rest.length; index += 1) {
        const word = rest[index]!;
        if (word.text === "--args" || word.text === "--jsonargs") break;
        if (word.text === "--arg" || word.text === "--argjson") index += 2;
        else if (word.text === "--slurpfile" || word.text === "--rawfile") {
          if (rest[index + 2] !== undefined) add("read", "jq", rest[index + 2]!);
          index += 2;
        } else if (VALUE_FLAGS.jq!.includes(word.text)) {
          if (word.text === "-f" || word.text === "--from-file") filterGiven = true;
          index += 1;
        } else if (!word.text.startsWith("-") || word.text === "-") operands.push(word);
      }
      for (const operand of operands.slice(filterGiven ? 0 : 1)) add("read", "jq", operand);
      return;
    }
    if (verb === "rm" || verb === "touch" || verb === "truncate" || verb === "tee") {
      for (const operand of parseArguments(rest, VALUE_FLAGS[verb] ?? []).operands) add("mutation", verb, operand);
      return;
    }
    if (verb === "mv" || verb === "cp" || verb === "install") {
      const parsed = parseArguments(rest, VALUE_FLAGS.cp!);
      const sources = parsed.operands.slice(0, -1);
      const destination = parsed.operands.at(-1);
      if (verb === "mv") for (const source of sources) add("mutation", "mv", source);
      // With several sources the last operand is a directory, so the written paths are not named.
      if (destination !== undefined && sources.length === 1 && !parsed.values.has("-t") && looksLikeFile(destination.text)) add("mutation", verb, destination);
      else if (sources.length > 0) addOpaque(`${verb} into a directory`);
      return;
    }
    if (verb === "dd") {
      for (const word of rest) {
        if (word.text.startsWith("of=")) add("mutation", "dd", { ...word, text: word.text.slice(3) });
      }
      return;
    }
    if (verb === "patch") {
      addOpaque("patch applies a diff");
      return;
    }
    if (verb === "git") {
      let directory = base;
      let index = 0;
      while (index < rest.length && rest[index]!.text.startsWith("-")) {
        if (rest[index]!.text === "-C" && rest[index + 1] !== undefined) {
          const target = rest[index + 1]!;
          directory = target.dynamic ? undefined : isAbsolute(target.text) ? normalize(target.text) : directory === undefined ? undefined : normalize(join(directory, target.text));
          index += 2;
        } else if (rest[index]!.text === "-c") index += 2;
        else index += 1;
      }
      const sub = rest[index]?.text;
      const args = rest.slice(index + 1);
      if (sub === "show" || sub === "cat-file") {
        for (const word of args) {
          const colon = word.text.indexOf(":");
          if (!word.text.startsWith("-") && colon > 0 && colon < word.text.length - 1) add("read", `git ${sub}`, { ...word, text: word.text.slice(colon + 1) }, directory);
        }
      } else if (sub === "checkout") {
        const separator = args.findIndex((word) => word.text === "--");
        if (separator < 0) addOpaque("git checkout may rewrite the worktree");
        else for (const word of args.slice(separator + 1)) add("mutation", "git checkout", word, directory);
      } else if (sub === "restore") {
        const parsed = parseArguments(args, ["-s", "--source"]);
        const worktree = parsed.flags.includes("--worktree") || parsed.flags.includes("-W") || !(parsed.flags.includes("--staged") || parsed.flags.includes("-S"));
        if (worktree) for (const operand of parsed.operands) add("mutation", "git restore", operand, directory);
      } else if (sub === "rm" || sub === "mv") {
        const parsed = parseArguments(args, []);
        if (!parsed.flags.includes("--cached")) for (const operand of parsed.operands) add("mutation", `git ${sub}`, operand, directory);
      } else if (sub !== undefined && ["apply", "am", "reset", "stash", "clean", "revert", "merge", "rebase", "cherry-pick", "pull", "switch"].includes(sub)) {
        if (sub !== "reset" || args.some((word) => word.text === "--hard")) addOpaque(`git ${sub} may rewrite the worktree`);
      }
      return;
    }
    if (INLINE_INTERPRETERS.has(verb)) {
      const parsed = parseArguments(rest, VALUE_FLAGS[verb] ?? []);
      const inPlace = (verb === "perl" || verb === "ruby") && parsed.flags.some((flag) => /^-[a-zA-Z]*i/.test(flag));
      if (inPlace) {
        for (const operand of parsed.operands) add("mutation", `${verb} -i`, operand);
        return;
      }
      const inline = rest.some((word) => ["-", "-e", "-E", "-c", "-p", "--eval", "--print"].includes(word.text) || word.text.startsWith("--input-type"));
      if (inline) addOpaque(`inline ${verb} script`);
    }
  };

  function runScript(script: string): void {
    const tokens = tokenize(stripHeredocs(script));
    let words: Word[] = [];
    for (let index = 0; index <= tokens.length; index += 1) {
      const token = tokens[index];
      if (token === undefined || (token.kind === "op" && (token.text === ";" || token.text === "|"))) {
        run(words);
        words = [];
        continue;
      }
      if (token.kind === "word") {
        words.push(token);
        continue;
      }
      const target = tokens[index + 1];
      if (target?.kind !== "word") continue;
      index += 1;
      if (token.text === ">" || token.text === ">>") add("mutation", "redirect", target);
      else if (token.text === "<") add("read", "redirect", target);
    }
  }

  runScript(command);
  return { effects, opaque };
}
