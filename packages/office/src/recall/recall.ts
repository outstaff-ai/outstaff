import type { Recall } from "#/protocol/source.types.js";
import { createRecallIndex } from "./record.js";
import { createRecallSearch } from "./search.js";
import type { RecallIndex, RecallOptions } from "./types.js";

/** `ost recall`: the index of agents' history the office keeps, and the search over it. */
export function createRecall(opts: RecallOptions): Recall & RecallIndex {
  return {
    ...createRecallIndex({ ...opts, prKey: (pr) => opts.workState.prSubject(pr) }),
    ...createRecallSearch(opts),
  };
}
