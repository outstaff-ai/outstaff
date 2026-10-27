import type { Link, ChatOrigin } from "@outstaff/protocol";

export const clip = (text: string, maxLines: number) => {
  const lines = text.trim().split("\n");
  return lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : lines.join("\n");
};

/**
 * Lines of one chat message from an agent before it is split into several. An agent's answer is never cut:
 * `messages.max_lines` is guidance in its prompt, and this is the safety cap far above it.
 */
export const REPLY_SAFETY_LINES = 40;

/** Splits a long reply into messages of at most `cap` lines, at paragraph boundaries where it can. Nothing is dropped. */
export function splitReply(text: string, cap = REPLY_SAFETY_LINES): string[] {
  const paragraphs = text.trim().split(/\n{2,}/);
  const parts: string[] = [];
  let current: string[] = [];
  let count = 0;
  const flush = () => {
    if (current.length) {
      parts.push(current.join("\n\n"));
    }

    current = [];
    count = 0;
  };

  for (const paragraph of paragraphs) {
    const lines = paragraph.split("\n");
    if (lines.length > cap) {
      flush();
      for (let i = 0; i < lines.length; i += cap) {
        parts.push(lines.slice(i, i + cap).join("\n"));
      }

      continue;
    }

    // A blank line separates paragraphs inside a message.
    if (count + lines.length + (current.length ? 1 : 0) > cap) {
      flush();
    }

    count += lines.length + (current.length ? 1 : 0);
    current.push(paragraph);
  }

  flush();
  return parts;
}

/** Tags the requester only where it adds a notification: not in a direct message, not in a thread they are in. */
export const tag = (
  origin: Pick<ChatOrigin, "direct" | "participant" | "requester">,
  id = origin.requester.id,
) => (origin.direct || origin.participant ? "" : `<@${id}> `);

export const linkLine = (l: Link) => `- ${l.title ? `${l.title}: ` : ""}${l.url}`;
