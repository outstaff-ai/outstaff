import type { Handler, Route, StandInReply, StandInRequest } from "@outstaff/testing.http";
import type { createItsaplanFake } from "./itsaplan-fake.js";

/** A request as the stub's routes see it. */
export type StubRequest = StandInRequest;

/** What a route answers when it needs more than a JSON body with status 200. */
export type StubReply = StandInReply;

export type { Handler, Route };

export interface FakeOptions {
  /** Column names; default is the Title Case set matching the canonical statuses. */
  columns?: { name: string; stateType: string }[];
  projectKey?: string;
  teamRef?: string;
}

export type ItsaplanFake = ReturnType<typeof createItsaplanFake>;
