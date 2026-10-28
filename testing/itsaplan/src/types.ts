import type { PmNode } from "@outstaff/integration.shared.itsaplan";
import type { Handler, Route, StandInReply, StandInRequest } from "@outstaff/testing.http";
import type { QuoteRange } from "./stand-in/types.js";
import type { createItsaplanFake } from "./itsaplan-fake.js";

/** A request as the stub's routes see it. */
export type StubRequest = StandInRequest;

/** What a route answers when it needs more than a JSON body with status 200. */
export type StubReply = StandInReply;

export type { Handler, Route };

/** Markdown to editor JSON, and where a quote sits in it: the knowledge adapter passes its own. */
export interface Markdown {
  toDoc: (md: string) => PmNode;
  quoteRange: QuoteRange;
}

export interface FakeOptions {
  /** Column names; default is the Title Case set matching the canonical statuses. */
  columns?: { name: string; stateType: string }[];
  projectKey?: string;
  teamRef?: string;
  markdown?: Markdown;
}

export type ItsaplanFake = ReturnType<typeof createItsaplanFake>;
