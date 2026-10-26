// Types shared by scripts/release.ts and its pure functions in scripts/release-lib.ts.

export type Level = "auto" | "patch" | "minor" | "major";
export type Bump = "patch" | "minor" | "major";

export type Commit = {
  hash: string;
  type: string;
  scope: string | null;
  breaking: boolean;
  summary: string;
  // Text of the `BREAKING CHANGE:` footer, when there is one.
  breakingNote: string | null;
};
