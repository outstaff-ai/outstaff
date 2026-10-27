import type { FakeVcs, FakeVcsOptions } from "./types.js";
import { fakeVcsAutoMerge } from "./vcs-auto-merge.js";
import { fakeVcsReads } from "./vcs-reads.js";
import { fakeVcsSeed } from "./vcs-seed.js";
import { createVcsState } from "./vcs-state.js";
import { fakeVcsWrites } from "./vcs-writes.js";

export function createFakeVcs(opts: FakeVcsOptions = {}): FakeVcs {
  const st = createVcsState(opts);
  return {
    links: st.links,
    seed: fakeVcsSeed(st),
    ...fakeVcsReads(st),
    ...fakeVcsWrites(st),
    ...fakeVcsAutoMerge(st),
  };
}
