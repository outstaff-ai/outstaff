import type { Filed } from "@outstaff/protocol";
import type { FiledWhat, Filing } from "./chat.types.js";

type IssueUrl = (key: string) => string | undefined;
type Attachment = NonNullable<FiledWhat["attached"]>;

const link = (url: string | undefined, text: string) => (url ? `[${text}](${url})` : text);

// Words that say when the work happens: an agent's line with one already tells what the note on running work adds.
const SAYS_WHEN =
  /\b(now|next|after|once|when|later|soon|today|tonight|tomorrow|round|right away|shortly)\b/i;

/** The pull request and ticket the request was added to, as links where they have one. */
function attachedTo(a: Attachment, issueUrl: IssueUrl): string[] {
  const pr = a.pr ? link(a.pr.url, `PR ${a.pr.ref}`) : undefined;
  const ticket = a.ticket ? link(a.ticket.url ?? issueUrl(a.ticket.ref), a.ticket.ref) : undefined;

  return [pr, ticket].filter((x): x is string => Boolean(x));
}

/** That the running work picks the request up later, unless the agent's line already says when. */
function later(filed: Filed, say: string | undefined): string[] {
  if (filed.item.status !== "active" || (say && SAYS_WHEN.test(say))) {
    return [];
  }

  return ["I'll pick it up when the current round ends."];
}

function attachedText(a: Attachment, filed: Filed, issueUrl: IssueUrl, say?: string): string {
  const to = attachedTo(a, issueUrl);
  const first = say ? [say, to.join(" · ")] : [`Adding this to ${to.join(" for ")}.`];

  return [...first, ...later(filed, say)].join(" ");
}

function filedText(what: FiledWhat, filed: Filed, issueUrl: IssueUrl): string {
  if (!what.key) {
    return `On it. Queued: ${what.title}.`;
  }

  const ticket = link(filed.url ?? issueUrl(what.key), what.key);
  return what.say ? `${what.say} ${ticket}` : `On it. Tracked in ${ticket}.`;
}

/**
 * The first line of the acknowledgement: what the request became, after the tag of the requester. The agent's own
 * line leads when it wrote one, followed by the links; otherwise a fixed sentence says it.
 */
export function acknowledgement(what: FiledWhat, filed: Filed, issueUrl: IssueUrl): string {
  if (what.attached) {
    return attachedText(what.attached, filed, issueUrl, what.say);
  }

  return filedText(what, filed, issueUrl);
}

/** "A", "A and B", "A, B and C". */
const listed = (items: string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;

/** The tickets a session filed, in one line: the agent's own lines lead when it wrote any, then the links. */
function ticketsText(filings: Filing[], issueUrl: IssueUrl): string {
  const links = filings.map(({ what, filed }) => link(filed.url ?? issueUrl(what.key!), what.key!));
  const says = [...new Set(filings.flatMap(({ what }) => (what.say ? [what.say] : [])))];
  return says.length
    ? `${says.join(" ")} ${links.join(", ")}`
    : `On it. Tracked in ${listed(links)}.`;
}

/**
 * The whole acknowledgement of a chat session: one reply for everything it filed. One filing reads as
 * `acknowledgement` says; several put the new tickets in one line, the requests queued without a ticket in another,
 * and each piece of existing work a request joined in a line of its own.
 */
export function acknowledgements(filings: Filing[], issueUrl: IssueUrl): string {
  if (filings.length === 1) {
    return acknowledgement(filings[0]!.what, filings[0]!.filed, issueUrl);
  }

  const tickets = filings.filter((f) => !f.what.attached && f.what.key);
  const queued = filings.filter((f) => !f.what.attached && !f.what.key);
  const attached = filings.filter((f) => f.what.attached);

  return [
    ...(tickets.length ? [ticketsText(tickets, issueUrl)] : []),
    ...(queued.length ? [`On it. Queued: ${listed(queued.map((f) => f.what.title))}.`] : []),
    ...attached.map((f) => attachedText(f.what.attached!, f.filed, issueUrl, f.what.say)),
  ].join("\n");
}
