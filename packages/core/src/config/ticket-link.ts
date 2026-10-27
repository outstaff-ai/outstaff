/** A ticket key such as ACME-12. */
export const TICKET_KEY = "[A-Za-z][A-Za-z0-9]{1,9}-\\d+";

/**
 * Compiles a `ticket_link` pattern: a regular expression with one `{key}` placeholder, matched
 * case-insensitively; the key is the group `key`. Returns the reason when the pattern is unusable.
 */
export function compileTicketLink(pattern: string): RegExp | string {
  if (pattern.split("{key}").length !== 2) {
    return "Use exactly one {key} placeholder for the ticket key.";
  }

  try {
    return new RegExp(pattern.replace("{key}", `(?<key>${TICKET_KEY})`), "gi");
  } catch {
    return "Not a valid regular expression.";
  }
}
