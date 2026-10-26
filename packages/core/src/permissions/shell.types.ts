export type Separator = "&&" | "||" | ";" | "|" | "&";

export interface Redirect {
  /** `>`, `>>`, `<` or `<<<` (a here-string, whose target is data, not a file). */
  op: string;
  target: string;
}

export interface Segment {
  /** Words as written, quotes removed. Expansions (`$NAME`, `${...}`) stay in the text and are not resolved. */
  words: string[];
  redirects: Redirect[];

  /** What follows this segment; null for the last one. */
  sep: Separator | null;

  /** What preceded this segment; null for the first one. */
  before: Separator | null;

  /** Source of every command substitution, process substitution and here-document substitution in the segment. */
  subs: string[];

  /** Names of the variables the segment expands. */
  vars: string[];
}

export type LexResult = { ok: true; segments: Segment[] } | { ok: false; reason: string };

export type Token =
  | { k: "word"; v: string }
  | { k: "redir"; op: string }
  | { k: "sep"; v: Separator }
  | { k: "sub"; v: string }
  | { k: "var"; v: string };

export type Expansion = { tokens: Token[]; text: string; end: number };

export interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
  expands: boolean;
}

export type TokenResult = { ok: true; tokens: Token[] } | { ok: false; reason: string };
