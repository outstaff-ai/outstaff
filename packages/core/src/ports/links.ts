import type { RepoRef } from "./repo.js";

/** Absolute URLs for addressable things. Each port fills in the parts it owns. */
export interface Links {
  issue(key: string): string;
  doc(id: string): string;
  pr(repo: RepoRef, number: number): string;
  commit(repo: RepoRef, sha: string): string;
  thread(repo: RepoRef, number: number, threadId: string): string;
}
