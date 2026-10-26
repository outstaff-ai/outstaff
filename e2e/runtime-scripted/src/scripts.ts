import type { ItemContext } from "./prompt.js";

/** The JSON body of an `http` answer: the line between the headers and the data note. */
const body = (text: string) => /\n\n(\{.*\})\n/.exec(text)?.[1] ?? "(no body)";

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

/** The files the two pull requests of a split ticket add, so that neither conflicts with the greetings. */
export const PART_ONE = "farewell.txt";
export const PART_TWO = "footer.txt";

const lines = (text: string) => text.replace(/\n$/, "").split("\n");

/** Line one of the file becomes `hello from <key>`; the rest stays. Two tickets that do this to one file conflict. */
export const withGreeting = (text: string, key: string) =>
  `${[`hello from ${key}`, ...lines(text).slice(1)].join("\n")}\n`;

/** Both sides of a conflicted first line, kept. */
export const keepBoth = (text: string, keys: string[]) =>
  `${[...keys.map((k) => `hello from ${k}`), ...lines(text).slice(1)].join("\n")}\n`;

/** The work item's title is `<kind>: <key> <ticket title>`; the ticket title is what the pull request is about. */
const subject = (title: string) => title.replace(/^[\w-]+: [A-Z]+-\d+ /, "");

const slug = (text: string) =>
  text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 40)
    .replaceAll(/-+$/g, "");

/**
 * The branch to create: the repository's own rule when its files give one as `<type>/<key>-<slug>` in backticks,
 * else the default `feat/<key>-<slug>`, or `feat/<slug>` without a ticket.
 */
export function branchFor(rules: string, key: string | undefined, text: string): string {
  const type = /`([a-z]+)\/<key>-<slug>`/.exec(rules)?.[1] ?? "feat";
  return `${type}/${key ? `${key}-` : ""}${slug(text)}`;
}

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

/** The first link in a tool's answer: the ticket or pull request it is about. */
const firstUrl = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? "";

/**
 * A ticket is assigned: take it, change the file, push, open the pull request, and ask when the ticket says so. A
 * ticket that says `split: <title>` needs two pull requests, so it is split first: a sub-ticket with that title, the
 * parent told about it, then one pull request each (and a second one for the parent, which is refused).
 */
