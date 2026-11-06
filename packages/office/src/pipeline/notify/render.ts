import type { NoticePr } from "@outstaff/policy";
import type { NoticeEntry, NoticeGroup, NoticeItem } from "./notify.types.js";

/**
 * The agent's words, safe to post: all of them, and no mention that would notify anyone. Chat adapters keep a
 * `<@member>` mention as one, so the text the agent handed back gives up its brackets. The chat adapter splits a
 * message over its platform's limit; the agent is asked to keep it short.
 */
export function guardText(text: string): string {
  return text
    .trim()
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replaceAll(/<([@!#][^>]*)>/g, "$1");
}

/** The pull requests of several notices, each once, in the order they came. */
function unionPrs(entries: readonly NoticeEntry[]): NoticePr[] {
  const seen = new Map<string, NoticePr>();
  for (const pr of entries.flatMap((e) => e.prs)) {
    seen.set(pr.ref, { ...seen.get(pr.ref), ...pr });
  }

  return [...seen.values()];
}

/**
 * A human's notices as the lines of one message: one per ticket (a pull request without a ticket is one of its own),
 * with every pull request named for it, the latest need and the latest text.
 */
export function groupNotices(entries: readonly NoticeEntry[]): NoticeGroup[] {
  const groups = new Map<string, NoticeEntry[]>();
  for (const e of entries) {
    const key = e.ticket ?? `pr:${e.prs[0]?.ref ?? e.event}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }

  return [...groups.values()].map((group) => {
    const latest = group.at(-1)!;
    const text = group.findLast((e) => e.text)?.text;
    return {
      need: latest.need,
      ...(latest.ticket ? { ticket: latest.ticket } : {}),
      prs: unionPrs(group),
      ...(text ? { text } : {}),
    };
  });
}

const link = (label: string, url: string | undefined) => (url ? `[${label}](${url})` : label);

/** A pull request, and the head whose checks passed when the notice waited for them. */
const prText = (p: NoticePr) =>
  `${link(p.ref, p.url)}${p.head ? ` (checks passed on ${p.head.slice(0, 7)})` : ""}`;

const NEED = { review: "Ready for your review", blocked: "Blocked, needs you" } as const;

/**
 * What is needed, and the links: the pull requests first, since the human acts on them, with the ticket they are for
 * after them; the ticket alone when there is none (a blocked ticket).
 */
function itemLine(item: NoticeItem): string {
  const ticket = item.ticket
    ? `${link(item.ticket.key, item.ticket.url)}${item.ticket.title ? ` ${item.ticket.title}` : ""}`
    : "";

  const prs = item.prs.map(prText).join(", ");
  const what = prs
    ? `pull request${item.prs.length > 1 ? "s" : ""} ${prs}${ticket ? `, for ${ticket}` : ""}`
    : ticket;

  return `${NEED[item.need]}: ${what}`;
}

/** An item's lines: the agent's words first, when it gave any, then what is needed with the links. */
function itemLines(item: NoticeItem): string[] {
  const said = item.text ? guardText(item.text) : "";
  return [...(said ? said.split("\n") : []), itemLine(item)];
}

/** An item as an entry of a list: its first line bulleted, the others indented under it. */
const listed = (lines: string[]) => lines.map((l, i) => (i === 0 ? `- ${l}` : l ? `  ${l}` : l));

/** The direct message: one item as the agent's words and a line with its links; several as a list. */
export function renderNotice(items: readonly NoticeItem[]): string {
  if (items.length === 1) {
    return itemLines(items[0]!).join("\n");
  }

  return ["Waiting for you:", ...items.flatMap((item) => listed(itemLines(item)))].join("\n");
}
