import type { PrRef } from "@outstaff/core";

const CLIP = 80;

/** Keeps a free-text value short enough for a log line; bodies and error messages can hold anything. */
export function clip(text: string, max = CLIP): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export const prLabel = (pr: Pick<PrRef, "repo" | "number">): string =>
  `${pr.repo.owner}/${pr.repo.name}#${pr.number}`;

/** `owner/name#n` for a pull request, the key for a ticket, `doc <id>` for a document. */
export function subjectLabel(subject: { pr?: PrRef; ticket?: string; doc?: string }): string {
  return subject.pr
    ? prLabel(subject.pr)
    : (subject.ticket ?? (subject.doc ? `doc ${subject.doc}` : "no subject"));
}
