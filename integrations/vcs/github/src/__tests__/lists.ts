import type { Route, StubReply } from "@outstaff/testing.github";

type Answer = unknown[] | StubReply;

/** What the direct comment and review lists of acme/app answer; each is empty unless given. */
export interface Lists {
  comments?: Answer;
  inline?: Answer;
  pulls?: Answer;
  reviews?: Record<number, unknown[]>;
}

/** The direct lists the events poll reads beside the feed. */
export function listRoutes(lists: Lists = {}): Route[] {
  const answer = (a: Answer | undefined) => () => a ?? [];
  return [
    { method: "GET", path: "/repos/acme/app/issues/comments", handler: answer(lists.comments) },
    { method: "GET", path: "/repos/acme/app/pulls/comments", handler: answer(lists.inline) },
    { method: "GET", path: "/repos/acme/app/pulls", handler: answer(lists.pulls) },
    {
      method: "GET",
      path: "/repos/acme/app/pulls/:n/reviews",
      handler: (r) => lists.reviews?.[Number(r.params["n"])] ?? [],
    },
  ];
}
