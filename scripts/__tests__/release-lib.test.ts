import { describe, expect, it } from "vitest";
import {
  bumpFor,
  increment,
  isPrerelease,
  nextVersion,
  parseCommit,
  prependChangelog,
  releaseNotes,
  setPackageVersion,
} from "../release-lib.ts";
import type { Commit } from "../release.types.ts";

let counter = 0;
function commit(message: string): Commit {
  counter += 1;
  const parsed = parseCommit(`${counter}`.padStart(40, "a"), message);
  if (!parsed) {
    throw new Error(`not conventional: ${message}`);
  }

  return parsed;
}

describe("parseCommit", () => {
  it("reads type, scope and summary", () => {
    expect(commit("feat(office): poll tracker")).toMatchObject({
      type: "feat",
      scope: "office",
      breaking: false,
      summary: "poll tracker",
    });
  });

  it("allows a missing scope", () => {
    expect(commit("fix: handle empty list").scope).toBeNull();
  });

  it("treats ! as breaking", () => {
    expect(commit("refactor(core)!: rename ports")).toMatchObject({ breaking: true });
  });

  it("treats a BREAKING CHANGE footer as breaking and keeps its text", () => {
    const parsed = commit(
      "fix(core): tighten schema\n\nBody.\n\nBREAKING CHANGE: team.yaml\nneeds a version\n\nCloses #1",
    );

    expect(parsed.breaking).toBe(true);
    expect(parsed.breakingNote).toBe("team.yaml needs a version");
  });

  it("accepts the BREAKING-CHANGE spelling", () => {
    expect(commit("feat: x\n\nBREAKING-CHANGE: gone").breaking).toBe(true);
  });

  it("ignores a mention of breaking change inside a sentence", () => {
    expect(commit("fix: x\n\nThis is not a BREAKING CHANGE: really").breaking).toBe(false);
  });

  it("returns null for non-conventional messages", () => {
    expect(parseCommit("a", "Merge pull request #3 from x/y")).toBeNull();
    expect(parseCommit("a", "update stuff")).toBeNull();
  });
});

describe("versioning", () => {
  it("feat bumps the minor and fix the patch", () => {
    expect(nextVersion("1.2.3", [commit("feat: a")], "auto")).toBe("1.3.0");
    expect(nextVersion("1.2.3", [commit("fix: a")], "auto")).toBe("1.2.4");
    expect(nextVersion("1.2.3", [commit("perf: a")], "auto")).toBe("1.2.4");
  });

  it("the biggest bump wins", () => {
    const commits = [commit("fix: a"), commit("feat: b"), commit("fix: c")];
    expect(nextVersion("1.2.3", commits, "auto")).toBe("1.3.0");
  });

  it("breaking bumps the major from 1.0.0", () => {
    expect(nextVersion("1.2.3", [commit("fix!: a")], "auto")).toBe("2.0.0");
    expect(nextVersion("1.2.3", [commit("fix: a\n\nBREAKING CHANGE: b")], "auto")).toBe("2.0.0");
  });

  it("breaking on 0.x bumps the minor", () => {
    expect(nextVersion("0.4.2", [commit("feat(core)!: a")], "auto")).toBe("0.5.0");
    expect(bumpFor([commit("docs: a\n\nBREAKING CHANGE: b")], "0.4.2")).toBe("minor");
  });

  it("feat on 0.x bumps the minor and fix the patch", () => {
    expect(nextVersion("0.4.2", [commit("feat: a")], "auto")).toBe("0.5.0");
    expect(nextVersion("0.4.2", [commit("fix: a")], "auto")).toBe("0.4.3");
  });

  it("types that do not release give nothing to release", () => {
    const commits = ["docs", "chore", "ci", "test", "style", "refactor", "build"].map((t) =>
      commit(`${t}: a`),
    );

    expect(nextVersion("1.0.0", commits, "auto")).toBeNull();
    expect(nextVersion("1.0.0", [], "auto")).toBeNull();
  });

  it("first release with no tag starts from 0.0.0", () => {
    expect(nextVersion("0.0.0", [commit("feat: a"), commit("fix: b")], "auto")).toBe("0.1.0");
    expect(nextVersion("0.0.0", [commit("fix: b")], "auto")).toBe("0.0.1");
    expect(nextVersion("0.0.0", [commit("feat!: a")], "auto")).toBe("0.1.0");
  });

  it("an explicit level overrides the commits, even with none", () => {
    expect(nextVersion("0.4.2", [], "patch")).toBe("0.4.3");
    expect(nextVersion("0.4.2", [commit("fix: a")], "minor")).toBe("0.5.0");
    expect(nextVersion("0.4.2", [], "major")).toBe("1.0.0");
  });

  it("increments", () => {
    expect(increment("1.2.3", "major")).toBe("2.0.0");
    expect(increment("1.2.3", "minor")).toBe("1.3.0");
    expect(increment("1.2.3", "patch")).toBe("1.2.4");
    expect(() => increment("1.2", "patch")).toThrow(/x.y.z/);
  });

  it("marks 0.x as prerelease", () => {
    expect(isPrerelease("0.1.0")).toBe(true);
    expect(isPrerelease("1.0.0")).toBe(false);
  });
});

