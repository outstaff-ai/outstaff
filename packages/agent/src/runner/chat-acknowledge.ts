import type { Filed } from "@outstaff/protocol";
import type { FiledWhat } from "./chat.types.js";

type IssueUrl = (key: string) => string | undefined;
type Attachment = NonNullable<FiledWhat["attached"]>;

const link = (url: string | undefined, text: string) => (url ? `[${text}](${url})` : text);

/** The pull request and ticket the request was added to, as links where they have one. */
function attachedTo(a: Attachment, issueUrl: IssueUrl): string[] {
  const pr = a.pr ? link(a.pr.url, `PR ${a.pr.ref}`) : undefined;
  const ticket = a.ticket ? link(a.ticket.url ?? issueUrl(a.ticket.ref), a.ticket.ref) : undefined;

  return [pr, ticket].filter((x): x is string => Boolean(x));
}

function attachedText(a: Attachment, filed: Filed, issueUrl: IssueUrl): string {
  const later =
    filed.item.status === "active" ? " I'll pick it up when the current round ends." : "";

  return `Adding this to ${attachedTo(a, issueUrl).join(" for ")}.${later}`;
}

function filedText(what: FiledWhat, filed: Filed, issueUrl: IssueUrl): string {
  if (!what.key) {
    return `Queued: ${what.title}.`;
  }

  const url = filed.url ?? issueUrl(what.key);

  return `Tracked in ${url ? `[${what.key}](${url})` : what.key}.`;
}

/** The first line of the acknowledgement: what the request became, after the tag of the requester. */
export function acknowledgement(what: FiledWhat, filed: Filed, issueUrl: IssueUrl): string {
  if (what.attached) {
    return attachedText(what.attached, filed, issueUrl);
  }

  return `On it. ${filedText(what, filed, issueUrl)}`;
}
