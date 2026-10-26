import type { Link } from "@outstaff/protocol";

const URL_PATTERN = /https?:\/\/[^\s<>()"'`\]]+/g;

/** Links in the final message, in order, without trailing punctuation or repeats. */
export function linksIn(text: string): Link[] {
  const urls = (text.match(URL_PATTERN) ?? []).map((u) => u.replace(/[.,;:!?*_]+$/, ""));
  return [...new Set(urls)].map((url) => ({ url }));
}