export async function* assigned(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  const cwd = need(ctx.worktree, "the worktree");
  const repo = need(ctx.repo, "the repository");
  const shown = yield { type: "tool", tool: "ticket_show", input: { key } };
  // A retry of a ticket that is blocked and still has its blocker: the agent moves nothing.
  const blocker = /^blocked: (.+)$/m.exec(shown)?.[1];
  if (blocker && /^Status: .*\(blocked\)/m.test(shown)) {
    return `Still blocked: ${blocker}`;
  }

  yield { type: "tool", tool: "ticket_move", input: { key, to: "active" } };
  // A ticket that says `blocked: <what>` cannot go on: the agent blocks it and still hands the item back as done.
  if (blocker) {
    yield { type: "tool", tool: "ticket_move", input: { key, to: "blocked" } };
    yield { type: "tool", tool: "ticket_comment", input: { key, body: `Blocked: ${blocker}` } };
    return `Stopped: ${blocker}`;
  }

  // The toolset's tools work in the worktree: the mise shim has a version set, not just an install behind it.
  const pnpm = (yield { type: "shell", command: "pnpm --version", cwd }).trim();
  if (!/^\d+\.\d+\.\d+/.test(pnpm)) {
    throw new Error(`pnpm --version printed "${pnpm}", not a version.`);
  }

  // A ticket that says `network: <what>` asks for the services the team granted: the hub needs no token, the home
  // service does (added by the verb, never shown), and a service that was not granted is refused.
  if (/^network: /m.test(shown)) {
    const hub = yield {
      type: "tool",
      tool: "http",
      input: { service: "hub", method: "GET", path: "/hub/status" },
    };

    const home = yield {
      type: "tool",
      tool: "http",
      input: { service: "home", method: "GET", path: "/hub/secure" },
    };

    let refusal = "";
    try {
      yield {
        type: "tool",
        tool: "http",
        input: { service: "other", method: "GET", path: "/hub/status" },
      };
    } catch (e) {
      refusal = String(e);
    }

    if (!refusal.includes("is not an HTTP service granted")) {
      throw new Error(`The ungranted service was not refused: ${refusal}`);
    }

    yield {
      type: "tool",
      tool: "ticket_comment",
      input: {
        key,
        body: `Network check: hub ${body(hub)}; home ${body(home)}; other refused.`,
      },
    };

    return `Reached hub and home; other was refused.`;
  }

  // A ticket that says `which repo: unclear` names no repository, and there are two the agent can write to: the
  // agent asks in the ticket, linking the candidates, and waits. It does not take whichever one it was given.
  const writable = (ctx.repos ?? []).filter((r) => r.access === "write");
  if (/^which repo: unclear$/m.test(shown) && writable.length > 1) {
    const named = writable.filter((r) => shown.includes(r.name) || shown.includes(r.location));
    if (named.length !== 1) {
      const candidates = writable.map((r) => `\`${r.name}\` (${r.location})`).join(" or ");
      yield {
        type: "tool",
        tool: "ask",
        input: {
          to: "architect",
          question: `Which repository is ${key} for: ${candidates}? The ticket does not say, so I have changed nothing.`,
        },
      };

      return `Asked which repository ${key} is for; waiting for the answer. No change made.`;
    }
  }

  const part = /^split: (.+)$/m.exec(shown)?.[1];
  let sub: { key: string; url: string } | undefined;
  if (part) {
    const created = yield {
      type: "tool",
      tool: "ticket_create",
      input: { title: part, body: `The second pull request of ${key}.`, parent: key },
    };

    const subKey = /^Created (\S+?)\./m.exec(created)?.[1];
    if (!subKey) {
      throw new Error(`ticket_create did not say which ticket it created: ${created}`);
    }

    sub = { key: subKey, url: firstUrl(created) };
    yield {
      type: "tool",
      tool: "ticket_comment",
      input: { key, body: `Split: ${part} is ${sub.key}, ${sub.url}. One pull request each.` },
    };
  }

  // The worktree is detached at the default branch: now that the work is known, name the branch by the repo's rules.
  const rules = yield* conventions(ctx, cwd);
  const branch = branchFor(rules, key, subject(ctx.title));
  yield { type: "shell", command: `git switch -c ${q(branch)}`, cwd };
  if (sub) {
    yield { type: "write", path: `${cwd}/${PART_ONE}`, text: `goodbye from ${key}\n` };
  } else {
    const current = yield { type: "read", path: `${cwd}/${FILE}` };
    yield { type: "write", path: `${cwd}/${FILE}`, text: withGreeting(current, key) };
  }

  yield { type: "shell", command: "git add -A", cwd };
  yield { type: "shell", command: `git commit -m ${q(`${key}: ${subject(ctx.title)}`)}`, cwd };
  yield { type: "shell", command: `git push origin ${q(branch)}`, cwd };
  const opened = yield {
    type: "tool",
    tool: "pr_open",
    input: { repo, title: `${key}: ${subject(ctx.title)}`, body: `Closes ${key}\n` },
  };

  const url = firstUrl(opened);
  if (sub) {
    // The sub-ticket's change is on a branch of its own, from the default branch, in a file of its own.
    const second = branchFor(rules, sub.key, part!);
    yield { type: "shell", command: "git fetch --prune origin", cwd };
    yield { type: "shell", command: `git switch -c ${q(second)} origin/main`, cwd };
    yield { type: "write", path: `${cwd}/${PART_TWO}`, text: `goodbye from ${sub.key}\n` };
    yield { type: "shell", command: "git add -A", cwd };
    yield { type: "shell", command: `git commit -m ${q(`${sub.key}: ${part}`)}`, cwd };
    yield { type: "shell", command: `git push origin ${q(second)}`, cwd };
    const opened2 = yield {
      type: "tool",
      tool: "pr_open",
      input: { repo, title: `${sub.key}: ${part}`, body: `Closes ${sub.key}\n` },
    };

    // Back on the parent's branch: the branch names the ticket a pull request links to.
    yield { type: "shell", command: `git switch ${q(branch)}`, cwd };
    // A second pull request for the parent is refused; the answer names the pull request it has.
    try {
      yield {
        type: "tool",
        tool: "pr_open",
        input: { repo, title: `${key}: more of the same`, body: `Closes ${key}\n` },
      };
    } catch (e) {
      if (!String(e).includes(url)) {
        throw new Error(`The refusal does not name ${url}.`, { cause: e });
      }

      return `Opened ${url} and ${firstUrl(opened2)}, one per ticket (${key}, ${sub.key}).`;
    }

    throw new Error(`A second pull request for ${key} was not refused.`);
  }

  // A ticket that asks for a design document gets one next to its pull request.
  const design = /^doc: (.+)$/m.exec(shown)?.[1];
  if (design) {
    const written = yield {
      type: "tool",
      tool: "doc_create",
      input: {
        path: `design/${key}.md`,
        title: design,
        body: `# ${design}\n\nKeep the cart in the session.\n\nThe alternative is the database.\n`,
      },
    };

    return `Opened ${url}. The design is ${firstUrl(written)}.`;
  }

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

  // A short "yes" answers an earlier comment (the agent's own proposal): read the conversation to know what it says.
  const approval = conversational.find((f) => f.kind === "comment" && /^yes\b/i.test(f.body));
  let proposal: string | undefined;
  if (approval) {
    const talk = yield { type: "tool", tool: "pr_conversation", input: { repo, number } };
    proposal = /^\s*> Proposal: (.+)$/m.exec(talk)?.[1]?.trim();
    if (!proposal) {
      throw new Error("The conversation holds no proposal for the reply to answer.");
    }
  }

  const current = yield { type: "read", path: `${cwd}/${FILE}` };
  yield {
    type: "write",
    path: `${cwd}/${FILE}`,
    text: `${current.replace(/\n$/, "")}\n${proposal ?? "reviewed"}\n`,
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
        body: `${quote}\n\n${f.url ? `${f.url}\n\n` : ""}${f === approval ? `Done as proposed: ${proposal}. ` : ""}Fixed in ${sha}.`,
      },
    };
  }

  return `Addressed ${ids.length} thread${ids.length === 1 ? "" : "s"} on pull request ${number} (${sha}).`;
}

