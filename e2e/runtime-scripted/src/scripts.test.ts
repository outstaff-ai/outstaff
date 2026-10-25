import { describe, expect, it } from "vitest";
import {
  assigned,
  branchFor,
  chat,
  conflict,
  keepBoth,
  mergedFeedback,
  reviewFeedback,
  withGreeting,
  type Action,
} from "./scripts.js";

const ctx = {
  itemId: "w1",
  kind: "assigned",
  title: "assigned: SHOP-1 Add a greeting",
  ticket: "SHOP-1",
  worktree: "/wt",
  repo: "shop",
  journal: "",
  feedback: [],
  conventionFiles: ["CONTRIBUTING.md"],
};

/** Plays a script, answering each action with `answer`, and returns the actions and the final message. */
async function play(
  script: AsyncGenerator<Action, string, string>,
  answer: (a: Action) => string,
  fails: (a: Action) => boolean | string = () => false,
) {
  const seen: Action[] = [];
  let step = await script.next();
  while (!step.done) {
    const action = step.value;
    seen.push(action);
    const failure = fails(action);
    step = failure
      ? await script.throw(new Error(typeof failure === "string" ? failure : "failed"))
      : await script.next(answer(action));
  }

  return { seen, text: step.value };
}

describe("the greeting edits", () => {
  it("changes line one only", () => {
    expect(withGreeting("hello\nworld\n!\n", "SHOP-1")).toBe("hello from SHOP-1\nworld\n!\n");
  });

  it("keeps both sides of a conflicted first line", () => {
    expect(keepBoth("hello from SHOP-1\nworld\n", ["SHOP-1", "SHOP-2"])).toBe(
      "hello from SHOP-1\nhello from SHOP-2\nworld\n",
    );
  });
});

describe("assigned", () => {
  const answer = (a: Action) =>
    a.type === "read"
      ? "hello\nworld\n"
      : a.type === "tool" && a.tool === "pr_open"
        ? "Opened acme/shop#1\nhttps://github.acme.example/acme/shop/pull/1"
        : a.type === "tool" && a.tool === "ticket_show"
          ? "SHOP-1 Add a greeting"
          : a.type === "shell" && a.command === "pnpm --version"
            ? "12.9.1\n"
            : "";

  it("takes the ticket, commits, pushes and opens a pull request that closes it", async () => {
    const { seen, text } = await play(assigned(ctx), answer);
    expect(
      seen.map((a) => (a.type === "tool" ? a.tool : a.type === "shell" ? a.command : a.type)),
    ).toEqual([
      "ticket_show",
      "ticket_move",
      "pnpm --version",
      "read",
      "git switch -c 'feat/SHOP-1-add-a-greeting'",
      "read",
      "write",
      "git add -A",
      "git commit -m 'SHOP-1: Add a greeting'",
      "git push origin 'feat/SHOP-1-add-a-greeting'",
      "pr_open",
    ]);

    expect(seen.at(-1)).toMatchObject({ input: { body: "Closes SHOP-1\n" } });
    expect(text).toContain("https://github.acme.example/acme/shop/pull/1");
  });

  it("names the branch by the repository's rule when its files give one", async () => {
    const { seen } = await play(assigned(ctx), (a) =>
      a.type === "read" && a.path.endsWith("CONTRIBUTING.md")
        ? "Branches are named `feature/<key>-<slug>`.\n"
        : answer(a),
    );

    expect(seen).toContainEqual({
      type: "shell",
      command: "git switch -c 'feature/SHOP-1-add-a-greeting'",
      cwd: "/wt",
    });
  });

  it("fails when pnpm does not print a version", async () => {
    await expect(
      play(assigned(ctx), (a) =>
        a.type === "shell" && a.command === "pnpm --version"
          ? "mise use -g pnpm@12.9.1"
          : answer(a),
      ),
    ).rejects.toThrow("not a version");
  });

  it("asks the architect when the ticket says so, after the pull request is open", async () => {
    const { seen } = await play(assigned(ctx), (a) =>
      a.type === "tool" && a.tool === "ticket_show"
        ? "SHOP-1\n\nask architect: One file or many?"
        : answer(a),
    );

    expect(seen.at(-1)).toEqual({
      type: "tool",
      tool: "ask",
      input: { to: "architect", question: "One file or many?" },
    });
  });
});

