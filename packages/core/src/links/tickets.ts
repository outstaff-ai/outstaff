import type { TeamConfig } from "../config/schema.js";
import type { Tracker } from "../ports/tracker.js";

/**
 * Where the text goes. "chat" and "tracker" surfaces do not link by themselves, so bare keys are linked. On the
 * "host" (code host) GitHub links keys through the repository's autolinks, so only wrong links are rewritten.
 */
export type TicketSurface = "chat" | "tracker" | "host";

export interface TicketLinker {
  /** `text` with the team's ticket keys linked to the tracker. Text is returned as is when there is nothing to link. */
  format(text: string, surface: TicketSurface): string;
}

const NONE: TicketLinker = { format: (text) => text };

/** Project keys from the tracker integration's `project` option: a string, or a list; `<team>.<KEY>` is the key `KEY`. */
export function ticketProjectKeys(team: Partial<Pick<TeamConfig, "integrations">>): string[] {
  const raw = (team.integrations?.tracker as { project?: unknown } | undefined)?.project;
  const list = Array.isArray(raw) ? raw : [raw];
  const keys = list.flatMap((p) =>
    typeof p === "string" && p.trim() ? [p.trim().split(".").pop()!.toUpperCase()] : [],
  );

  return [...new Set(keys.filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k)))];
}

const escapeRegExp = (s: string) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/**
 * Builds the one formatter outgoing agent text goes through, so ticket links come from code and never from the
 * model: bare keys of the team's project(s) are linked with `tracker.links.issue`, and a Markdown link whose text
 * is such a key but whose URL is not the tracker's is rewritten to it. Code, URLs and email addresses are left
 * alone. Without a tracker or a project key nothing is linked.
 */
export function createTicketLinker(
  team: Partial<Pick<TeamConfig, "integrations">>,
  tracker: Pick<Tracker, "links"> | undefined,
): TicketLinker {
  const keys = ticketProjectKeys(team);
  if (!tracker || keys.length === 0) {
    return NONE;
  }

  const key = `(?:${keys.map(escapeRegExp).join("|")})-\\d+`;
  const keyOnly = new RegExp(`^${key}$`, "i");

  // In order of precedence: inline code, Markdown link or image, autolink, URL, email address, bare key.
  const spans = (bare: boolean) =>
    new RegExp(
      [
        "(`+)[^]*?\\1(?!`)",
        String.raw`(?<image>!?)\[(?<label>[^\]\n]*)\]\((?<url>[^)\s]*)(?:\s+"[^"]*")?\)`,
        "<(?:https?|mailto):[^\\s>]*>",
        String.raw`https?://[^\s<>)\]]+`,
        String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`,
        ...(bare ? [`(?<![\\w/#@.-])(?<found>${key})(?![\\w-])`] : []),
      ].join("|"),
      "gi",
    );

  const rewrite = (text: string, bare: boolean) =>
    text.replace(spans(bare), (...args: unknown[]) => {
      const whole = args[0] as string;
      const { image, label, url, found } = args.at(-1) as Record<string, string | undefined>;
      if (label !== undefined) {
        if (image || !keyOnly.test(label.trim())) {
          return whole;
        }

        const ref = label.trim().toUpperCase();
        const target = tracker.links.issue(ref);
        return url === target ? whole : `[${ref}](${target})`;
      }

      // Bare keys are matched case-insensitively by the shared flag; only upper case ones are ticket keys.
      return found !== undefined && found === found.toUpperCase()
        ? `[${found}](${tracker.links.issue(found)})`
        : whole;
    });

  return {
    format(text, surface) {
      if (!/[a-z]/i.test(text)) {
        return text;
      }

      // Fenced code blocks pass through untouched; the text between them is rewritten.
      const out: string[] = [];
      let plain: string[] = [];
      let fence: { char: string; size: number } | undefined;
      const flush = () => {
        if (plain.length > 0) {
          out.push(rewrite(plain.join("\n"), surface !== "host"));
          plain = [];
        }
      };

      for (const line of text.split("\n")) {
        const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (fence) {
          out.push(line);
          if (
            m &&
            m[1]![0] === fence.char &&
            m[1]!.length >= fence.size &&
            /^\s*$/.test(line.slice(m[0].length))
          ) {
            fence = undefined;
          }
        } else if (m) {
          flush();
          out.push(line);
          fence = { char: m[1]![0]!, size: m[1]!.length };
        } else {
          plain.push(line);
        }
      }

      flush();
      return out.join("\n");
    },
  };
}
