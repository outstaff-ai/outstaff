/** A DNS label that fits the schema's handle limit: it ends up in hostnames, branch names and mentions. */
export const HANDLE = /^[a-z]([a-z0-9-]{0,28}[a-z0-9])?$/;

/** `office` is the name of the office scope in `ost setup` and `ost doctor`. */
export const RESERVED_HANDLES = ["office"];

/** Neutral, made-up names for people who were not given one. */
export const NAMES = [
  "Ari Lindqvist",
  "Bela Marsh",
  "Cleo Winters",
  "Dara Whitfield",
  "Elio Navarro",
  "Faye Okoye",
  "Gus Halvorsen",
  "Hana Sato",
  "Ivo Petrov",
  "Juno Alvarez",
  "Kai Brennan",
  "Lena Moreau",
  "Milo Ferreira",
  "Nia Adeyemi",
  "Omar Jansen",
  "Pia Lombardi",
  "Quinn Tanaka",
  "Rhea Kapoor",
  "Sol Castillo",
  "Tess Lindgren",
  "Uma Reyes",
  "Vik Soto",
  "Wren Dalton",
  "Yuki Brandt",
  "Zane Kowalski",
  "Arlo Bishop",
  "Beck Sorensen",
  "Cato Ibarra",
  "Dev Malik",
  "Esme Haverford",
];

const ascii = (s: string): string =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

/** The first name as a handle: lowercase ASCII letters and digits, starting with a letter. */
export function baseHandle(name: string): string {
  const first = ascii(name.trim().split(/\s+/)[0] ?? "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/-+$/, "");

  return (first || "agent").slice(0, 28).replace(/-+$/, "");
}

/** `base`, or `base-2`, `base-3`… until nothing already uses it. */
export function uniqueHandle(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken, ...RESERVED_HANDLES]);
  if (!used.has(base)) {
    return base;
  }

  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
}

/** A name from the list whose handle is free; the starting point moves with the size of the team so hires differ. */
export function generateName(taken: Iterable<string>): string {
  const list = [...taken];
  const used = new Set([...list, ...RESERVED_HANDLES]);
  for (let i = 0; i < NAMES.length; i++) {
    const name = NAMES[(list.length + i) % NAMES.length]!;
    if (!used.has(baseHandle(name))) {
      return name;
    }
  }

  return NAMES[list.length % NAMES.length]!;
}
