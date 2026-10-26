import { PortError } from "@outstaff/core";

// `<docId>:<commentId>`: replies and resolves arrive with a comment id only, and the API needs the document too.
export const commentId = (docId: number | string, id: string) => `${docId}:${id}`;

export function parseCommentId(id: string): { docId: number; id: string } {
  const m = /^(\d+):(.+)$/.exec(id);
  if (!m) {
    throw new PortError("not_found", `Comment ${id} not found.`);
  }

  return { docId: Number(m[1]), id: m[2]! };
}
