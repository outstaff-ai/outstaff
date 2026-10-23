import { readFileSync } from "node:fs";
import { agentRegistry } from "@outstaff/agent";
import { describe, expect, it } from "vitest";
import { applySecretsBlock, renderSecretsBlock, renderSecretsTable } from "./contract.js";
import { officeRegistry } from "./main.js";

const page = readFileSync(
  new URL("../../../docs/src/content/docs/reference/container-contract.md", import.meta.url),
  "utf8",
);

describe("container contract page", () => {
  it("has a current secrets table (run `pnpm --filter @outstaff/office run docs:contract`)", () => {
    const block = renderSecretsBlock(officeRegistry(), agentRegistry());
    expect(applySecretsBlock(page, block)).toBe(page);
  });

  it("assigns secrets to containers", () => {
    const rows = renderSecretsTable(officeRegistry(), agentRegistry()).split("\n");
    const row = (key: string) => rows.find((r) => r.startsWith(`| \`${key}\``)) ?? "";
    expect(row("GH_OFFICE_APP_ID")).toContain("| both ");
    expect(row("GH_APP_ID")).toContain("| agent ");
    expect(row("OUTSTAFF_AGENT_TOKEN_<HANDLE>")).toContain("| office ");
    expect(row("ANTHROPIC_API_KEY")).toContain("| optional ");
  });

  it("marks only the subscription token as visible to the agent shell", () => {
    const rows = renderSecretsTable(officeRegistry(), agentRegistry()).split("\n").slice(2);
    const visible = rows.filter((r) => r.split("|")[5]?.trim() === "yes");
    expect(visible).toHaveLength(1);
    expect(visible[0]).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