describe("assigned, for a ticket that needs two pull requests", () => {
  const answer = (a: Action) =>
    a.type === "read"
      ? "hello\nworld\n"
      : a.type === "tool" && a.tool === "pr_open"
        ? "Opened https://git.example/acme/shop/pull/1"
        : a.type === "tool" && a.tool === "ticket_create"
          ? "Created SHOP-2.\nSHOP-2: Add a farewell\nhttps://tracker.example/issue/SHOP-2\nPart of SHOP-1: https://tracker.example/issue/SHOP-1"
          : a.type === "tool" && a.tool === "ticket_show"
            ? "SHOP-1 Add a greeting\n\nsplit: Add a farewell"
            : a.type === "shell" && a.command === "pnpm --version"
              ? "12.9.1\n"
              : "";

  it("splits first, then opens one pull request per ticket, and a second for the parent is refused", async () => {
    // The third pull request is the parent's second one; the verb refuses it and names the first.
    let opens = 0;
    const { seen, text } = await play(assigned(ctx), answer, (a) => {
      if (a.type === "tool" && a.tool === "pr_open") {
        opens += 1;
        return (
          opens === 3 && "SHOP-1 already has a pull request: https://git.example/acme/shop/pull/1"
        );
      }

      return false;
    });

    const tools = seen
      .filter((a) => a.type === "tool")
      .map((a) => (a.type === "tool" ? a.tool : ""));

    expect(tools.slice(0, 4)).toEqual([
      "ticket_show",
      "ticket_move",
      "ticket_create",
      "ticket_comment",
    ]);

    expect(seen.find((a) => a.type === "tool" && a.tool === "ticket_create")).toMatchObject({
      input: { title: "Add a farewell", parent: "SHOP-1" },
    });

    const bodies = seen
      .filter((a) => a.type === "tool" && a.tool === "pr_open")
      .map((a) => (a.type === "tool" ? a.input["body"] : ""));

    expect(bodies).toEqual(["Closes SHOP-1\n", "Closes SHOP-2\n", "Closes SHOP-1\n"]);
    expect(text).toContain("one per ticket");

    // Each pull request gets a branch of its own, named with its own ticket key: the parent's from the detached
    // worktree, the sub-ticket's from the default branch.
    const switches = seen.flatMap((a) =>
      a.type === "shell" && a.command.startsWith("git switch -c") ? [a.command] : [],
    );

    expect(switches).toEqual([
      "git switch -c 'feat/SHOP-1-add-a-greeting'",
      "git switch -c 'feat/SHOP-2-add-a-farewell' origin/main",
    ]);
  });
});

describe("branchFor", () => {
  it("defaults to <type>/<key>-<slug>, and drops the key without a ticket", () => {
    expect(branchFor("", "SHOP-1", "Add a greeting!")).toBe("feat/SHOP-1-add-a-greeting");
    expect(branchFor("", undefined, "Add a greeting")).toBe("feat/add-a-greeting");
  });
});

describe("conflict", () => {
  it("pushes with a lease on the sha it started from, and only after resolving the rebase", async () => {
    const { seen } = await play(
      conflict({ ...ctx, kind: "conflict", pr: 2, ticket: "SHOP-2" }),
      (a) => {
        if (a.type === "shell" && a.command.startsWith("git log --remotes")) {
          return "origin/main, origin/HEAD|Merge pull request #1\norigin/assigned/w2-second|SHOP-2: Second\n";
        }

        if (a.type === "shell" && a.command === "git rev-parse --abbrev-ref HEAD") {
          return "assigned/w2-second\n";
        }

        if (a.type === "shell" && a.command === "git rev-parse origin/assigned/w2-second") {
          return "abc123\n";
        }

        if (a.type === "shell" && a.command.startsWith("git show")) {
          return "hello from SHOP-1\nworld\n";
        }

        return a.type === "read"
          ? "<<<<<<< x\nhello from SHOP-1\n=======\nhello from SHOP-2\n>>>>>>> y\n"
          : "";
      },
      // The rebase stops on the conflict.
      (a) => a.type === "shell" && a.command === "git rebase origin/main",
    );

    const commands = seen.flatMap((a) => (a.type === "shell" ? [a.command] : []));
    expect(commands.at(-1)).toBe(
      "git push --force-with-lease=assigned/w2-second:abc123 origin HEAD:'assigned/w2-second'",
    );

    expect(commands).toContain("git rebase --continue");
    expect(seen.find((a) => a.type === "write")).toMatchObject({
      text: "hello from SHOP-1\nhello from SHOP-2\nworld\n",
    });
  });
});

