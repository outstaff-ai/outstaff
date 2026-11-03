import { describe, expect, it } from "vitest";
import { queuedActSchema } from "#/acts.js";

describe("queuedActSchema", () => {
  it("takes a direct message in chat as one of an act's changes", () => {
    const act = { id: "e1:notify", ops: [{ op: "chat_dm", to: "U0ADA00001", body: "Ready." }] };
    expect(queuedActSchema.parse(act)).toEqual(act);
  });

  it("refuses a direct message with no member or no body", () => {
    expect(
      queuedActSchema.safeParse({ id: "e1", ops: [{ op: "chat_dm", to: "", body: "x" }] }).success,
    ).toBe(false);

    expect(
      queuedActSchema.safeParse({ id: "e1", ops: [{ op: "chat_dm", to: "U1", body: "" }] }).success,
    ).toBe(false);
  });
});
