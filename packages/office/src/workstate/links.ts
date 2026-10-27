import type { Ref, Store } from "../store/index.js";

export const ROOT: Ref = { type: "workstate", ref: "index" };
export const prNode = (key: string): Ref => ({ type: "pr", ref: key });
export const ticketNode = (key: string): Ref => ({ type: "ticket", ref: key });
export const personNode = (handle: string): Ref => ({ type: "person", ref: handle });
export const docNode = (id: string): Ref => ({ type: "doc", ref: id });

const sameRef = (a: Ref | undefined, b: Ref | undefined) =>
  a?.type === b?.type && a?.ref === b?.ref;

/** Moves the `relation` edge of `from` from `prev` to `next`. */
export async function relink(
  store: Store,
  from: Ref,
  relation: string,
  prev?: Ref,
  next?: Ref,
): Promise<void> {
  if (sameRef(prev, next)) {
    return;
  }

  if (prev) {
    await store.unlink(from, prev, relation);
  }

  if (next) {
    await store.link(from, next, relation);
  }
}
