import { splitAtLines } from "@outstaff/core";

/** Slack accepts far more, but long messages collapse behind "show more"; stay well under the 4000 guideline. */
export const SLACK_MAX_LENGTH = 3500;

const FENCE = /^\s*(```|~~~)/;
const TABLE_SEPARATOR = /^\s*\|[\s:|-]+\|\s*$/;

// Control characters mark spans that must survive escaping and emphasis rewriting untouched.
const OPEN = "\u0002";
const CLOSE = "\u0003";
const BOLD = "\u0001";
// oxlint-disable-next-line no-control-regex
const markers = /[\u0001-\u0003]/g;
const stashed = new RegExp(`${OPEN}(\\d+)${CLOSE}`, "g");

export function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function stripEmphasis(text: string): string {
  return text.replaceAll(/\*\*(.+?)\*\*/g, "$1").replaceAll(/__(.+?)__/g, "$1");
}

function inline(raw: string): string {
  const spans: string[] = [];
  const stash = (value: string) => `${OPEN}${spans.push(value) - 1}${CLOSE}`;
  let text = raw.replaceAll(markers, "");

  text = text.replaceAll(/`[^`\n]+`/g, (code) => stash(escapeSlack(code)));
  text = text.replaceAll(
    /!?\[([^\]]*)\]\(\s*<?(https?:\/\/[^\s)>]+|mailto:[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g,
    (_, label: string, url: string) =>
      stash(`<${escapeSlack(url)}|${escapeSlack(stripEmphasis(label) || url)}>`),
  );

  text = text.replaceAll(/<(https?:\/\/[^\s>]+)>/g, (_, url: string) =>
    stash(`<${escapeSlack(url)}>`),
  );

  // A mention of a workspace member, written `<@U123ABC456>` in Markdown.
  text = text.replaceAll(/<@[UW][A-Z0-9]{8,}>/g, (mention) => stash(mention));

  text = escapeSlack(text);

  text = text
    .replaceAll(/\*\*(.+?)\*\*/g, `${BOLD}$1${BOLD}`)
    .replaceAll(/__(.+?)__/g, `${BOLD}$1${BOLD}`)
    .replaceAll(/(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g, "_$1_")
    .replaceAll(/~~(.+?)~~/g, "~$1~")
    .replaceAll(BOLD, "*");

  // A link label can itself hold a stashed code span, so restore until none are left.
  while (text.includes(OPEN)) {
    text = text.replaceAll(stashed, (_, i: string) => spans[Number(i)]!);
  }

  return text;
}

function line(raw: string): string {
  const heading = /^\s{0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(raw);
  if (heading) {
    const title = inline(stripEmphasis(heading[1]!));
    return title ? `*${title}*` : "";
  }

  if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(raw)) {
    return "──────────";
  }

  const quote = /^(\s*)>\s?(.*)$/.exec(raw);
  if (quote) {
    return `${quote[1]}> ${line(quote[2]!)}`;
  }

  const bullet = /^(\s*)[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(raw);
  if (bullet) {
    const box = bullet[2] === undefined ? "" : bullet[2] === " " ? "☐ " : "☑ ";
    return `${bullet[1]}• ${box}${inline(bullet[3]!)}`;
  }

  return inline(raw);
}

function tableToCode(rows: string[]): string[] {
  const cells = rows
    .filter((r) => !TABLE_SEPARATOR.test(r))
    .map((r) =>
      r
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) =>
          stripEmphasis(c.trim())
            .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, "$1")
            .replaceAll("`", ""),
        ),
    );

  const widths: number[] = [];
  for (const row of cells) {
    row.forEach((c, i) => {
      widths[i] = Math.max(widths[i] ?? 0, c.length);
    });
  }

  return [
    "```",
    ...cells.map((row) =>
      escapeSlack(row.map((c, i) => c.padEnd(widths[i]!)).join("  ")).trimEnd(),
    ),
    "```",
  ];
}

const isTableRow = (l: string) => l.trimStart().startsWith("|");

/** The consecutive table rows from line `start` on. */
function tableRows(lines: string[], start: number): string[] {
  const rows: string[] = [];
  for (let i = start; i < lines.length && isTableRow(lines[i]!); i++) {
    rows.push(lines[i]!);
  }

  return rows;
}

/**
 * GitHub-flavoured markdown to Slack mrkdwn: bold, italics, strikethrough, links, headings as bold lines, bullets,
 * quotes, fenced code kept, tables as aligned code blocks (Slack has no tables).
 */
export function toMrkdwn(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  for (let i = 0; i < lines.length; i++) {
    const current = lines[i]!;
    if (FENCE.test(current)) {
      inCode = !inCode;
      out.push("```");
      continue;
    }

    if (inCode) {
      out.push(escapeSlack(current));
      continue;
    }

    if (isTableRow(current) && TABLE_SEPARATOR.test(lines[i + 1] ?? "")) {
      const rows = tableRows(lines, i);
      i += rows.length - 1;
      out.push(...tableToCode(rows));
      continue;
    }

    out.push(line(current));
  }

  return out.join("\n");
}

/** Split mrkdwn at line breaks; a code block cut by the split is closed and reopened so each part renders. */
export function splitMrkdwn(text: string, max = SLACK_MAX_LENGTH): string[] {
  const parts = splitAtLines(text, max - 8);
  let open = false;
  return parts.map((part) => {
    let chunk = open ? `\`\`\`\n${part}` : part;
    for (const l of part.split("\n")) {
      if (FENCE.test(l)) {
        open = !open;
      }
    }

    if (open) {
      chunk += "\n```";
    }

    return chunk;
  });
}
