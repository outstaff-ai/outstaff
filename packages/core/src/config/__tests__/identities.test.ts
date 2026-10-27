import { describe, expect, it } from "vitest";
import { vcsAgentLogins } from "#/config/identities.js";
import type { TeamConfig } from "#/config/types.js";

const team = (people: unknown[], vcs: unknown = { adapter: "github" }) =>
  ({ people, integrations: { vcs } }) as unknown as TeamConfig;

describe("vcsAgentLogins", () => {
  it("maps identities.vcs exactly, case-insensitively", () => {
    const out = vcsAgentLogins(team([{ handle: "sam", identities: { vcs: "Acme-Sam[bot]" } }]));
    expect(out.get("acme-sam[bot]")).toBe("sam");
    expect(out.has("sam[bot]")).toBe(false);
    expect(out.has("sam")).toBe(false);
  });
});