/**
 * A trusted human commented on a document the agent wrote: read every open comment, change the document once, reply
 * to each comment and resolve the threads it answered.
 */
export async function* docFeedback(ctx: ItemContext): Script {
  const feedback = need(ctx.feedback[0], "the feedback");
  const doc = need(feedback.docId, "the document");
  if (!feedback.anchor) {
    throw new Error("The prompt does not give the text the comment is anchored to.");
  }

  const shown = yield { type: "tool", tool: "doc_show", input: { id: doc } };
  // `- <id> [resolved] (reply to <id>) <author>: <text>`; the threads to answer are the open top-level comments.
  const open = [...shown.matchAll(/^- (\S+) (\[resolved\] )?(\(reply to \S+\) )?.+?: /gm)]
    .filter((m) => m[2] === undefined && m[3] === undefined)
    .map((m) => m[1]!);

  if (open.length === 0) {
    throw new Error("The document has no open comment to answer.");
  }

  const text = /^\S.*\n\S+\n\n([\s\S]*?)\n\nComments \(/.exec(shown)?.[1];
  if (text === undefined) {
    throw new Error(`doc_show did not show the text of the document: ${shown}`);
  }

  yield {
    type: "tool",
    tool: "doc_update",
    input: { id: doc, body: `${text}\n\nRevised after review: ${feedback.body}\n` },
  };

  for (const comment of open) {
    yield {
      type: "tool",
      tool: "doc_reply",
      input: { doc, commentId: comment, body: "Updated the document; see the revised section." },
    };
  }

  // Resolve only a thread whose last word is ours: read the comments again just before. Comments list their author's name.
  const after = (yield { type: "tool", tool: "doc_show", input: { id: doc } }).split("\n");
  for (const comment of open) {
    const thread = after.filter(
      (l) => l.startsWith(`- ${comment} `) || l.includes(`(reply to ${comment})`),
    );

    if (/ Sam Duarte: /.test(thread.at(-1) ?? "")) {
      yield { type: "tool", tool: "doc_resolve", input: { doc, commentId: comment } };
    }
  }

  return `Answered ${open.length} comment${open.length === 1 ? "" : "s"} on the document and updated it.`;
}

/** A trusted human commented on the ticket: answer on it. */
export async function* ticketComment(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  const feedback = need(ctx.feedback[0], "the comment");
  yield { type: "tool", tool: "ticket_show", input: { key } };
  yield {
    type: "tool",
    tool: "ticket_comment",
    input: { key, body: `Noted: ${feedback.body}` },
  };

  return `Answered the comment on ${key}.`;
}

/**
 * A human commented on a merged pull request: answer on it, then open a follow-up pull request from the default
 * branch that links the original and the feedback, and link the follow-up from a second reply.
 */
export async function* mergedFeedback(ctx: ItemContext): Script {
  const number = need(ctx.pr, "the pull request");
  const cwd = need(ctx.worktree, "the worktree");
  const repo = need(ctx.repo, "the repository");
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

  // The merged pull request's ticket has its pull request, so the follow-up is a sub-ticket with its own.
  let own: string | undefined;
  if (ctx.ticket) {
    const created = yield {
      type: "tool",
      tool: "ticket_create",
      input: {
        title: `Follow up on #${number}`,
        body: `Feedback on the merged #${number}.`,
        parent: ctx.ticket,
      },
    };

    own = /^Created (\S+?)\./m.exec(created)?.[1];
  }

  // The item's worktree may predate the merge: start from the default branch as it is now.
  yield { type: "shell", command: "git fetch --prune origin", cwd };
  const branch = branchFor(
    yield* conventions(ctx, cwd),
    own ?? ctx.ticket,
    `follow up on ${number}`,
  );

  yield { type: "shell", command: `git switch -c ${q(branch)} origin/main`, cwd };
  const current = yield { type: "read", path: `${cwd}/${FILE}` };
  yield {
    type: "write",
    path: `${cwd}/${FILE}`,
    text: `${current.replace(/\n$/, "")}\nfollow-up\n`,
  };

  yield { type: "shell", command: "git add -A", cwd };
  yield { type: "shell", command: `git commit -m ${q(`chore: follow up on #${number}`)}`, cwd };
  yield { type: "shell", command: `git push origin ${q(branch)}`, cwd };
  const title = `${own ? `${own}: ` : ""}follow up on #${number}`;
  const opened = yield {
    type: "tool",
    tool: "pr_open",
    input: {
      repo,
      title,
      body: `${own ? `Closes ${own}\n\n` : ""}Follows up on #${number}, which is merged.\n\nFeedback${feedback.url ? `: ${feedback.url}` : ""}\n\n${quote}\n`,
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
  if (ctx.about) {
    // A reply in the thread of running or finished work: an instruction is attached to that work, a question is answered.
    const target = ctx.ticket ?? (ctx.pr === undefined ? undefined : String(ctx.pr));
    // A session that goes on with the thread's conversation has no history in its prompt: the reply is in the journal.
    const said =
      [...ctx.journal.matchAll(/replied in chat \(thread \S+\):\n([^\n]*)/g)].at(-1)?.[1] ?? latest;

    if (target && /^(also|please|split)\b/i.test(said)) {
      yield {
        type: "tool",
        tool: "work_attach",
        input: { target, confirmed: true, request: said },
      };

      return `Noted for ${target}.`;
    }

    const work = yield { type: "tool", tool: "work", input: {} };
    return `Greetings live in greeting.txt on the main branch. Right now I am on: ${work.split("\n")[0] ?? ""}`;
  }

  // New work is filed as a ticket, which the office turns into the work.
  const filed = /^new work: (.+)$/i.exec(latest)?.[1];
  if (filed) {
    yield { type: "tool", tool: "ticket_create", input: { title: filed, body: filed } };
    return "Filed.";
  }

  // A message with pictures is a request to file: the ticket gets the files, which the agent attaches itself.
  if (ctx.files?.length) {
    yield {
      type: "tool",
      tool: "ticket_create",
      input: {
        title: "Fix the page in the screenshot",
        body: "The page looks wrong, see the attached screenshot.",
      },
    };

    return "Filed it.";
  }

  const asked = talk.find((m) => m.agent && QUESTION.test(m.text));
  const pr = /PR #(\d+)/i.exec(asked ? asked.text : latest)?.[1];
  if (!pr) {
    const work = yield { type: "tool", tool: "work", input: {} };
    const first = work.split("\n")[0] ?? "";
    return `Greetings live in greeting.txt on the main branch. Right now I am on: ${first}`;
  }

  if (asked) {
    // The human answered: this pull request, or a follow-up. The request is what they said first.
    const before = talk.slice(0, talk.indexOf(asked)).filter((m) => !m.agent);
    const request = before.findLast((m) => /PR #\d+/i.test(m.text))?.text ?? latest;
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

/** An allowed approver approved the pull request: run the verb and report; a refusal is the answer. */
export async function* merge(ctx: ItemContext): Script {
  const number = need(ctx.pr, "the pull request");
  const repo = need(ctx.repo, "the repository");
  yield { type: "tool", tool: "pr_merge", input: { repo, number } };
  return "Ran pr merge.";
}

/** The checks of the pull request fail: look at them and say so on the ticket. */
export async function* ciFailed(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  const number = need(ctx.pr, "the pull request");
  const repo = need(ctx.repo, "the repository");
  const shown = yield { type: "tool", tool: "pr_status", input: { repo, number } };
  yield {
    type: "tool",
    tool: "ticket_comment",
    input: {
      key,
      body: `CI failed on #${number}: ${/- failing: .*/.exec(shown)?.[0] ?? "see the checks"}`,
    },
  };

  return `Looked at the failing checks of pull request ${number}.`;
}

export const SCRIPTS: Record<string, (ctx: ItemContext) => Script> = {
  assigned,
  ticket: assigned,
  review_feedback: reviewFeedback,
  merged_feedback: mergedFeedback,
  merge,
  doc_feedback: docFeedback,
  ticket_comment: ticketComment,
  conflict,
  ci_failed: ciFailed,
  chat,
};
