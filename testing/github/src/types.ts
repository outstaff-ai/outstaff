import type { Vcs } from "@outstaff/core";
import type { Handler, Route, StandInReply, StandInRequest } from "@outstaff/testing.http";

/** A request as the stub's routes see it. */
export type StubRequest = StandInRequest;

/** What a route answers when it needs more than a JSON body with status 200. */
export type StubReply = StandInReply;

export type { Handler, Route };

export interface Clock {
  date: Date;
  now: () => Date;
  advance(ms: number): void;
}

/** The part of the adapter the seed calls back into, bound once the adapter exists. */
export type FakeVcsRef = Pick<Vcs, "getPullRequest">;
