import { describe, expect, it } from "vitest";
import { saysBlocked } from "./blocked.js";

describe("saysBlocked", () => {
  it.each([
    "Still blocked: I need the staging key.",
    "The ticket remains blocked on ops.",
    "Blocked. Waiting for the key.",
    "I am blocked by the missing credentials.",
    "Nothing changed, blocked until ops answers.",
  ])("recognises %j", (text) => {
    expect(saysBlocked(text)).toBe(true);
  });

  it.each([
    "Done. Opened the pull request.",
    "No longer blocked, the key arrived.",
    "It was blocked on ops, which answered; fixed now.",
    "Unblocked the ticket and finished the work.",
    "",
  ])("does not mistake %j", (text) => {
    expect(saysBlocked(text)).toBe(false);
  });
});
