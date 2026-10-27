import { PortError, type TeamConfig } from "@outstaff/core";
import type { MentionGuard } from "./types.js";

// A mention starts at an "@" that no word character, dot, slash, dash or "@" precedes (so not an email address, a URL
// or a path), names a login, and is not continued by a word character or "@" (so not "@scope/pkg" or "a@b@c").
// Apps show up as "name[bot]".
const MENTION = /(?<![\w.\-/@\\])@([A-Za-z0-9][A-Za-z0-9_-]{0,38}(?:\[bot\])?)(?![\w@/-])/g;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** An open fenced code block: its character, the length of its opening run, and where it starts. */
type Fence = { char: string; size: number; start: number };

/** The fence `line` opens, if it starts with three or more backticks or tildes. */
function openFence(line: string, start: number): Fence | undefined {
  const m = FENCE.exec(line);
  return m ? { char: m[1]![0]!, size: m[1]!.length, start } : undefined;
}

/** Whether `line` closes `fence`: a run of the same character, at least as long, then nothing but spaces. */
function closesFence(line: string, fence: Fence): boolean {
  const m = FENCE.exec(line);
  return (
    !!m &&
    m[1]![0] === fence.char &&
    m[1]!.length >= fence.size &&
    /^\s*$/.test(line.slice(m[0].length))
  );
}

/** Spans of `text` inside fenced code blocks (`code`) and the spans between them (`plain`). */
function splitFences(text: string): { code: [number, number][]; plain: [number, number][] } {
  const code: [number, number][] = [];
  const plain: [number, number][] = [];
  let offset = 0;
  let fence: Fence | undefined;
  let plainStart = 0;
  for (const line of text.split("\n")) {
    const end = offset + line.length;
    if (!fence) {
      fence = openFence(line, offset);
      if (fence) {
        plain.push([plainStart, offset]);
      }
    } else if (closesFence(line, fence)) {
      code.push([fence.start, end]);
      fence = undefined;
      plainStart = end + 1;
    }

    offset = end + 1;
  }

  if (fence) {
    code.push([fence.start, text.length]);
  } else {
    plain.push([plainStart, text.length]);
  }

  return { code, plain };
}

/** Inline code spans in the given parts of `text`: a run of backticks closes at the next run of the same length. */
function inlineCodeRanges(text: string, parts: [number, number][]): [number, number][] {
  return parts.flatMap(([from, to]) =>
    [...text.slice(from, to).matchAll(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)].map(
      (m): [number, number] => [from + m.index, from + m.index + m[0].length],
    ),
  );
}

/** Spans of `text` that render as code on the host, where an "@" mentions nobody: fenced blocks and inline spans. */
function codeRanges(text: string): [number, number][] {
  const { code, plain } = splitFences(text);
  return [...code, ...inlineCodeRanges(text, plain)];
}

const norm = (s: string) => s.toLowerCase();
const stripBot = (s: string) => s.replace(/\[bot\]$/i, "");

/**
 * On the code host an "@login" notifies whoever owns that username, and a teammate's handle is not their username
 * there: it reaches a stranger. So `@sam` for the teammate sam becomes "Sam", a configured human's `identities.vcs`
 * stays a mention, and any other login is refused.
 */
export function mentionGuard(team: TeamConfig): MentionGuard {
  const humans = new Set(
    (team.humans ?? []).flatMap((h) => (h.identities.vcs ? [norm(h.identities.vcs)] : [])),
  );

  const teammates = teammateNames(team);
  const humanNames = (team.humans ?? []).flatMap((h) =>
    h.identities.vcs ? [`@${h.identities.vcs}`] : [],
  );

  const isHuman = (login: string) => humans.has(norm(login)) || humans.has(norm(stripBot(login)));

  return {
    apply(text) {
      if (!text.includes("@")) {
        return text;
      }

      const code = codeRanges(text);
      const inCode = (at: number) => code.some(([from, to]) => at >= from && at < to);
      const refused = new Set<string>();
      const out = text.replace(MENTION, (whole, login: string, at: number) => {
        if (inCode(at) || isHuman(login)) {
          return whole;
        }

        const name = teammates.get(norm(stripBot(login)));
        if (name !== undefined) {
          return name;
        }

        refused.add(`@${login}`);
        return whole;
      });

      if (refused.size > 0) {
        throw refusedMentions(refused, humanNames);
      }

      return out;
    },
  };
}

/** Every login-shaped key a teammate goes by (handle, name, code-host login, first name), mapped to the first name. */
function teammateNames(team: TeamConfig): Map<string, string> {
  const teammates = new Map<string, string>();
  for (const p of team.people) {
    const first = p.name.trim().split(/\s+/)[0] ?? p.handle;
    const keys = [p.handle, p.name.trim(), p.identities?.vcs].filter(
      (key): key is string => !!key && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(stripBot(key)),
    );

    for (const key of keys) {
      teammates.set(norm(stripBot(key)), first);
    }

    teammates.set(norm(first), first);
  }

  return teammates;
}

function refusedMentions(refused: Set<string>, humanNames: string[]): PortError {
  const verb = refused.size === 1 ? "is" : "are";
  const mentionable =
    humanNames.length > 0 ? `; humans you may mention: ${humanNames.join(", ")}` : "";

  return new PortError(
    "invalid",
    `The text mentions ${[...refused].join(", ")}, which ${verb} not a configured human's code-host username, so on the code host it would notify an unrelated user. Write the name without "@" (for a teammate, reach them with \`ost ask\`)${mentionable}. Put code such as @scope/package in backticks.`,
  );
}
