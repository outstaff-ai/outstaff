import { PortError, type TeamConfig } from "@outstaff/core";
import type { MentionGuard } from "./types.js";

// A mention starts at an "@" that no word character, dot, slash, dash or "@" precedes (so not an email address, a URL
// or a path), names a login, and is not continued by a word character or "@" (so not "@scope/pkg" or "a@b@c").
// Apps show up as "name[bot]".
const MENTION = /(?<![\w.\-/@\\])@([A-Za-z0-9][A-Za-z0-9_-]{0,38}(?:\[bot\])?)(?![\w@/-])/g;

/** Spans of `text` that render as code on the host, where an "@" mentions nobody: fenced blocks and inline spans. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const lines = text.split("\n");
  let offset = 0;
  let fence: { char: string; size: number; start: number } | undefined;
  const plain: [number, number][] = [];
  let plainStart = 0;
  for (const line of lines) {
    const end = offset + line.length;
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        m &&
        m[1]![0] === fence.char &&
        m[1]!.length >= fence.size &&
        /^\s*$/.test(line.slice(m[0].length))
      ) {
        ranges.push([fence.start, end]);
        fence = undefined;
        plainStart = end + 1;
      }
    } else if (m) {
      plain.push([plainStart, offset]);
      fence = { char: m[1]![0]!, size: m[1]!.length, start: offset };
    }

    offset = end + 1;
  }

  if (fence) {
    ranges.push([fence.start, text.length]);
  } else {
    plain.push([plainStart, text.length]);
  }

  // Inline code in the text outside fences: a run of backticks closes at the next run of the same length.
  for (const [from, to] of plain) {
    const part = text.slice(from, to);
    for (const m of part.matchAll(/(?<!`)(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g)) {
      ranges.push([from + m.index, from + m.index + m[0].length]);
    }
  }

  return ranges;
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

  const teammates = new Map<string, string>();
  for (const p of team.people) {
    const first = p.name.trim().split(/\s+/)[0] ?? p.handle;
    for (const key of [p.handle, p.name.trim(), p.identities?.vcs]) {
      if (key && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(stripBot(key))) {
        teammates.set(norm(stripBot(key)), first);
      }
    }

    teammates.set(norm(first), first);
  }

  const humanNames = (team.humans ?? []).flatMap((h) =>
    h.identities.vcs ? [`@${h.identities.vcs}`] : [],
  );

  return {
    apply(text) {
      if (!text.includes("@")) {
        return text;
      }

      const code = codeRanges(text);
      const refused = new Set<string>();
      const out = text.replace(MENTION, (whole, login: string, at: number) => {
        if (code.some(([from, to]) => at >= from && at < to)) {
          return whole;
        }

        const key = norm(login);
        if (humans.has(key) || humans.has(norm(stripBot(login)))) {
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
        throw new PortError(
          "invalid",
          `The text mentions ${[...refused].join(", ")}, which ${refused.size === 1 ? "is" : "are"} not a configured human's code-host username, so on the code host it would notify an unrelated user. Write the name without "@" (for a teammate, reach them with \`ost ask\`)${humanNames.length > 0 ? `; humans you may mention: ${humanNames.join(", ")}` : ""}. Put code such as @scope/package in backticks.`,
        );
      }

      return out;
    },
  };
}
