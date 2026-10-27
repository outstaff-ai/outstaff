import type { ReplayScenario } from "#/pipeline/replay/replay.types.js";
import { ciFailure, otherPrEvents, reviewRound } from "./reviews.js";
import { stackedMerge, unrelatedConflict } from "./merges.js";
import { chat, docComments, handBacks, idle } from "./office.js";
import { assignments, ticketComments } from "./tracker.js";

/** About fifty acme events, in the order a day of the team's work would raise them. */
export const ACME_REPLAY: ReplayScenario[] = [
  stackedMerge,
  unrelatedConflict,
  reviewRound,
  assignments,
  ticketComments,
  idle,
  handBacks,
  chat,
  docComments,
  ciFailure,
  otherPrEvents,
];
