import { describe, expect, it } from "vitest";
import { isApprover } from "../approvers.js";

const humans = [
  { name: "Ada", identities: { vcs: "ada-gh", tracker: "ada.admin" } },
  { name: "Grace", identities: { vcs: "grace-gh" } },
];

const role = (r: string) => (r === "reviewer" ? "rex" : undefined);
const human = (id: string, trusted = true) => ({ kind: "human" as const, id, trusted });
const agent = (id: string) => ({ kind: "agent" as const, id, trusted: false });

describe("isApprover", () => {
  it("humans: any trusted human, never an untrusted one, an agent or a bot", () => {
    expect(isApprover(["humans"], human("ada-gh"), { humans }, role)).toBe(true);
    expect(isApprover(["humans"], human("mallory", false), { humans }, role)).toBe(false);
    expect(isApprover(["humans"], agent("rex"), { humans }, role)).toBe(false);
    expect(
      isApprover(["humans"], { kind: "automation", id: "ci[bot]", trusted: false }, {}, role),
    ).toBe(false);
  });

  it("human:<id>: one human, by any identity in humans", () => {
    expect(isApprover(["human:ada.admin"], human("ada-gh"), { humans }, role)).toBe(true);
    expect(isApprover(["human:ada-gh"], human("ada-gh"), { humans }, role)).toBe(true);
    expect(isApprover(["human:ada.admin"], human("grace-gh"), { humans }, role)).toBe(false);
    expect(isApprover(["human:ada"], human("ada"), {}, role)).toBe(true);
  });

  it("role:<role> and handles: the agent playing the role or with the handle, a human by login", () => {
    expect(isApprover(["role:reviewer"], agent("rex"), {}, role)).toBe(true);
    expect(isApprover(["role:reviewer"], agent("ada"), {}, role)).toBe(false);
    expect(isApprover(["role:ghost"], agent("rex"), {}, role)).toBe(false);
    expect(isApprover(["rex"], agent("rex"), {}, role)).toBe(true);
    expect(isApprover(["rex"], agent("mira"), {}, role)).toBe(false);
    expect(isApprover(["grace-gh"], human("Grace-GH"), { humans }, role)).toBe(true);
  });
});
