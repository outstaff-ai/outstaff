import type { Member } from "@outstaff/core";
import type { TrackerSeed } from "@outstaff/core/contracts";
import { fakeRoutes } from "./fake-routes.js";
import { createFakeState, err } from "./fake-state.js";
import { API_ORIGIN, createStubFetch } from "./http-stub.js";
import type { FakeOptions, FakeShared, Route } from "./types.js";

// A stateful stand-in for the parts of the Its a Plan REST API the tracker adapter uses, shaped after its OpenAPI
// document. The adapters talk to it over the injected fetch, so the contract kits run the real client code. The
// knowledge package adds the document routes through `extend`.

export function createItsaplanFake(
  opts: FakeOptions = {},
  extend: (shared: FakeShared) => Route[] = () => [],
) {
  const state = createFakeState(opts);
  const { key, ref, clock, columns, labels, assignees, issues, activity, attachments, actor } =
    state;

  const routes = fakeRoutes(state);

  const stub = createStubFetch([...routes, ...extend({ clock, err, actor })], API_ORIGIN);

  const trackerSeed: TrackerSeed = {
    async member(m) {
      const userId = `u-${assignees.length + 1}`;
      assignees.push({
        userId,
        name: m.name,
        username: m.name.toLowerCase(),
        kind: "member",
      });

      return { id: userId, name: m.name, kind: m.kind ?? "human" } satisfies Member;
    },
    forbiddenCall: () => Promise.reject(new Error("bound by the test")),
  };

  return {
    fetch: stub.fetch,
    calls: stub.calls,
    called: stub.called,
    state: { issues, activity, columns, labels, assignees, attachments },
    trackerSeed,
    project: { key, ref },
    clock,
  };
}
