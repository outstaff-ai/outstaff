import type { TicketLinking } from "./types.js";

/** A URL as found in text, and its parts: without trailing punctuation, without query and fragment, the punctuation. */
type Found = { raw: string; url: string; bare: string; trail: string };

export function host(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Rewrites the links and, when `bare`, links the bare keys of a stretch of text outside fenced code. */
export function rewrite(l: TicketLinking, text: string, bare: boolean): string {
  return text.replace(spans(l.key, bare), (...args: unknown[]) =>
    replaceSpan(l, args[0] as string, args.at(-1) as Record<string, string | undefined>),
  );
}

/** In order of precedence: inline code, Markdown link or image, autolink, URL, email address, bare key. */
function spans(key: string, bare: boolean): RegExp {
  return new RegExp(
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
}

function replaceSpan(
  l: TicketLinking,
  whole: string,
  { image, label, url, found, auto }: Record<string, string | undefined>,
): string {
  if (auto !== undefined) {
    return auto.startsWith("http") ? `<${guard(l, auto)}>` : whole;
  }

  if (label !== undefined) {
    return image ? whole : markdownLink(l, whole, label, url);
  }

  if (found === undefined && whole.startsWith("http")) {
    return guard(l, whole);
  }

  return bareKey(l, whole, found);
}

/** A Markdown link whose text is a ticket key points at that ticket; any other has its URL guarded. */
function markdownLink(
  l: TicketLinking,
  whole: string,
  label: string,
  url: string | undefined,
): string {
  if (!l.exactKey.test(label.trim())) {
    const next = guard(l, url ?? "");
    return next === url ? whole : whole.replace(`(${url}`, `(${next}`);
  }

  const ref = label.trim().toUpperCase();
  const target = l.tracker.links.issue(ref);
  return url === target ? whole : `[${ref}](${target})`;
}

/** Bare keys are matched case-insensitively by the shared flag; only upper case ones are ticket keys. */
function bareKey(l: TicketLinking, whole: string, found: string | undefined): string {
  return found !== undefined && found === found.toUpperCase()
    ? `[${found}](${l.tracker.links.issue(found)})`
    : whole;
}

/**
 * Guards a URL on the tracker's or knowledge host: one that is not a known link is replaced with the canonical
 * link of the ticket it names, or flagged when it names none. A fragment on an issue link is dropped when the
 * tracker has no comment anchors.
 */
function guard(l: TicketLinking, raw: string): string {
  const f = splitUrl(raw);
  const h = host(f.url);
  if (!h || !l.hosts.has(h)) {
    return raw;
  }

  if (l.docTemplate && f.bare.startsWith(l.docTemplate.prefix)) {
    return raw;
  }

  return issueLink(l, f) ?? namedTicket(l, f) ?? flagged(l, h, f);
}

function splitUrl(raw: string): Found {
  const trail = /[.,;:!?]+$/.exec(raw)?.[0] ?? "";
  const url = trail ? raw.slice(0, -trail.length) : raw;

  return { raw, url, bare: url.replace(/[#?].*$/, ""), trail };
}

/** An issue link of the tracker's template: kept when canonical, else replaced with the canonical one. */
function issueLink(l: TicketLinking, { raw, url, bare, trail }: Found): string | undefined {
  if (!l.issueTemplate || !bare.startsWith(l.issueTemplate.prefix)) {
    return undefined;
  }

  const id = decodeURIComponent(bare.slice(l.issueTemplate.prefix.length).split("/")[0] ?? "");
  if (!l.exactKey.test(id)) {
    return undefined;
  }

  const canonical = l.tracker.links.issue(id.toUpperCase());
  return bare === canonical && (l.anchored || url === bare) ? raw : `${canonical}${trail}`;
}

/** Any other link whose path names a ticket key becomes that ticket's link. */
function namedTicket(l: TicketLinking, { url, trail }: Found): string | undefined {
  const named = new URL(url).pathname
    .split("/")
    .map((seg) => decodeURIComponent(seg))
    .find((seg) => l.exactKey.test(seg));

  return named ? `${l.tracker.links.issue(named.toUpperCase())}${trail}` : undefined;
}

function flagged(l: TicketLinking, h: string, { raw, url }: Found): string {
  l.flag?.(`Link not built by outstaff on ${h}: ${url}`);
  return raw;
}
