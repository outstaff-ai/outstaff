import { createItsaplanFake as createStandIn, type FakeOptions } from "@outstaff/testing.itsaplan";
import { mdToDoc } from "#/markdown.js";
import { findRange } from "#/text-range.js";

/** The Its a Plan stand-in with this adapter's markdown conversion, so it checks quotes as the service does. */
export const createItsaplanFake = (opts: Omit<FakeOptions, "markdown"> = {}) =>
  createStandIn({ ...opts, markdown: { toDoc: mdToDoc, quoteRange: findRange } });
