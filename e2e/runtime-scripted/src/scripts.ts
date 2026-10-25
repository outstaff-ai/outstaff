import type { ItemContext } from "./prompt.js";

/** One thing a script does. The runtime judges it with the policy, runs it and hands the result back. */
export type Action =
  | { type: "tool"; tool: string; input: Record<string, unknown> }
  | { type: "shell"; command: string; cwd: string }
  | { type: "write"; path: string; text: string }
  | { type: "read"; path: string }

  /** Waits until the end-to-end driver opens the gate; it is open unless the driver closed it. */
  | { type: "gate"; name: string };

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

/** The text of the convention files the prompt lists, read from the worktree as they are on its current checkout. */
async function* conventions(ctx: ItemContext, cwd: string): AsyncGenerator<Action, string, string> {
  const texts: string[] = [];
  for (const file of ctx.conventionFiles) {
    try {
      texts.push(yield { type: "read", path: `${cwd}/${file}` });
    } catch {
      // Listed but gone on this checkout: it states nothing.
    }
  }

  return texts.join("\n");
}

/** What the repository's rules say about a change to a pull request that is already pushed. */
const asksForOneCommit = (rules: string) => /\bone commit\b|\bsingle commit\b/i.test(rules);

/**
 * Commits the staged change to the pull request's branch the way the repository's own rules say: amended into its
 * one commit and pushed with a lease when they ask for one commit, else as a new commit.
 */
async function* commitToPush(
  ctx: ItemContext,
  cwd: string,
  branch: string,
  message: string,
): AsyncGenerator<Action, void, string> {
  const rules = yield* conventions(ctx, cwd);
  if (asksForOneCommit(rules)) {
    yield { type: "shell", command: "git commit --amend --no-edit", cwd };
    yield { type: "shell", command: `git push --force-with-lease origin HEAD:${q(branch)}`, cwd };
  } else {
    yield { type: "shell", command: `git commit -m ${q(message)}`, cwd };
    yield { type: "shell", command: `git push origin HEAD:${q(branch)}`, cwd };
  }
}

/** A ticket is assigned: take it, change the file, push, open the pull request, and ask when the ticket says so. */
export async function* assigned(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  const cwd = need(ctx.worktree, "the worktree");
  const repo = need(ctx.repo, "the repository");
  const branch = need(ctx.branch, "the branch");
  const shown = yield { type: "tool", tool: "ticket_show", input: { key } };
  yield { type: "tool", tool: "ticket_move", input: { key, to: "active" } };
  // The toolset's tools work in the worktree: the mise shim has a version set, not just an install behind it.
  const pnpm = (yield { type: "shell", command: "pnpm --version", cwd }).trim();
  if (!/^\d+\.\d+\.\d+/.test(pnpm)) {
    throw new Error(`pnpm --version printed "${pnpm}", not a version.`);
  }

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
  // The driver can hold a review round here to talk to the agent while it is under way.
  yield { type: "gate", name: "review" };
  const branch = yield* branchOf(ctx, key);
  const threads = yield { type: "tool", tool: "pr_threads", input: { repo, number } };
  const feedback = ctx.feedback;
  // A review's prompt lists its inline comments with their threads; otherwise every open thread is meant.
  const listed = feedback.flatMap((f) => f.threads);
  // A message from chat has no thread: it is answered on the pull request.
  const chatOnly = feedback.length > 0 && feedback.every((f) => f.kind === "chat");
  const ids = chatOnly
    ? []
    : listed.length > 0
      ? listed
      : [...threads.matchAll(/^(PRRT_\w+)/gm)].map((m) => m[1]!);

  const conversational = feedback.filter((f) => f.kind !== "inline_comment");
  if (ids.length === 0 && conversational.length === 0) {
    throw new Error("The feedback left no open thread and no summary or comment to answer.");
  }

  // The round's worktree is on the pull request's own branch; a branch of its own would leave the pull request behind.
  const here = (yield { type: "shell", command: "git rev-parse --abbrev-ref HEAD", cwd }).trim();
  // A waiting item may hold the branch itself; the round then works on a local branch of the same commit.
  if (here !== branch && !here.startsWith(`${branch}-`)) {
    throw new Error(`The worktree is on ${here}, not on the pull request's branch ${branch}.`);
  }

  const current = yield { type: "read", path: `${cwd}/${FILE}` };
  yield {
    type: "write",
    path: `${cwd}/${FILE}`,
    text: `${current.replace(/\n$/, "")}\nreviewed\n`,
  };

  yield { type: "shell", command: "git add -A", cwd };
  yield* commitToPush(ctx, cwd, branch, `${key}: address review`);
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
  for (const f of conversational.filter((c) => c.body)) {
    const quote = f.body
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");

    yield {
      type: "tool",
      tool: "pr_comment",
      input: {
        repo,
        number,
        body: `${quote}\n\n${f.url ? `${f.url}\n\n` : ""}Fixed in ${sha}.`,
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
  // A merged pull request gets one comment per round; the first piece of feedback is the one to answer.
  const feedback = need(ctx.feedback?.[0], "the feedback");
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

  const here = (yield { type: "shell", command: "git rev-parse --abbrev-ref HEAD", cwd }).trim();
  // A waiting item may hold the branch itself; the round then works on a local branch of the same commit.
  if (here !== branch && !here.startsWith(`${branch}-`)) {
    throw new Error(`The worktree is on ${here}, not on the pull request's branch ${branch}.`);
  }

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

const QUESTION = /in review, or do it as a follow-up\?/;

/**
 * A chat message in a chat session, beside a running round. A question about the work is answered from the office's
 * view of it; a request about an open pull request is attached to it, after asking when the pull request is in
 * review. Nothing is ever filed as a new ticket.
 */
export async function* chat(ctx: ItemContext): Script {
  const talk = ctx.conversation ?? [];
  const humans = talk.filter((m) => !m.agent);
  const latest = humans.at(-1)?.text ?? "";
  const asked = talk.find((m) => m.agent && QUESTION.test(m.text));
  const pr = /PR #(\d+)/i.exec(asked ? asked.text : latest)?.[1];
  if (!pr) {
    const work = yield { type: "tool", tool: "work", input: {} };
    const first = work.split("\n")[0] ?? "";
    return `Greetings live in greeting.txt on the main branch. Right now I am on: ${first}`;
  }

  if (asked) {
    // The human answered: this pull request, or a follow-up. The request is what they said first.
    const request = humans.find((m) => /PR #\d+/i.test(m.text))?.text ?? latest;
    if (/follow-?up/i.test(latest)) {
      yield {
        type: "tool",
        tool: "ticket_create",
        input: { title: request.slice(0, 80), body: request },
      };

      return "Filed a follow-up.";
    }

    yield {
      type: "tool",
      tool: "work_attach",
      input: { target: pr, confirmed: true, request },
    };

    return `Added to PR #${pr}.`;
  }

  // Without the human's word the verb refuses a pull request in review: ask in the thread, linking both options.
  try {
    yield { type: "tool", tool: "work_attach", input: { target: pr } };
    return `Added to PR #${pr}.`;
  } catch {
    return `Add this to PR #${pr}, which is in review, or do it as a follow-up?`;
  }
}

export const SCRIPTS: Record<string, (ctx: ItemContext) => Script> = {
  assigned,
  ticket: assigned,
  review_feedback: reviewFeedback,
  merged_feedback: mergedFeedback,
  conflict,
  chat,
};
