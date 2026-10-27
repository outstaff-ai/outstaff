import { PortError, type RepoRef, type Vcs } from "#/ports/index.js";
import type { FakeVcsState, StoredPr } from "./vcs.types.js";

/**
 * The host's side of auto-merge: once a pull request set to merge is approved and its required checks pass, it merges,
 * in the name of whoever turned auto-merge on (the fake's own identity).
 */
export function settleAutoMerge(st: FakeVcsState, repo: RepoRef, s: StoredPr): void {
  const approved = s.reviewList.some((r) => r.state === "approved");
  const failing = (st.checks.get(`${st.key(repo)}@${s.pr.head.sha}`) ?? []).some(
    (c) => s.required.has(c.name) && c.status !== "success" && c.status !== "neutral",
  );

  if (!s.pr.autoMerge || s.pr.state !== "open" || !approved || failing) {
    return;
  }

  s.pr.state = "merged";
  st.touch(s);
  st.emit("pr.merged", repo, s.pr.number, st.self);
}

/** Turning on auto-merge and joining the merge queue, as the fake's own identity. */
export function fakeVcsAutoMerge(st: FakeVcsState): Pick<Vcs, "enableAutoMerge" | "enqueue"> {
  const openPr = (repo: RepoRef, number: number) => {
    st.grant(repo, "write");
    const s = st.need(repo, number);
    if (s.pr.state !== "open" || s.pr.draft) {
      throw new PortError(
        "invalid",
        `${st.key(repo)}#${number} is not an open, ready pull request.`,
      );
    }

    return s;
  };

  return {
    async enableAutoMerge(repo, number) {
      const s = openPr(repo, number);
      s.pr.autoMerge = true;
      st.touch(s);
    },
    async enqueue(repo, number) {
      const s = openPr(repo, number);
      if (!st.settingsOf(repo).queue) {
        throw new PortError("invalid", `${st.key(repo)} has no merge queue.`);
      }

      s.pr.autoMerge = true;
      st.touch(s);
    },
  };
}
