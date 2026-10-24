import type { Link } from "@outstaff/protocol";

/** Asked in the item's own session once the work is done, so the entry comes from what the agent actually knows. */
export const JOURNAL_PROMPT = [
  "Write the journal entry for this round of the work item. Do not use any tool and do not do more work.",
  "Reply with exactly these four lines and nothing else, each on one line:",
  "Done: what you did this round.",
  "Decisions: what you decided and why, or none.",
  "Open: what is still open or what you wait for, or none.",
  "Links: the pull requests, documents and tickets involved, or none.",
].join("\n");

const MAX_ENTRY = 1500;
const FIELDS = ["Done", "Decisions", "Open", "Links"] as const;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/**
 * The entry from the runtime's answer when it follows the format. Otherwise one built from the final message and its
 * links, so a hand-back never goes without an entry.
 */
export function journalEntry(answer: string | undefined, finalText: string, links: Link[]): string {
  if (answer) {
    const lines = answer.split("\n").map((l) => l.trim());
    const found = FIELDS.map((f) =>
      lines.find((l) => l.toLowerCase().startsWith(`${f.toLowerCase()}:`)),
    );

    if (found.every((l) => l !== undefined && l.slice(l.indexOf(":") + 1).trim() !== "")) {
      return clip(found.join("\n"), MAX_ENTRY);
    }
  }

  return clip(
    [
      `Done: ${finalText.trim().replaceAll(/\s*\n\s*/g, " ") || "no message"}`,
      "Decisions: not recorded",
      "Open: not recorded",
      `Links: ${links.length > 0 ? links.map((l) => l.url).join(" ") : "none"}`,
    ].join("\n"),
    MAX_ENTRY,
  );
}
