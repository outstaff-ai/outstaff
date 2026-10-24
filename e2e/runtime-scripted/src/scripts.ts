import type { ItemContext } from "./prompt.js";

/** One thing a script does. The runtime judges it with the policy, runs it and hands the result back. */
export type Action =
  | { type: "tool"; tool: string; input: Record<string, unknown> }
  | { type: "shell"; command: string; cwd: string }
  | { type: "write"; path: string; text: string }
  | { type: "read"; path: string };

/** A script yields actions and receives each result as text (a failed shell command throws into it). It returns its last message. */
export type Script = AsyncGenerator<Action, string, string>;

export const FILE = "greeting.txt";

const lines = (text: string) => text.replace(/\n$/, "").split("\n");

/** Line one of the file becomes `hello from <key>`; the rest stays. Two tickets that do this to one file conflict. */
export const withGreeting = (text: string, key: string) =>
  `${[`hello from ${key}`, ...lines(text).slice(1)].join("\n")}\n`;

/** Both sides of a conflicted first line, kept. */
export const keepBoth = (text: string, keys: string[]) =>
  `${[...keys.map((k) => `hello from ${k}`), ...lines(text).slice(1)].join("\n")}\n`;

/** The work item's title is `<kind>: <key> <ticket title>`; the ticket title is what the pull request is about. */
const subject = (title: string) => title.replace(/^[\w-]+: [A-Z]+-\d+ /, "");

const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) {
    throw new Error(`The prompt does not say ${what}.`);
  }

  return value;
}

/** The remote branch whose tip commit names the ticket: where the author pushed it. */
async function* branchOf(ctx: ItemContext, ticket: string): AsyncGenerator<Action, string, string> {
  const cwd = need(ctx.worktree, "the worktree");
  yield { type: "shell", command: "git fetch --prune origin", cwd };
  // Branch tips only: `<refs at the commit>|<subject>`, for example `origin/ticket/w1-x, origin/HEAD|SHOP-1: x`.
  const out = yield {
    type: "shell",
    command: "git log --remotes=origin --simplify-by-decoration --format='%D|%s'",
    cwd,
  };

  for (const line of out.split("\n")) {
    const [refs = "", tip = ""] = line.split("|");
    const branch = refs
      .split(", ")
      .map((r) => r.trim())
      .find((r) => r.startsWith("origin/") && r !== "origin/HEAD" && r !== "origin/main");

    if (branch && tip.startsWith(`${ticket}:`)) {
      return branch.slice("origin/".length);
    }
  }

  throw new Error(`No branch of ${ticket} on the remote.`);
}

/** A ticket is assigned: take it, change the file, push, open the pull request, and ask when the ticket says so. */
export async function* assigned(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  const cwd = need(ctx.worktree, "the worktree");
  const repo = need(ctx.repo, "the repository");
  const branch = need(ctx.branch, "the branch");
  const shown = yield { type: "tool", tool: "ticket_show", input: { key } };
  yield { type: "tool", tool: "ticket_move", input: { key, to: "active" } };
  const current = yield { type: "read", path: `${cwd}/${FILE}` };
  yield { type: "write", path: `${cwd}/${FILE}`, text: withGreeting(current, key) };
  yield { type: "shell", command: "git add -A", cwd };
  yield { type: "shell", command: `git commit -m ${q(`${key}: ${subject(ctx.title)}`)}`, cwd };
  yield { type: "shell", command: `git push origin ${q(branch)}`, cwd };
  const opened = yield {
    type: "tool",
    tool: "pr_open",
    input: { repo, title: `${key}: ${subject(ctx.title)}`, body: `Closes ${key}\n` },
  };

  const url = /https?:\/\/\S+/.exec(opened)?.[0] ?? "";
  const question = /^ask architect: (.+)$/m.exec(shown)?.[1];
  if (question) {
    yield { type: "tool", tool: "ask", input: { to: "architect", question } };
    return `Opened ${url}. Waiting for the architect.`;
  }

  return `Opened ${url}`;
}

