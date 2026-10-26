/**
 * The `@name` mentions in a comment body, in the order they first appear, without the `@`. A name is letters, digits
 * and `. _ -` (a tracker handle); it does not start inside a word (`dana@acme.example`) or continue into a path
 * (`@scope/package`), and trailing punctuation is not part of it. Text in backticks is code and mentions nobody.
 */
export function parseMentions(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const prose = text.replaceAll(/```[\s\S]*?```|`[^`\n]*`/g, " ");
  for (const m of prose.matchAll(/(?<![\w@/.`-])@([A-Za-z0-9][A-Za-z0-9._-]*)(?![\w/@])/g)) {
    const name = m[1]!.replace(/[._-]+$/, "");
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }

  return out;
}

/** `{ mentions: [...] }` for an event's data when the body mentions anyone, else nothing. */
export function mentionData(text: string | null | undefined): { mentions?: string[] } {
  const found = text ? parseMentions(text) : [];
  return found.length > 0 ? { mentions: found } : {};
}
