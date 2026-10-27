import type { RepoRef } from "./types.js";

/** Absolute URLs for addressable things. Each port fills in the parts it owns. */
export interface Links {
  issue(key: string): string;
  doc(id: string): string;

  /**
   * The link to one comment on a ticket or document: `(key or doc id, comment id)`. Omitted by hosts that have no
   * comment anchors; callers then use the parent's link.
   */
  comment?(parentId: string, commentId: string): string;
  pr(repo: RepoRef, number: number): string;
  commit(repo: RepoRef, sha: string): string;
  thread(repo: RepoRef, number: number, threadId: string): string;
}