/** A human gave feedback: fix on the pull request's own branch, answer every open thread and a summary or comment. */
export async function* reviewFeedback(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  const number = need(ctx.pr, "the pull request");
  const cwd = need(ctx.worktree, "the worktree");
  const repo = need(ctx.repo, "the repository");
  const branch = yield* branchOf(ctx, key);
  const threads = yield { type: "tool", tool: "pr_threads", input: { repo, number } };
  const feedback = ctx.feedback;
  // A review's prompt lists its inline comments with their threads; otherwise every open thread is meant.
  const ids = feedback?.threads.length
    ? feedback.threads
    : [...threads.matchAll(/^(PRRT_\w+)/gm)].map((m) => m[1]!);

  const conversational = feedback !== undefined && feedback.kind !== "inline_comment";
  if (ids.length === 0 && !conversational) {
    throw new Error("The feedback left no open thread and no summary or comment to answer.");
  }

  // The item's worktree starts from the default branch; the pull request lives on its own.
  yield { type: "shell", command: `git checkout -B fix-${number} origin/${branch}`, cwd };
  const current = yield { type: "read", path: `${cwd}/${FILE}` };
  yield {
    type: "write",
    path: `${cwd}/${FILE}`,
    text: `${current.replace(/\n$/, "")}\nreviewed\n`,
  };

  yield { type: "shell", command: "git add -A", cwd };
  yield { type: "shell", command: `git commit -m ${q(`${key}: address review`)}`, cwd };
  yield { type: "shell", command: `git push origin HEAD:${q(branch)}`, cwd };
  const sha = (yield { type: "shell", command: "git rev-parse --short HEAD", cwd }).trim();
  for (const thread of ids) {
    yield {
      type: "tool",
      tool: "pr_reply",
      input: { repo, number, thread, body: `Fixed in ${sha}.` },
    };

    yield { type: "tool", tool: "pr_resolve", input: { repo, number, thread } };
  }

  // A summary or a conversation comment has no thread: answer it on the pull request, quoting what it says.
  if (conversational && feedback.body) {
    const quote = feedback.body
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");

    yield {
      type: "tool",
      tool: "pr_comment",
      input: {
        repo,
        number,
        body: `${quote}\n\n${feedback.url ? `${feedback.url}\n\n` : ""}Fixed in ${sha}.`,
      },
    };
  }

  return `Addressed ${ids.length} thread${ids.length === 1 ? "" : "s"} on pull request ${number} (${sha}).`;
}

/**
 * A human commented on a merged pull request: answer on it, then open a follow-up pull request from the default
 * branch that links the original and the feedback, and link the follow-up from a second reply.
 */
export async function* mergedFeedback(ctx: ItemContext): Script {
  const number = need(ctx.pr, "the pull request");
  const cwd = need(ctx.worktree, "the worktree");
  const repo = need(ctx.repo, "the repository");
  const branch = need(ctx.branch, "the branch");
  const feedback = need(ctx.feedback, "the feedback");
  const quote = feedback.body
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

  const where = feedback.url ? `${feedback.url}\n\n` : "";
  yield {
    type: "tool",
    tool: "pr_comment",
    input: { repo, number, body: `${quote}\n\n${where}Thanks, I am opening a follow-up for this.` },
  };

  // The item's worktree may predate the merge: start from the default branch as it is now.
  yield { type: "shell", command: "git fetch --prune origin", cwd };
  yield { type: "shell", command: `git checkout -B ${q(branch)} origin/main`, cwd };
  const current = yield { type: "read", path: `${cwd}/${FILE}` };
  yield {
    type: "write",
    path: `${cwd}/${FILE}`,
    text: `${current.replace(/\n$/, "")}\nfollow-up\n`,
  };

  yield { type: "shell", command: "git add -A", cwd };
  yield { type: "shell", command: `git commit -m ${q(`chore: follow up on #${number}`)}`, cwd };
  yield { type: "shell", command: `git push origin ${q(branch)}`, cwd };
  const title = `${ctx.ticket ? `${ctx.ticket}: ` : ""}follow up on #${number}`;
  const opened = yield {
    type: "tool",
    tool: "pr_open",
    input: {
      repo,
      title,
      body: `Follows up on #${number}, which is merged.\n\nFeedback${feedback.url ? `: ${feedback.url}` : ""}\n\n${quote}\n`,
    },
  };

  const url = /https?:\/\/\S+/.exec(opened)?.[0] ?? "";
  yield {
    type: "tool",
    tool: "pr_comment",
    input: { repo, number, body: `Follow-up: ${url}` },
  };

  return `Answered on pull request ${number} and opened ${url}`;
}

/** The pull request no longer merges: rebase it on the default branch, resolve the conflict, push with a lease. */
export async function* conflict(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  const number = need(ctx.pr, "the pull request");
  const cwd = need(ctx.worktree, "the worktree");
  const branch = yield* branchOf(ctx, key);
  const lease = (yield {
    type: "shell",
    command: `git rev-parse origin/${branch}`,
    cwd,
  }).trim();

  yield { type: "shell", command: `git checkout -B rebase-${number} origin/${branch}`, cwd };
  let clean = true;
  try {
    yield { type: "shell", command: "git rebase origin/main", cwd };
  } catch {
    clean = false;
  }

  if (!clean) {
    const merged = yield { type: "read", path: `${cwd}/${FILE}` };
    const keys = [...merged.matchAll(/hello from (\S+)/g)].map((m) => m[1]!);
    const base = yield { type: "shell", command: `git show origin/main:${FILE}`, cwd };
    yield {
      type: "write",
      path: `${cwd}/${FILE}`,
      text: keepBoth(base, [...new Set([...keys.filter((k) => k !== key), key])]),
    };

    yield { type: "shell", command: `git add ${FILE}`, cwd };
    yield { type: "shell", command: "git rebase --continue", cwd };
  }

  yield {
    type: "shell",
    command: `git push --force-with-lease=${branch}:${lease} origin HEAD:${q(branch)}`,
    cwd,
  };

  return `Rebased pull request ${number} on main and pushed ${branch} with a lease.`;
}

export const SCRIPTS: Record<string, (ctx: ItemContext) => Script> = {
  assigned,
  ticket: assigned,
  review_feedback: reviewFeedback,
  merged_feedback: mergedFeedback,
  conflict,
};
