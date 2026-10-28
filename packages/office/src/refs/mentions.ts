import { TICKET_KEY } from "@outstaff/core";
import type { NewItemRef } from "#/store/types.js";

const KEY = new RegExp(`\\b(${TICKET_KEY})\\b`, "g");

/** Ticket keys a text names, upper case, each once, in the order they appear. */
export function ticketKeysIn(text: string): string[] {
  const keys = [...text.matchAll(KEY)].map((m) => m[1]!.toUpperCase());
  return keys.filter((k, i) => keys.indexOf(k) === i);
}

/**
 * The tickets a text names that the office knows, as `mentioned` references. A key-shaped word that is no ticket
 * (`UTF-8`) is left out because nothing knows it.
 */
export async function mentionedRefs(
  text: string,
  source: string,
  known: (key: string) => boolean | Promise<boolean>,
): Promise<NewItemRef[]> {
  const out: NewItemRef[] = [];
  for (const key of ticketKeysIn(text)) {
    if (await known(key)) {
      out.push({ type: "ticket", ref: key, role: "mentioned", source });
    }
  }

  return out;
}
