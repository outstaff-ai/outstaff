import type { NoticePr } from "@outstaff/policy";
import type { NoticeEntry, NoticeGroup, NoticeItem } from "./notify.types.js";

const MAX_LINES = 2;
const MAX_CHARS = 300;

/**
 * The agent's words, safe to post: its first lines, and no mention that would notify anyone. Chat adapters keep a
 * `<@member>` mention as one, so the text the agent handed back gives up its brackets.
 */
export function guardText(text: string): string {
  const lines = text
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, MAX_LINES)
    .join("\n")
    .replaceAll(/<([@!#][^>]*)>/g, "$1");

  return lines.length > MAX_CHARS ? `${lines.slice(0, MAX_CHARS - 1)}…` : lines;
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

const NEED = { review: "Ready for your review", blocked: "Blocked, needs you" } as const;

function itemLine(item: NoticeItem): string {
  const ticket = item.ticket
    ? `${link(item.ticket.key, item.ticket.url)}${item.ticket.title ? ` ${item.ticket.title}` : ""}`
    : "";

  const prs = item.prs.map((p) => link(p.ref, p.url)).join(", ");
  const what = [ticket, prs ? `pull request ${prs}` : ""].filter(Boolean).join(", ");
  return `${NEED[item.need]}: ${what}`;
}

/** The direct message: one item as a line and its text; several as a list. */
export function renderNotice(items: readonly NoticeItem[]): string {
  const text = (item: NoticeItem) => (item.text ? guardText(item.text) : "");
  if (items.length === 1) {
    const only = items[0]!;
    return [itemLine(only), text(only)].filter(Boolean).join("\n");
  }

  return [
    "Waiting for you:",
    ...items.flatMap((item) => {
      const said = text(item);
      return [`- ${itemLine(item)}`, ...(said ? said.split("\n").map((l) => `  ${l}`) : [])];
    }),
  ].join("\n");
}