describe("releaseNotes", () => {
  it("groups by type in a fixed order and drops noise", () => {
    const notes = releaseNotes([
      commit("chore: bump"),
      commit("docs: guide"),
      commit("fix(office): restart"),
      commit("feat(core): ports"),
      commit("perf: faster"),
      commit("test: more"),
    ]);

    const headings = [...notes.matchAll(/^### (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual(["Features", "Fixes", "Performance", "Other"]);
    expect(notes).not.toContain("bump");
    expect(notes).not.toContain("more");
    expect(notes).toMatch(/- \*\*core:\*\* ports \([0-9a-f]{7}\)/);
    expect(notes).toMatch(/- guide \(/);
  });

  it("lists breaking changes first, once, with the footer text", () => {
    const notes = releaseNotes([
      commit("feat(core): ports"),
      commit("feat(cli)!: rename verb\n\nBREAKING CHANGE: use ost run"),
    ]);

    expect(notes.startsWith("### Breaking changes")).toBe(true);
    expect(notes.match(/rename verb/g)).toHaveLength(1);
    expect(notes).toContain("use ost run");
  });

  it("says so when there is nothing to list", () => {
    expect(releaseNotes([commit("chore: x")])).toBe("No notable changes.");
  });
});

describe("prependChangelog", () => {
  const notes = "### Features\n\n- a (abc1234)";

  it("creates the file with a title on the first release", () => {
    expect(prependChangelog(null, "0.1.0", "2026-01-02", notes)).toBe(
      "# Changelog\n\n## v0.1.0 (2026-01-02)\n\n### Features\n\n- a (abc1234)\n",
    );
  });

  it("puts the newest entry directly under the title", () => {
    const first = prependChangelog(null, "0.1.0", "2026-01-02", notes);
    const second = prependChangelog(first, "0.2.0", "2026-02-03", "### Fixes\n\n- b (def5678)");
    expect(second.startsWith("# Changelog\n\n## v0.2.0 (2026-02-03)")).toBe(true);
    expect(second.indexOf("v0.2.0")).toBeLessThan(second.indexOf("v0.1.0"));
    expect(second.endsWith("- a (abc1234)\n")).toBe(true);
  });

  it("adds a title to a file that has none", () => {
    expect(prependChangelog("old text\n", "0.1.0", "2026-01-02", notes)).toBe(
      "# Changelog\n\n## v0.1.0 (2026-01-02)\n\n### Features\n\n- a (abc1234)\n\nold text\n",
    );
  });

  it("refuses to add a version twice", () => {
    const first = prependChangelog(null, "0.1.0", "2026-01-02", notes);
    expect(() => prependChangelog(first, "0.1.0", "2026-01-03", notes)).toThrow(/already/);
  });
});

describe("setPackageVersion", () => {
  it("changes only the package version and keeps the formatting", () => {
    const text =
      '{\n  "name": "x",\n  "version": "0.0.0",\n  "dependencies": {\n    "y": "workspace:*"\n  }\n}\n';

    expect(setPackageVersion(text, "0.1.0")).toBe(text.replace("0.0.0", "0.1.0"));
  });

  it("throws without a version field", () => {
    expect(() => setPackageVersion('{ "name": "x" }', "1.0.0")).toThrow(/version/);
  });
});
