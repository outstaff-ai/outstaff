import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeAgentSdk } from "#/adapter.js";
import { renderedSkillNames, workdirFiles } from "#/layout.js";

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

describe("renderedSkillNames", () => {
  it("lists the skill directories of a workdir and none for a bare one", () => {
    const dir = mkdtempSync(join(tmpdir(), "ost-skills-"));
    try {
      expect(renderedSkillNames(dir)).toEqual([]);
      mkdirSync(join(dir, ".claude", "skills", "reviewer"), { recursive: true });
      mkdirSync(join(dir, ".claude", "skills", "developer"), { recursive: true });
      writeFileSync(join(dir, ".claude", "skills", "notes.txt"), "not a skill");
      expect(renderedSkillNames(dir)).toEqual(["developer", "reviewer"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