describe("mergedFeedback", () => {
  const merged = {
    ...ctx,
    kind: "merged_feedback",
    pr: 1,
    feedback: [
      {
        kind: "comment" as const,
        url: "https://git.example/acme/shop/pull/1#c1",
        body: "Add a goodbye.",
        threads: [],
      },
    ],
  };

  it("answers on the merged pull request, opens a follow-up from the default branch and links it", async () => {
    const { seen } = await play(mergedFeedback(merged), (a) =>
      a.type === "read"
        ? "hello\nworld\n"
        : a.type === "tool" && a.tool === "ticket_create"
          ? "Created SHOP-2.\nhttps://tracker.example/issue/SHOP-2"
          : a.type === "tool" && a.tool === "pr_open"
            ? "Opened acme/shop#3\nhttps://git.example/acme/shop/pull/3"
            : "",
    );

    const steps = seen.map((a) =>
      a.type === "tool" ? a.tool : a.type === "shell" ? a.command : a.type,
    );

    // The merged pull request's ticket has its pull request: the follow-up is a sub-ticket with its own.
    expect(steps.slice(0, 5)).toEqual([
      "pr_comment",
      "ticket_create",
      "git fetch --prune origin",
      "read",
      "git switch -c 'feat/SHOP-2-follow-up-on-1' origin/main",
    ]);

    expect(steps.at(-2)).toBe("pr_open");
    expect(seen.find((a) => a.type === "tool" && a.tool === "ticket_create")).toMatchObject({
      input: { parent: "SHOP-1" },
    });

    expect(seen.find((a) => a.type === "tool" && a.tool === "pr_open")).toMatchObject({
      input: {
        title: "SHOP-2: follow up on #1",
        body: expect.stringContaining("Closes SHOP-2\n\nFollows up on #1, which is merged."),
      },
    });

    expect(seen.at(-1)).toMatchObject({
      tool: "pr_comment",
      input: { number: 1, body: "Follow-up: https://git.example/acme/shop/pull/3" },
    });
  });
});

