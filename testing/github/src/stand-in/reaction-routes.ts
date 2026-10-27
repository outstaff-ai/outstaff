import type { Route } from "@outstaff/testing.http";
import { NOT_FOUND, UNAUTHORIZED, nextSeq } from "./model.js";
import type { GithubAuth, GithubStore, StoredReaction } from "./types.js";

const KIND = { issues: "conversation_comment", pulls: "inline_comment" } as const;

/** Whether a comment of the kind exists. */
const known = (s: GithubStore, kind: StoredReaction["kind"], id: number) =>
  kind === "conversation_comment"
    ? s.issueComments.has(id)
    : [...s.threads.values()].some((t) => t.comments.some((c) => c.databaseId === id));

/** Reactions on conversation comments and inline comments; a repeated one is answered 200, not 201. */
export function reactionRoutes(s: GithubStore, auth: GithubAuth, repo: string): Route[] {
  return (["issues", "pulls"] as const).map((segment): Route => ({
    method: "POST",
    path: `${repo}/${segment}/comments/:id/reactions`,
    handler: (r) => {
      const actor = auth.actorOf(r);
      if (!actor) {
        return UNAUTHORIZED;
      }

      const id = Number(r.params["id"]);
      const kind = KIND[segment];
      if (!known(s, kind, id)) {
        return NOT_FOUND;
      }

      const content = r.json.content;
      const found = s.reactions.some(
        (x) => x.kind === kind && x.commentId === id && x.user === actor && x.content === content,
      );

      if (!found) {
        s.reactions.push({ kind, commentId: id, user: actor, content, seq: nextSeq(s) });
      }

      return { status: found ? 200 : 201, body: { id, content } };
    },
  }));
}
