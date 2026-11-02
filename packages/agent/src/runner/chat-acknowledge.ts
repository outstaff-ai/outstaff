import type { Filed } from "@outstaff/protocol";
import type { FiledWhat } from "./chat.types.js";

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
