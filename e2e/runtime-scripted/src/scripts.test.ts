import { describe, expect, it } from "vitest";
import {
  assigned,
  conflict,
  keepBoth,
  mergedFeedback,
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
  branch: "assigned/w1-add-a-greeting",
  journal: "",
};

/** Plays a script, answering each action with `answer`, and returns the actions and the final message. */
async function play(
  script: AsyncGenerator<Action, string, string>,
  answer: (a: Action) => string,
  fails: (a: Action) => boolean = () => false,
) {
  const seen: Action[] = [];
  let step = await script.next();
  while (!step.done) {
    const action = step.value;
    seen.push(action);
    step = fails(action)
      ? await script.throw(new Error("failed"))
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
          : "";

  it("takes the ticket, commits, pushes and opens a pull request that closes it", async () => {
    const { seen, text } = await play(assigned(ctx), answer);
    expect(
      seen.map((a) => (a.type === "tool" ? a.tool : a.type === "shell" ? a.command : a.type)),
    ).toEqual([
      "ticket_show",
      "ticket_move",
      "read",
      "write",
      "git add -A",
      "git commit -m 'SHOP-1: Add a greeting'",
      "git push origin 'assigned/w1-add-a-greeting'",
      "pr_open",
    ]);

    expect(seen.at(-1)).toMatchObject({ input: { body: "Closes SHOP-1\n" } });
    expect(text).toContain("https://github.acme.example/acme/shop/pull/1");
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

describe("conflict", () => {
  it("pushes with a lease on the sha it started from, and only after resolving the rebase", async () => {
    const { seen } = await play(
      conflict({ ...ctx, kind: "conflict", pr: 2, ticket: "SHOP-2" }),
      (a) => {
        if (a.type === "shell" && a.command.startsWith("git log --remotes")) {
          return "origin/main, origin/HEAD|Merge pull request #1\norigin/assigned/w2-second|SHOP-2: Second\n";
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
    branch: "merged_feedback/w5-follow-up",
    feedback: {
      kind: "comment" as const,
      url: "https://git.example/acme/shop/pull/1#c1",
      body: "Add a goodbye.",
    },
  };

  it("answers on the merged pull request, opens a follow-up from the default branch and links it", async () => {
    const { seen } = await play(mergedFeedback(merged), (a) =>
      a.type === "read"
        ? "hello\nworld\n"
        : a.type === "tool" && a.tool === "pr_open"
          ? "Opened acme/shop#3\nhttps://git.example/acme/shop/pull/3"
          : "",
    );

    const steps = seen.map((a) =>
      a.type === "tool" ? a.tool : a.type === "shell" ? a.command : a.type,
    );

    expect(steps.slice(0, 3)).toEqual([
      "pr_comment",
      "git fetch --prune origin",
      "git checkout -B 'merged_feedback/w5-follow-up' origin/main",
    ]);

    expect(steps.at(-2)).toBe("pr_open");
    expect(seen.find((a) => a.type === "tool" && a.tool === "pr_open")).toMatchObject({
      input: { body: expect.stringContaining("Follows up on #1, which is merged.") },
    });

    expect(seen.at(-1)).toMatchObject({
      tool: "pr_comment",
      input: { number: 1, body: "Follow-up: https://git.example/acme/shop/pull/3" },
    });
  });
});
