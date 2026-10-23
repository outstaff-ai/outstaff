import { describe, expect, it } from "vitest";
import { claudeAgentSdk } from "./adapter.js";
import { workdirFiles } from "./layout.js";

describe("workdirFiles", () => {
  it("puts skills where Claude Code loads them and leaves other files alone", () => {
    const out = workdirFiles(
      new Map([
        ["skills/developer/SKILL.md", "dev"],
        ["skills/reviewer/SKILL.md", "rev"],
        ["references/git.md", "git"],
        ["process/hand-back.md", "hb"],
      ]),
    );

    expect([...out.keys()]).toEqual([
      ".claude/skills/developer/SKILL.md",
      ".claude/skills/reviewer/SKILL.md",
      "references/git.md",
      "process/hand-back.md",
    ]);

    expect(out.get(".claude/skills/developer/SKILL.md")).toBe("dev");
  });

  it("is declared by the adapter", () => {
    expect(claudeAgentSdk.workdirLayout).toBe(workdirFiles);
  });
});
