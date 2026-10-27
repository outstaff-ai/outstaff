import type { TeamConfig } from "../config/types.js";
import type { Tracker } from "../ports/tracker.js";
import { host, rewrite } from "./ticket-rewrite.js";
import type {
  LinkTemplate,
  TicketLinker,
  TicketLinkerOptions,
  TicketLinking,
  TicketSurface,
} from "./types.js";

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
function template(build: (id: string) => string): LinkTemplate | undefined {
  const probe = build("\u0001");
  const at = probe.indexOf("%01");
  return at < 0 ? undefined : { prefix: probe.slice(0, at), suffix: probe.slice(at + 3) };
}

const escapeRegExp = (s: string) => s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

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

  const linking = linkingFor(tracker, keys, options);

  return {
    format(text, surface) {
      return formatText(linking, text, surface);
    },
  };
}

function linkingFor(
  tracker: Pick<Tracker, "links">,
  keys: string[],
  { knowledge, flag }: TicketLinkerOptions,
): TicketLinking {
  const key = `(?:${keys.map(escapeRegExp).join("|")})-\\d+`;
  const hosts = [host(tracker.links.issue("ACME-1")), knowledge && host(knowledge.links.doc("1"))];

  return {
    tracker,
    key,
    exactKey: new RegExp(`^${key}$`, "i"),
    hosts: new Set(hosts.filter((h): h is string => Boolean(h))),
    docTemplate: knowledge ? template(knowledge.links.doc) : undefined,
    issueTemplate: template(tracker.links.issue),
    anchored: hasCommentAnchors(tracker),
    flag,
  };
}

function hasCommentAnchors(tracker: Pick<Tracker, "links">): boolean {
  const comment = tracker.links.comment;

  return comment ? comment("ACME-1", "1") !== tracker.links.issue("ACME-1") : false;
}

/** Fenced code blocks pass through untouched; the text between them is rewritten. */
function formatText(l: TicketLinking, text: string, surface: TicketSurface): string {
  if (!/[a-z]/i.test(text)) {
    return text;
  }

  const out: string[] = [];
  let plain: string[] = [];
  let fence: { char: string; size: number } | undefined;
  const flush = () => {
    if (plain.length > 0) {
      out.push(rewrite(l, plain.join("\n"), surface !== "host"));
      plain = [];
    }
  };

  for (const line of text.split("\n")) {
    const m = FENCE.exec(line);
    if (fence) {
      out.push(line);
      fence = closesFence(fence, m, line) ? undefined : fence;
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
}

/** Whether a line closes the open fence: the same character, at least as many, and nothing after. */
function closesFence(
  fence: { char: string; size: number },
  m: RegExpExecArray | null,
  line: string,
): boolean {
  return (
    m !== null &&
    m[1]![0] === fence.char &&
    m[1]!.length >= fence.size &&
    /^\s*$/.test(line.slice(m[0].length))
  );
}
