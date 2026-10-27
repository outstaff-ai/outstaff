import type { TeamConfig } from "../config/types.js";
import type { Tracker } from "../ports/tracker.js";
import type { TicketLinker, TicketLinkerOptions } from "./types.js";

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

/** A URL split around the id a link template put in: `{prefix}<id>{suffix}`. */
function template(build: (id: string) => string): { prefix: string; suffix: string } | undefined {
  const probe = build("\u0001");
  const at = probe.indexOf("%01");
  return at < 0 ? undefined : { prefix: probe.slice(0, at), suffix: probe.slice(at + 3) };
}

function host(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
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
  options: TicketLinkerOptions = {},
): TicketLinker {
  const keys = ticketProjectKeys(team);
  if (!tracker || keys.length === 0) {
    return NONE;
  }

  const key = `(?:${keys.map(escapeRegExp).join("|")})-\\d+`;
  const keyOnly = new RegExp(`^${key}$`, "i");

  const hosts = new Set<string>();
  const trackerHost = host(tracker.links.issue("ACME-1"));
  if (trackerHost) {
    hosts.add(trackerHost);
  }

  const knowledgeHost = options.knowledge ? host(options.knowledge.links.doc("1")) : undefined;
  if (knowledgeHost) {
    hosts.add(knowledgeHost);
  }

  const docTemplate = options.knowledge ? template(options.knowledge.links.doc) : undefined;
  const issueTemplate = template(tracker.links.issue);

  /** Whether the tracker's comment links carry an anchor of their own, so a fragment on an issue link can be real. */
  const anchored = tracker.links.comment
    ? tracker.links.comment("ACME-1", "1") !== tracker.links.issue("ACME-1")
    : false;

  const exactKey = new RegExp(`^${key}$`, "i");

  /**
   * Guards a URL on the tracker's or knowledge host: one that is not a known link is replaced with the canonical
   * link of the ticket it names, or flagged when it names none. A fragment on an issue link is dropped when the
   * tracker has no comment anchors.
   */
  const guard = (raw: string): string => {
    const trail = /[.,;:!?]+$/.exec(raw)?.[0] ?? "";
    const url = trail ? raw.slice(0, -trail.length) : raw;
    const h = host(url);
    if (!h || !hosts.has(h)) {
      return raw;
    }

    const bare = url.replace(/[#?].*$/, "");
    if (docTemplate && bare.startsWith(docTemplate.prefix)) {
      return raw;
    }

    if (issueTemplate && bare.startsWith(issueTemplate.prefix)) {
      const id = decodeURIComponent(bare.slice(issueTemplate.prefix.length).split("/")[0] ?? "");
      if (exactKey.test(id)) {
        const canonical = tracker.links.issue(id.toUpperCase());
        const exact = bare === canonical;
        return exact && (anchored || url === bare) ? raw : `${canonical}${trail}`;
      }
    }

    const named = new URL(url).pathname
      .split("/")
      .map((seg) => decodeURIComponent(seg))
      .find((seg) => exactKey.test(seg));

    if (named) {
      return `${tracker.links.issue(named.toUpperCase())}${trail}`;
    }

    options.flag?.(`Link not built by outstaff on ${h}: ${url}`);
    return raw;
  };

  // In order of precedence: inline code, Markdown link or image, autolink, URL, email address, bare key.
  const spans = (bare: boolean) =>
    new RegExp(
      [
        "(`+)[^]*?\\1(?!`)",
        String.raw`(?<image>!?)\[(?<label>[^\]\n]*)\]\((?<url>[^)\s]*)(?:\s+"[^"]*")?\)`,
        "<(?<auto>https?:[^\\s>]*|mailto:[^\\s>]*)>",
        String.raw`https?://[^\s<>)\]]+`,
        String.raw`[\w.+-]+@[\w-]+(?:\.[\w-]+)+`,
        ...(bare ? [`(?<![\\w/#@.-])(?<found>${key})(?![\\w-])`] : []),
      ].join("|"),
      "gi",
    );

  const rewrite = (text: string, bare: boolean) =>
    text.replace(spans(bare), (...args: unknown[]) => {
      const whole = args[0] as string;
      const { image, label, url, found, auto } = args.at(-1) as Record<string, string | undefined>;
      if (auto !== undefined) {
        return auto.startsWith("http") ? `<${guard(auto)}>` : whole;
      }

      if (label !== undefined) {
        if (image) {
          return whole;
        }

        if (!keyOnly.test(label.trim())) {
          const next = guard(url ?? "");
          return next === url ? whole : whole.replace(`(${url}`, `(${next}`);
        }

        const ref = label.trim().toUpperCase();
        const target = tracker.links.issue(ref);
        return url === target ? whole : `[${ref}](${target})`;
      }

      if (found === undefined && whole.startsWith("http")) {
        return guard(whole);
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
