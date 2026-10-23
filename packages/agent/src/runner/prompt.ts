import type { Offer } from "../office-client/index.js";

/** The user prompt of a run, from what the office sent with the offer. */
export function buildWorkPrompt(offer: Offer, opts: { resumed: boolean }): string {
  const { workItem: item, context } = offer;
  const lines = [
    `Work item ${item.id} (${item.kind}): ${item.title}`,
    `Started by: ${item.trigger}.`,
  ];

  if (item.parentId) {
    lines.push(`It was split from work item ${item.parentId}.`);
  }

  if (context.subjects.length) {
    lines.push("", "Concerns:");
    for (const s of context.subjects) {
      const title = s.title ? ` ${s.title}` : "";
      const url = s.url ? ` (${s.url})` : "";
      lines.push(`- ${s.type} ${s.ref}${title}${url}`);
    }
  }

  if (context.links.length) {
    lines.push("", "Links:");
    for (const l of context.links) {
      lines.push(`- ${l.title ? `${l.title}: ` : ""}${l.url}`);
    }
  }

  if (context.journal.length) {
    lines.push("", "Journal of earlier rounds:");
    for (const j of context.journal) {
      lines.push(`- ${j.at} ${j.author}: ${j.text}`);
    }
  }

  lines.push(
    "",
    opts.resumed
      ? "This continues your earlier session on this item. Check the current state before you carry on, since things may have changed since you stopped."
      : "Start from the state above and what you can read with your tools.",
    `Work only on this item. Pass work item ${item.id} where a tool asks for it. When you stop, your last message is the hand-back summary.`,
  );

  return lines.join("\n");
}