describe("chat", () => {
  const talk = (...lines: [boolean, string][]) => ({
    ...ctx,
    kind: "chat",
    conversation: lines.map(([agent, text]) => ({ from: agent ? "Sam" : "Ada", agent, text })),
  });

  it("looks at the person's work and answers a question, filing nothing", async () => {
    const { seen, text } = await play(
      chat(talk([false, "Where do the greetings live?"])),
      () => "1. [SHOP-1 Add a greeting](x) (running)\n",
    );

    expect(seen).toEqual([{ type: "tool", tool: "work", input: {} }]);
    expect(text).toContain("greeting.txt");
    expect(text).toContain("SHOP-1 Add a greeting");
  });

  it("files a message with pictures as a ticket, which gets the files from the agent", async () => {
    const { seen, text } = await play(
      chat({
        ...talk([false, "The page looks wrong"]),
        files: [
          { path: "/scratch/c1/files/1-screen.png", mimetype: "image/png", name: "screen.png" },
        ],
      }),
      () => "Created SHOP-3.",
    );

    expect(seen).toEqual([
      {
        type: "tool",
        tool: "ticket_create",
        input: {
          title: "Fix the page in the screenshot",
          body: "The page looks wrong, see the attached screenshot.",
        },
      },
    ]);

    expect(text).toBe("Filed it.");
  });

  it("asks first when the pull request is in review, because the verb refuses", async () => {
    const { seen, text } = await play(
      chat(talk([false, "For PR #1, also say goodbye."])),
      () => "",
      (a) => a.type === "tool" && a.tool === "work_attach",
    );

    expect(seen).toEqual([{ type: "tool", tool: "work_attach", input: { target: "1" } }]);
    expect(text).toBe("Add this to PR #1, which is in review, or do it as a follow-up?");
  });

  it("attaches with the human's word, restating the request they made first", async () => {
    const { seen } = await play(
      chat(
        talk(
          [false, "For PR #1, also say goodbye."],
          [true, "<@U1> Add this to PR #1, which is in review, or do it as a follow-up?"],
          [false, "This PR."],
        ),
      ),
      () => "",
    );

    expect(seen).toEqual([
      {
        type: "tool",
        tool: "work_attach",
        input: { target: "1", confirmed: true, request: "For PR #1, also say goodbye." },
      },
    ]);
  });

  it("answers a question in the thread of running work without attaching", async () => {
    const { seen, text } = await play(
      chat({
        ...talk([false, "Where do the greetings live?"]),
        about: { itemId: "w9", title: "review feedback", state: "running" as const },
      }),
      () => "1. [SHOP-1 Add a greeting](x) (running)\n",
    );

    expect(seen).toEqual([{ type: "tool", tool: "work", input: {} }]);
    expect(text).toContain("greeting.txt");
  });

  it("attaches an instruction in the thread of running work to that work, confirmed", async () => {
    const { seen } = await play(
      chat({
        ...talk([false, "Also keep it on one line."]),
        about: { itemId: "w9", title: "review feedback", state: "running" as const },
      }),
      () => "",
    );

    expect(seen).toEqual([
      {
        type: "tool",
        tool: "work_attach",
        input: { target: "SHOP-1", confirmed: true, request: "Also keep it on one line." },
      },
    ]);
  });

  it("reads the reply from the journal when the session goes on with the thread's conversation", async () => {
    const { seen } = await play(
      chat({
        ...ctx,
        kind: "chat",
        about: { itemId: "w9", title: "review feedback", state: "running" as const },
        journal:
          "- 2026-01-01T00:00:00Z office: Ada replied in chat (thread t1):\nAlso end it with a full stop.",
      }),
      () => "",
    );

    expect(seen).toEqual([
      {
        type: "tool",
        tool: "work_attach",
        input: { target: "SHOP-1", confirmed: true, request: "Also end it with a full stop." },
      },
    ]);
  });

  it("files a ticket for a follow-up, and never attaches", async () => {
    const { seen } = await play(
      chat(
        talk(
          [false, "For PR #1, also say goodbye."],
          [true, "Add this to PR #1, which is in review, or do it as a follow-up?"],
          [false, "A follow-up please."],
        ),
      ),
      () => "",
    );

    expect(seen.map((a) => (a.type === "tool" ? a.tool : a.type))).toEqual(["ticket_create"]);
  });
});

describe("reviewFeedback", () => {
  it("starts at the review gate, so a driver can hold the round", async () => {
    const script = reviewFeedback({ ...ctx, kind: "review_feedback", pr: 1 });
    expect((await script.next()).value).toEqual({ type: "gate", name: "review" });
  });
});

describe("reviewFeedback follows the repository's own commit rules", () => {
  const round = (rules: string) =>
    play(
      reviewFeedback({
        ...ctx,
        kind: "review_feedback",
        pr: 1,
        feedback: [{ kind: "review", body: "Please fix.", threads: ["PRRT_1"] }],
      }),
      (a) =>
        a.type === "read" && a.path.endsWith("CONTRIBUTING.md")
          ? rules
          : a.type === "read"
            ? "hello\nworld\n"
            : a.type === "shell" && a.command === "git rev-parse --abbrev-ref HEAD"
              ? "assigned/w1-add-a-greeting"
              : a.type === "shell" && a.command.startsWith("git log")
                ? "origin/assigned/w1-add-a-greeting|SHOP-1: Add a greeting"
                : a.type === "tool" && a.tool === "pr_threads"
                  ? "PRRT_1 open"
                  : "abc123",
    );

  const shells = (seen: Action[]) => seen.flatMap((a) => (a.type === "shell" ? [a.command] : []));

  it("amends and pushes with a lease when the rules ask for one commit", async () => {
    const { seen } = await round("One commit per pull request.");
    expect(shells(seen)).toContain("git commit --amend --no-edit");
    expect(shells(seen)).toContain(
      "git push --force-with-lease origin HEAD:'assigned/w1-add-a-greeting'",
    );

    expect(shells(seen).some((c) => c.startsWith("git commit -m"))).toBe(false);
  });

  it("adds a commit and pushes plainly when the rules say nothing about one commit", async () => {
    const { seen } = await round("Add commits for review feedback; never rewrite pushed history.");
    expect(shells(seen)).toContain("git commit -m 'SHOP-1: address review'");
    expect(shells(seen)).toContain("git push origin HEAD:'assigned/w1-add-a-greeting'");
    expect(shells(seen).some((c) => c.includes("--amend"))).toBe(false);
  });
});
