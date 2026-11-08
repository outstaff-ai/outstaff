import { homedir } from "node:os";
import type { Feedback, ItemContext } from "./prompt.js";
import { answerTeammate, decideTopic, decideWithPm, teammateInChat } from "./decide.js";
import { fileForLater, planInChat, plannedTickets, startNextMilestone } from "./plan.js";
import { milestoneDone, placeFeature, planFeature, startMilestone } from "./roadmap.js";

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

/** The file the later sub-ticket of a split ticket adds, when its agent is woken for it on the parent. */
export const PART_THREE = "banner.txt";

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

/** Runs a command the policy must deny; it fails the script when the command runs or fails for another reason. */
async function* mustBeDenied(command: string, cwd: string): AsyncGenerator<Action, void, string> {
  try {
    yield { type: "shell", command, cwd };
  } catch (e) {
    if (/denied by the policy/.test(String(e))) {
      return;
    }

    throw e;
  }

  throw new Error(`${command} ran; the policy should deny it.`);
}

/** The first link in a tool's answer: the ticket or pull request it is about. */
const firstUrl = (text: string) => /https?:\/\/\S+/.exec(text)?.[0] ?? "";

/**
 * A ticket that says `blocked: <what>` cannot go on: the agent blocks it, says why, and still hands the item back as
 * done. The office made the ticket active when the round started, a retry of a blocked ticket too. A blocked ticket the
 * PM answered (`unblocked`, from the comment the wake carries) goes on with the answer instead. Returns the message to
 * stop with, or undefined to go on.
 */
async function* blockIfStuck(
  key: string,
  shown: string,
  unblocked?: string,
): AsyncGenerator<Action, string | undefined, string> {
  const blocker = /^blocked: (.+)$/m.exec(shown)?.[1];
  if (!blocker) {
    return undefined;
  }

  if (unblocked !== undefined) {
    yield {
      type: "tool",
      tool: "ticket_comment",
      input: { key, body: `Resumed with: ${unblocked}` },
    };

    // The decision is the result to review: a done hand-back needs one.
    const written = yield {
      type: "tool",
      tool: "doc_create",
      input: {
        path: `decisions/${key}.md`,
        title: `${key}: decided`,
        body: `# Decided\n\n${unblocked}\n`,
      },
    };

    return `Resumed: ${unblocked}. The decision is ${firstUrl(written)}.`;
  }

  yield { type: "tool", tool: "ticket_move", input: { key, to: "blocked" } };
  yield { type: "tool", tool: "ticket_comment", input: { key, body: `Blocked: ${blocker}` } };
  return `Stopped: ${blocker}`;
}

/** The toolset works in the worktree, ordinary shell work runs in the sandbox, and the hard denies still hold. */
async function* checkSandbox(cwd: string): AsyncGenerator<Action, void, string> {
  // The toolset's tools work in the worktree: the mise shim has a version set, not just an install behind it.
  const pnpm = (yield { type: "shell", command: "CI=1 pnpm --version", cwd }).trim();
  if (!/^\d+\.\d+\.\d+/.test(pnpm)) {
    throw new Error(`pnpm --version printed "${pnpm}", not a version.`);
  }

  // Ordinary shell work runs inside the sandbox: variables, a subshell, a pipe into a here-document reader.
  yield {
    type: "shell",
    command: `(cd .. && pwd) && echo "$HOME" > /dev/null && cat <<'EOF' | wc -l\nchecked\nEOF`,
    cwd,
  };

  // The hard denies still hold: printing the environment, a push to the default branch, privilege tools.
  for (const command of ["env", "cat /proc/self/environ", "git push origin main", "sudo true"]) {
    yield* mustBeDenied(command, cwd);
  }
}

/**
 * A ticket that says `network: <what>` asks for the services the team granted: the hub needs no token, the home
 * service does (added by the verb, never shown), and a service that was not granted is refused.
 */
async function* checkNetwork(key: string): AsyncGenerator<Action, string, string> {
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

/**
 * A ticket that says `recall: <words>` asks what the agent remembers: it recalls the words, then the same about the
 * ticket numbered `recall about ticket:` in this ticket's project (the number alone, so this ticket names no other)
 * and with the person `recall with:` names, and reports all three on the ticket.
 */
async function* recallHistory(key: string, shown: string): AsyncGenerator<Action, string, string> {
  const query = need(/^recall: (.+)$/m.exec(shown)?.[1], "what to recall");
  const number = need(/^recall about ticket: (\d+)$/m.exec(shown)?.[1], "what the recall is about");
  const about = `${key.slice(0, key.lastIndexOf("-"))}-${number}`;
  const person = need(/^recall with: (.+)$/m.exec(shown)?.[1], "whom the recall is with");
  const all = yield { type: "tool", tool: "recall", input: { query } };
  const aboutIt = yield { type: "tool", tool: "recall", input: { query, about } };
  const withThem = yield { type: "tool", tool: "recall", input: { query, with: person } };
  yield {
    type: "tool",
    tool: "ticket_comment",
    input: {
      key,
      body: `Recall:\n${all}\n\nRecall about ${about}:\n${aboutIt}\n\nRecall with ${person}:\n${withThem}`,
    },
  };

  return `Recalled ${query}.`;
}

/**
 * A ticket whose whole work is a check, answered in a comment (`network:`, `recall:`): the answer is conclusive, so
 * the agent closes the ticket and the round is done. Returns the message to stop with, or undefined to go on.
 */
async function* answerOnTicket(
  key: string,
  shown: string,
): AsyncGenerator<Action, string | undefined, string> {
  const network = /^network: /m.test(shown);
  if (!network && !/^recall: /m.test(shown)) {
    return undefined;
  }

  const answer = network ? yield* checkNetwork(key) : yield* recallHistory(key, shown);
  yield { type: "tool", tool: "ticket_move", input: { key, to: "done" } };
  return answer;
}

/**
 * A ticket that says `cross-repo: <what>` also needs a change in ops: the round adds a worktree there with
 * `ost worktree add`, edits, commits and pushes in it. A repository without a grant is refused first.
 */
async function* crossRepo(key: string): AsyncGenerator<Action, string, string> {
  let refusal = "";
  try {
    yield { type: "tool", tool: "worktree_add", input: { repo: "acme/billing" } };
  } catch (e) {
    refusal = String(e);
  }

  if (!/no grant on "acme\/billing", so no worktree is added/.test(refusal)) {
    throw new Error(`A repository without a grant was not refused: ${refusal}`);
  }

  const branch = `chore/${key}-ops`;
  const added = yield { type: "tool", tool: "worktree_add", input: { repo: "ops", branch } };
  const cwd = need(/: (\/\S+), on /.exec(added)?.[1], "the added worktree");
  yield { type: "write", path: `${cwd}/NOTES.md`, text: `Notes for ${key}.\n` };
  yield { type: "shell", command: `git add -A && git commit -q -m ${q(`${key}: ops notes`)}`, cwd };
  yield { type: "shell", command: `git push -q origin HEAD:${q(branch)}`, cwd };
  const pushed = (yield {
    type: "shell",
    command: `git ls-remote origin ${q(branch)}`,
    cwd,
  }).trim();

  yield {
    type: "tool",
    tool: "ticket_comment",
    input: {
      key,
      body: `Cross-repo: pushed ${pushed.split(/\s+/)[0] ?? "?"} to ops ${branch} from ${cwd}; acme/billing refused: no grant.`,
    },
  };

  // The change in ops is the whole work: the ticket is done.
  yield { type: "tool", tool: "ticket_move", input: { key, to: "done" } };
  return `Changed ops on ${branch}.`;
}

/** A ticket that asks for a change in a second repository, or else none; undefined for any other ticket. */
async function* crossRepoIfAsked(
  key: string,
  shown: string,
): AsyncGenerator<Action, string | undefined, string> {
  return /^cross-repo: /m.test(shown) ? yield* crossRepo(key) : undefined;
}

/**
 * A ticket that says `which repo: unclear` names no repository, and there are two the agent can write to: the agent
 * asks in the ticket, linking the candidates, and waits. It does not take whichever one it was given. Returns the
 * message to stop with, or undefined when the repository is clear.
 */
async function* askWhichRepo(
  ctx: ItemContext,
  key: string,
  shown: string,
): AsyncGenerator<Action, string | undefined, string> {
  const writable = (ctx.repos ?? []).filter((r) => r.access === "write");
  if (!/^which repo: unclear$/m.test(shown) || writable.length <= 1) {
    return undefined;
  }

  const named = writable.filter((r) => shown.includes(r.name) || shown.includes(r.location));
  if (named.length === 1) {
    return undefined;
  }

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

/** The sub-ticket a split ticket's second pull request is for. */
interface SubTicket {
  key: string;
  url: string;
  title: string;
}

/** Files a sub-ticket of the parent, assigned to the caller, in the given status, blocked by the tickets named. */
async function* subTicket(
  key: string,
  title: string,
  status: "active" | "ready",
  blockedBy: string[] = [],
): AsyncGenerator<Action, SubTicket, string> {
  const created = yield {
    type: "tool",
    tool: "ticket_create",
    input: {
      title,
      body: `A part of ${key}.`,
      parent: key,
      assignee: "me",
      status,
      ...(blockedBy.length ? { blockedBy } : {}),
    },
  };

  const subKey = /^Created (\S+?)\./m.exec(created)?.[1];
  if (!subKey) {
    throw new Error(`ticket_create did not say which ticket it created: ${created}`);
  }

  return { key: subKey, url: firstUrl(created), title };
}

/**
 * Splits the ticket: a sub-ticket with the given title, started now; one for the part a `later: <title>` line names,
 * blocked by the first (a tracker link, no line in its description); and the parent told about both, in their order.
 */
async function* splitTicket(
  key: string,
  title: string,
  laterTitle: string | undefined,
): AsyncGenerator<Action, SubTicket, string> {
  const sub = yield* subTicket(key, title, "active");
  const later = laterTitle ? yield* subTicket(key, laterTitle, "ready", [sub.key]) : undefined;
  const order = later
    ? ` Then ${later.title} is ${later.key}, ${later.url}, once ${sub.key} merged.`
    : "";

  yield {
    type: "tool",
    tool: "ticket_comment",
    input: {
      key,
      body: `Split: ${title} is ${sub.key}, ${sub.url}, now.${order} One pull request each.`,
    },
  };

  return sub;
}

/** A ticket that says `split: <title>` (and maybe `later: <title>`) is split first; the sub-ticket started now. */
async function* splitIfAsked(
  key: string,
  shown: string,
): AsyncGenerator<Action, SubTicket | undefined, string> {
  const part = /^split: (.+)$/m.exec(shown)?.[1];
  const later = /^later: (.+)$/m.exec(shown)?.[1];
  return part ? yield* splitTicket(key, part, later) : undefined;
}

/**
 * Woken on the parent after one of its sub-tickets closed: the next open sub-ticket in the order planned gets its pull
 * request, on a branch of its own from the default branch.
 */
async function* nextSubTicket(
  ctx: ItemContext,
  parent: string,
  sub: string,
): AsyncGenerator<Action, string, string> {
  const cwd = need(ctx.worktree, "the worktree");
  const repo = need(ctx.repo, "the repository");
  const shown = yield { type: "tool", tool: "ticket_show", input: { key: sub } };
  // A part that waits on the human's review leaves nothing to do now. This agent hands back blocked, as one did live:
  // the office takes it as silent, since the parent only waits on work in flight.
  if (/^waits: review$/m.test(shown)) {
    yield { type: "tool", tool: "handback", input: { status: "blocked" } };
    return `Blocked until the human reviews ${sub}.`;
  }

  const rules = yield* conventions(ctx, cwd);
  const branch = branchFor(rules, sub, "the next part");
  yield { type: "shell", command: "git fetch --prune origin", cwd };
  yield { type: "shell", command: `git switch -c ${q(branch)} origin/main`, cwd };
  yield { type: "write", path: `${cwd}/${PART_THREE}`, text: `goodbye from ${sub}\n` };
  yield { type: "shell", command: "git add -A", cwd };
  yield { type: "shell", command: `git commit -m ${q(`${sub}: the next part of ${parent}`)}`, cwd };
  yield { type: "shell", command: `git push origin ${q(branch)}`, cwd };
  const opened = yield {
    type: "tool",
    tool: "pr_open",
    input: { repo, title: `${sub}: the next part of ${parent}`, body: `Closes ${sub}\n` },
  };

  return `Opened ${firstUrl(opened)} for ${sub}, the next part of ${parent}.`;
}

/** Makes the ticket's change on the new branch, commits and pushes it. */
async function* pushChange(
  ctx: ItemContext,
  cwd: string,
  key: string,
  branch: string,
  sub: SubTicket | undefined,
): AsyncGenerator<Action, void, string> {
  if (sub) {
    yield { type: "write", path: `${cwd}/${PART_ONE}`, text: `goodbye from ${key}\n` };
  } else {
    const current = yield { type: "read", path: `${cwd}/${FILE}` };
    yield { type: "write", path: `${cwd}/${FILE}`, text: withGreeting(current, key) };
  }

  yield { type: "shell", command: "git add -A", cwd };
  // The commit message goes in through a here-document, as agents write longer messages.
  yield {
    type: "shell",
    command: `git commit -F - <<'EOF'\n${key}: ${subject(ctx.title)}\nEOF`,
    cwd,
  };

  yield { type: "shell", command: `git push origin ${q(branch)}`, cwd };
}

/**
 * The sub-ticket's pull request, on a branch of its own from the default branch, in a file of its own; then a second
 * pull request for the parent, which is refused naming the one it has.
 */
async function* openSubTicketPr(
  ctx: ItemContext,
  opts: { key: string; sub: SubTicket; rules: string; branch: string; url: string },
): AsyncGenerator<Action, string, string> {
  const { key, sub, rules, branch, url } = opts;
  const cwd = need(ctx.worktree, "the worktree");
  const repo = need(ctx.repo, "the repository");
  const second = branchFor(rules, sub.key, sub.title);
  yield { type: "shell", command: "git fetch --prune origin", cwd };
  yield { type: "shell", command: `git switch -c ${q(second)} origin/main`, cwd };
  yield { type: "write", path: `${cwd}/${PART_TWO}`, text: `goodbye from ${sub.key}\n` };
  yield { type: "shell", command: "git add -A", cwd };
  yield { type: "shell", command: `git commit -m ${q(`${sub.key}: ${sub.title}`)}`, cwd };
  yield { type: "shell", command: `git push origin ${q(second)}`, cwd };
  const opened2 = yield {
    type: "tool",
    tool: "pr_open",
    input: { repo, title: `${sub.key}: ${sub.title}`, body: `Closes ${sub.key}\n` },
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

/** What the ticket asks for beside its pull request: a design document, or a question to the architect. */
async function* followUpOnTicket(
  key: string,
  shown: string,
  url: string,
): AsyncGenerator<Action, string, string> {
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

  yield* holdAfterPush(shown);
  yield { type: "tool", tool: "handback", input: { status: "done", message: addedFor(key) } };
  return `Opened ${url}`;
}

/** The message for the human of a ticket's first pull request, which their notice leads with. */
export const addedFor = (key: string) =>
  `Added the greeting ${key} asked for. Nothing else is needed from you.`;

/** The message for the human of a fix for failing checks. */
const fixedChecksOf = (number: number | string) =>
  `Fixed the failing checks of pull request ${number}; the greeting is unchanged.`;

/** A ticket that says `hold after pushing: <gate>`: the round waits there once it pushed, before it hands back. */
async function* holdAfterPush(shown: string): AsyncGenerator<Action, void, string> {
  const gate = /^hold after pushing: (\S+)$/m.exec(shown)?.[1];
  if (gate) {
    yield { type: "gate", name: gate };
  }
}

/**
 * A ticket that says `ask human: <question>` needs a human's decision first: the agent asks on the ticket and stops,
 * with nothing to review. It ends the round as if it were done; the runner refuses that, and the agent's answer to the
 * refusal (`nothingToReview`) is handed back as blocked. Returns the message to stop with, or undefined to go on.
 */
async function* askHuman(
  key: string,
  shown: string,
): AsyncGenerator<Action, string | undefined, string> {
  const question = /^ask human: (.+)$/m.exec(shown)?.[1];
  if (!question) {
    return undefined;
  }

  yield { type: "tool", tool: "ticket_comment", input: { key, body: `Question: ${question}` } };
  return `Waiting on an answer: ${question} Nothing changed yet.`;
}

/**
 * A round a reply in chat continued with only a check to make ("can you check if you have access now?"): the answer
 * goes on the ticket, and the ticket goes to review with it. Returns the message to stop with, or undefined to go on.
 */
async function* checkFromChat(
  ctx: ItemContext,
  key: string,
): AsyncGenerator<Action, string | undefined, string> {
  if (!ctx.feedback.some((f) => f.kind === "chat" && /\bcan you check\b/i.test(f.body))) {
    return undefined;
  }

  const answer = "Checked: I have access now.";
  yield { type: "tool", tool: "ticket_comment", input: { key, body: answer } };
  yield { type: "tool", tool: "ticket_move", input: { key, to: "review" } };
  return answer;
}

/** What the agent answers when the runner refuses a done hand-back with nothing to review. */
export const nothingToReview = (last: string) =>
  `Blocked: ${last || "nothing to review yet"} I need the answer from a human before I go on.`;

/** A ticket that says `usage: <key>` asks for `ost usage <key>`, posted on the ticket so the driver can read it. */
async function* postUsage(key: string, of: string): AsyncGenerator<Action, string, string> {
  const usage = yield { type: "tool", tool: "usage", input: { ticket: of } };
  yield { type: "tool", tool: "ticket_comment", input: { key, body: `ost usage:\n${usage}` } };
  return `Posted the usage of ${of} on ${key}.`;
}

/** A blocked ticket, one that only asks for usage, or a check asked in chat: the message to stop with, else undefined. */
async function* stopsEarly(
  ctx: ItemContext,
  key: string,
  shown: string,
): AsyncGenerator<Action, string | undefined, string> {
  const usageOf = /^usage: (\S+)$/m.exec(shown)?.[1];
  if (usageOf) {
    return yield* postUsage(key, usageOf);
  }

  return (yield* blockIfStuck(key, shown, ctx.unblocked)) ?? (yield* checkFromChat(ctx, key));
}

/** A ticket that says `hold: <gate>` keeps its round running until the driver opens that gate. */
async function* holdIfAsked(shown: string): AsyncGenerator<Action, void, string> {
  const hold = /^hold: (\S+)$/m.exec(shown)?.[1];
  if (hold) {
    yield { type: "gate", name: hold };
  }
}

/**
 * A ticket is assigned: read it, change the file, push, open the pull request, and ask when the ticket says so. A
 * ticket that says `split: <title>` needs two pull requests, so it is split first: a sub-ticket with that title, the
 * parent told about it, then one pull request each (and a second one for the parent, which is refused).
 */
export async function* assigned(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  // The PM has no repositories: her own tickets are the ones she filed from a confirmed plan.
  if (!ctx.worktree) {
    return yield* plannedTickets(ctx, key);
  }

  const next = ctx.openSubtickets?.[0];
  return next ? yield* nextSubTicket(ctx, key, next) : yield* workOnTicket(ctx, key);
}

/**
 * A ticket to plan a feature, or a decision to make with the PM; the work item's title may not carry the ticket's
 * title yet, the ticket does.
 */
async function* planIfAsked(
  ctx: ItemContext,
  key: string,
  shown: string,
): AsyncGenerator<Action, string | undefined, string> {
  const feature = new RegExp(`^${key}: Plan: (.+)$`, "m").exec(shown)?.[1];
  return feature ? yield* planFeature(ctx, key, feature) : yield* decideIfAsked(ctx, key, shown);
}

/** A decision to make with the PM, when the ticket is one. */
async function* decideIfAsked(
  ctx: ItemContext,
  key: string,
  shown: string,
): AsyncGenerator<Action, string | undefined, string> {
  const topic = decideTopic(key, shown);
  return topic ? yield* decideWithPm(ctx, key, topic) : undefined;
}

/** The ticket's own work, as `assigned` describes it. */
async function* workOnTicket(ctx: ItemContext, key: string): Script {
  const cwd = need(ctx.worktree, "the worktree");
  const repo = need(ctx.repo, "the repository");
  const shown = yield { type: "tool", tool: "ticket_show", input: { key } };
  yield* holdIfAsked(shown);
  const stopped =
    (yield* planIfAsked(ctx, key, shown)) ??
    (yield* stopsEarly(ctx, key, shown)) ??
    (yield* askHuman(key, shown));

  if (stopped !== undefined) {
    return stopped;
  }

  yield* checkSandbox(cwd);
  const checked = (yield* answerOnTicket(key, shown)) ?? (yield* crossRepoIfAsked(key, shown));
  if (checked !== undefined) {
    return checked;
  }

  const unclear = yield* askWhichRepo(ctx, key, shown);
  if (unclear !== undefined) {
    return unclear;
  }

  const sub = yield* splitIfAsked(key, shown);
  // The worktree is detached at the default branch: now that the work is known, name the branch by the repo's rules.
  const rules = yield* conventions(ctx, cwd);
  const branch = branchFor(rules, key, subject(ctx.title));
  yield { type: "shell", command: `git switch -c ${q(branch)}`, cwd };
  yield* pushChange(ctx, cwd, key, branch, sub);
  const opened = yield {
    type: "tool",
    tool: "pr_open",
    input: { repo, title: `${key}: ${subject(ctx.title)}`, body: `Closes ${key}\n` },
  };

  const url = firstUrl(opened);
  if (sub) {
    return yield* openSubTicketPr(ctx, { key, sub, rules, branch, url });
  }

  return yield* followUpOnTicket(key, shown, url);
}

/** The threads a review round answers: a review's prompt lists them; otherwise every open thread is meant. */
function threadsToAnswer(feedback: Feedback[], threads: string): string[] {
  // A message from chat has no thread: it is answered on the pull request.
  if (feedback.length > 0 && feedback.every((f) => f.kind === "chat")) {
    return [];
  }

  const listed = feedback.flatMap((f) => f.threads);
  return listed.length > 0 ? listed : [...threads.matchAll(/^(PRRT_\w+)/gm)].map((m) => m[1]!);
}

/**
 * Fails unless the round's worktree is on the pull request's own branch; a branch of its own would leave the pull
 * request behind. A waiting item may hold the branch itself; the round then works on a local branch of the same commit.
 */
async function* onBranch(cwd: string, branch: string): AsyncGenerator<Action, void, string> {
  const here = (yield { type: "shell", command: "git rev-parse --abbrev-ref HEAD", cwd }).trim();
  if (here !== branch && !here.startsWith(`${branch}-`)) {
    throw new Error(`The worktree is on ${here}, not on the pull request's branch ${branch}.`);
  }
}

/** The agent's own proposal an approval answers, read from the pull request's conversation. */
async function* proposalApproved(
  repo: string,
  number: number,
): AsyncGenerator<Action, string, string> {
  const talk = yield { type: "tool", tool: "pr_conversation", input: { repo, number } };
  const proposal = /^\s*> Proposal: (.+)$/m.exec(talk)?.[1]?.trim();
  if (!proposal) {
    throw new Error("The conversation holds no proposal for the reply to answer.");
  }

  return proposal;
}

/** A follow-up the round filed: its key, and its link for the reply. */
interface FiledFollowUp {
  key: string;
  url?: string;
}

/**
 * Files a reviewer's "follow-up: <title>", related to this ticket, in the backlog for later. "follow-up for <role>:
 * <title>" is work the reviewer asks of a teammate: filed for that role, ready, so the office wakes whoever has it.
 */
async function* fileFollowUp(
  key: string,
  conversational: Feedback[],
): AsyncGenerator<Action, FiledFollowUp | undefined, string> {
  const asked = conversational
    .map((f) => /^follow-up(?: for ([a-z]+))?: (.+)$/im.exec(f.body))
    .find(Boolean);

  if (!asked) {
    return undefined;
  }

  const [, role, title] = asked;
  const forRole = role ? { assignee: `role:${role}`, status: "ready" } : {};
  const created = yield {
    type: "tool",
    tool: "ticket_create",
    input: { title, body: `Asked for in the review of ${key}.`, ...forRole },
  };

  const filed = /^Created (\S+?)\./m.exec(created)?.[1];
  const url = /^(https?:\/\/\S+)$/m.exec(created)?.[1];
  return filed ? { key: filed, ...(url ? { url } : {}) } : undefined;
}

const quoted = (text: string) =>
  text
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");

/** Replies to and resolves every thread the round answers. */
async function* answerThreads(
  repo: string,
  number: number,
  ids: string[],
  sha: string,
): AsyncGenerator<Action, void, string> {
  for (const thread of ids) {
    yield {
      type: "tool",
      tool: "pr_reply",
      input: { repo, number, thread, body: `Fixed in ${sha}.` },
    };

    yield { type: "tool", tool: "pr_resolve", input: { repo, number, thread } };
  }
}

/** The answer to a summary or a conversation comment: what it says quoted, its link, and what was done. */
function conversationAnswer(
  f: Feedback,
  sha: string,
  approved?: string,
  followUp?: FiledFollowUp,
): string {
  const link = f.url ? `${f.url}\n\n` : "";
  const done = approved === undefined ? "" : `Done as proposed: ${approved}. `;
  const filed = followUp
    ? ` Filed the follow-up as ${followUp.url ? `[${followUp.key}](${followUp.url})` : followUp.key}.`
    : "";

  return `${quoted(f.body)}\n\n${link}${done}Fixed in ${sha}.${filed}`;
}

/** What a review round did, for its last message. */
function addressed(threads: number, number: number, sha: string, followUp?: string): string {
  const filed = followUp ? ` Filed follow-up ${followUp}.` : "";
  return `Addressed ${threads} thread${threads === 1 ? "" : "s"} on pull request ${number} (${sha}).${filed}`;
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
  const ids = threadsToAnswer(ctx.feedback, threads);
  const conversational = ctx.feedback.filter((f) => f.kind !== "inline_comment");
  if (ids.length === 0 && conversational.length === 0) {
    throw new Error("The feedback left no open thread and no summary or comment to answer.");
  }

  yield* onBranch(cwd, branch);
  // A short "yes" answers an earlier comment (the agent's own proposal): read the conversation to know what it says.
  const approval = conversational.find((f) => f.kind === "comment" && /^yes\b/i.test(f.body));
  const proposal = approval ? yield* proposalApproved(repo, number) : undefined;
  // A reviewer's "follow-up: <title>" is work for later, and "follow-up for <role>: <title>" a teammate's: either is
  // filed from here, related to this ticket, and not asked of anyone.
  const filedFollowUp = yield* fileFollowUp(key, conversational);
  const current = yield { type: "read", path: `${cwd}/${FILE}` };
  yield {
    type: "write",
    path: `${cwd}/${FILE}`,
    text: `${current.replace(/\n$/, "")}\n${proposal ?? "reviewed"}\n`,
  };

  yield { type: "shell", command: "git add -A", cwd };
  yield* commitToPush(ctx, cwd, branch, `${key}: address review`);
  const sha = (yield { type: "shell", command: "git rev-parse --short HEAD", cwd }).trim();
  yield* answerThreads(repo, number, ids, sha);
  // A summary or a conversation comment has no thread: answer it on the pull request, quoting what it says.
  for (const f of conversational.filter((c) => c.body)) {
    const answer = conversationAnswer(f, sha, f === approval ? proposal : undefined, filedFollowUp);
    yield { type: "tool", tool: "pr_comment", input: { repo, number, body: answer } };
  }

  return addressed(ids.length, number, sha, filedFollowUp?.key);
}

/** The open top-level comments `doc_show` lists, as `- <id> [resolved] (reply to <id>) <author>: <text>`. */
function openComments(shown: string): string[] {
  const open = [...shown.matchAll(/^- (\S+) (\[resolved\] )?(\(reply to \S+\) )?.+?: /gm)]
    .filter((m) => m[2] === undefined && m[3] === undefined)
    .map((m) => m[1]!);

  if (open.length === 0) {
    throw new Error("The document has no open comment to answer.");
  }

  return open;
}

/** The text of the document `doc_show` shows. */
function docText(shown: string): string {
  const text = /^\S.*\n\S+\n\n([\s\S]*?)\n\nComments \(/.exec(shown)?.[1];
  if (text === undefined) {
    throw new Error(`doc_show did not show the text of the document: ${shown}`);
  }

  return text;
}

/**
 * Resolves only a thread whose last word is ours: reads the comments again just before. Comments list their author's
 * name.
 */
async function* resolveAnswered(doc: string, open: string[]): AsyncGenerator<Action, void, string> {
  const after = (yield { type: "tool", tool: "doc_show", input: { id: doc } }).split("\n");
  for (const comment of open) {
    const thread = after.filter(
      (l) => l.startsWith(`- ${comment} `) || l.includes(`(reply to ${comment})`),
    );

    if (/ Sam Duarte: /.test(thread.at(-1) ?? "")) {
      yield { type: "tool", tool: "doc_resolve", input: { doc, commentId: comment } };
    }
  }
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
  const open = openComments(shown);
  const confirmed = /^confirmed: start (.+?)\.?$/i.exec(feedback.body.trim())?.[1];
  if (confirmed) {
    return yield* startMilestone(ctx, doc, open[0]!, confirmed);
  }

  yield {
    type: "tool",
    tool: "doc_update",
    input: { id: doc, body: `${docText(shown)}\n\nRevised after review: ${feedback.body}\n` },
  };

  for (const comment of open) {
    yield {
      type: "tool",
      tool: "doc_reply",
      input: { doc, commentId: comment, body: "Updated the document; see the revised section." },
    };
  }

  yield* resolveAnswered(doc, open);
  return `Answered ${open.length} comment${open.length === 1 ? "" : "s"} on the document and updated it.`;
}

/** `ask <name>, cc <other>: <question>` passed on: the question to the name, and the other named only for information. */
const passedOn = ([, to, cc, question]: RegExpExecArray) =>
  `@${to} ${question}${cc ? ` FYI @${cc}` : ""}`;

/**
 * A comment on the ticket: answer on it. One that says `ask <name>: <question>` is passed on with a mention of the
 * name, as the tracker writes it, for example `ask Pia.Novak: ...`; `ask <name>, cc <other>: <question>` also names
 * the other, for information only.
 */
export async function* ticketComment(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  const feedback = need(ctx.feedback[0], "the comment");
  if (ctx.backlog) {
    return yield* answerOnBacklog(key, feedback.body);
  }

  const decide = /^decide: (.+)$/m.exec(feedback.body)?.[1];
  if (decide) {
    return yield* askForDecision(key, decide);
  }

  // A thanks asks nothing of the agent: it posts nothing and finishes silently, leaving the ticket as it was.
  if (/^thanks\b/i.test(feedback.body.trim())) {
    yield { type: "tool", tool: "handback", input: { status: "silent" } };
    return `Nothing for me in the comment on ${key}.`;
  }

  const ask = /^ask ([^\s,]+)(?:, cc (\S+))?: (.+)$/m.exec(feedback.body);
  yield {
    type: "tool",
    tool: "ticket_comment",
    input: { key, body: ask ? passedOn(ask) : `Noted: ${feedback.body}` },
  };

  // A mention on someone else's ticket needs nothing handed on: the round finishes silently. On its own ticket the
  // agent's answer is for the human to review, so it moves the ticket to review.
  yield ctx.kind === "asked"
    ? { type: "tool", tool: "handback", input: { status: "silent" } }
    : { type: "tool", tool: "ticket_move", input: { key, to: "review" } };

  return ask ? `Asked ${ask[1]} on ${key}.` : `Answered the comment on ${key}.`;
}

/**
 * A comment on a ticket in backlog: the agent tries to start the work by filing it, which is refused, answers the
 * comment on the ticket, saying so, and finishes silently, leaving the ticket in backlog with its assignee.
 */
async function* answerOnBacklog(key: string, body: string): AsyncGenerator<Action, string, string> {
  let refused = "";
  try {
    yield { type: "tool", tool: "ticket_create", input: { title: `Start ${key}`, related: key } };
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }

  const started = refused
    ? `Not started: starting the work was refused: ${refused.split(":")[0]}.`
    : `Started: filed the work.`;

  yield {
    type: "tool",
    tool: "ticket_comment",
    input: { key, body: `Noted for later: ${body}\n${started}` },
  };

  yield { type: "tool", tool: "handback", input: { status: "silent" } };
  return `Answered the comment on ${key}, which stays in backlog.`;
}

/**
 * A comment that says `decide: <question>` needs a human's decision: the agent asks on the ticket and says it is done,
 * with nothing to review. The runner refuses that, and the agent's answer to the refusal is handed back as blocked.
 */
async function* askForDecision(
  key: string,
  question: string,
): AsyncGenerator<Action, string, string> {
  yield { type: "tool", tool: "ticket_comment", input: { key, body: `Question: ${question}` } };
  yield { type: "tool", tool: "handback", input: { status: "done" } };
  return `Asked: ${question}`;
}

/**
 * A mention on someone else's ticket. One that names the agent only so it knows (`FYI @<name>` at the end of a comment
 * to someone else) asks nothing of it: the round posts nothing and finishes silently. Any other is answered once, on
 * the ticket.
 */
export async function* mentioned(ctx: ItemContext): Script {
  const feedback = need(ctx.feedback[0], "the comment");
  if (/\bFYI @\S+\s*$/.test(feedback.body)) {
    yield { type: "tool", tool: "handback", input: { status: "silent" } };
    return "Mentioned for information only; nothing for me.";
  }

  return yield* ticketComment(ctx);
}

/** The merged pull request's ticket has its pull request, so the follow-up is a ticket of its own, related to it. */
async function* fileFollowUpTicket(
  ticket: string | undefined,
  number: number,
): AsyncGenerator<Action, string | undefined, string> {
  if (!ticket) {
    return undefined;
  }

  const created = yield {
    type: "tool",
    tool: "ticket_create",
    input: {
      title: `Follow up on #${number}`,
      body: `Feedback on the merged #${number}.`,
      related: ticket,
      assignee: "me",
      status: "active",
    },
  };

  return /^Created (\S+?)\./m.exec(created)?.[1];
}

/** The title and body of the follow-up pull request to a merged one. */
function followUpPr(number: number, feedback: Feedback, own?: string) {
  const closes = own ? `Closes ${own}\n\n` : "";
  const link = feedback.url ? `: ${feedback.url}` : "";
  return {
    title: `${own ? `${own}: ` : ""}follow up on #${number}`,
    body: `${closes}Follows up on #${number}, which is merged.\n\nFeedback${link}\n\n${quoted(feedback.body)}\n`,
  };
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
  const where = feedback.url ? `${feedback.url}\n\n` : "";
  yield {
    type: "tool",
    tool: "pr_comment",
    input: {
      repo,
      number,
      body: `${quoted(feedback.body)}\n\n${where}Thanks, I am opening a follow-up for this.`,
    },
  };

  const own = yield* fileFollowUpTicket(ctx.ticket, number);
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
  // The commit names the ticket, as every other commit here does, so a later rebase finds the branch (`branchOf`).
  const pr = followUpPr(number, feedback, own);
  yield { type: "shell", command: `git commit -m ${q(pr.title)}`, cwd };
  yield { type: "shell", command: `git push origin ${q(branch)}`, cwd };
  const opened = yield { type: "tool", tool: "pr_open", input: { repo, ...pr } };

  const url = firstUrl(opened);
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

  yield* onBranch(cwd, branch);
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

type Message = NonNullable<ItemContext["conversation"]>[number];

/** A status question is answered from the pull request itself, not from the office's list of work. */
async function* prStatus(number: string): AsyncGenerator<Action, string, string> {
  // `ost work` links the pull request; its address names the repository.
  const work = yield { type: "tool", tool: "work", input: {} };
  const repo = need(new RegExp(`\\((\\S+?)/pull/${number}\\)`).exec(work)?.[1], "the repository");
  const status = yield {
    type: "tool",
    tool: "pr_status",
    input: { repo, number: Number(number) },
  };

  return `Pull request ${number}:\n${status}`;
}

/** A question about the work, answered with a tool of the work session (a chat session has them) and `ost work`. */
async function* describeWork(): AsyncGenerator<Action, string, string> {
  yield { type: "shell", command: "CI=1 pnpm --version", cwd: homedir() };
  const work = yield { type: "tool", tool: "work", input: {} };
  const first = work.split("\n")[0] ?? "";
  return `Greetings live in greeting.txt on the main branch. Right now I am on: ${first}`;
}

/**
 * Whether the agent's question about where a request goes is still its last word in the thread, so the human's reply
 * answers it; a message after a settled question is something new.
 */
const awaitsAnswer = (talk: Message[]) => QUESTION.test(talk.findLast((m) => m.agent)?.text ?? "");

/** A reply in the thread of running or finished work: an instruction is attached to that work, a question is answered. */
async function* replyAboutWork(
  ctx: ItemContext,
  talk: Message[],
  latest: string,
): AsyncGenerator<Action, string, string> {
  if (awaitsAnswer(talk)) {
    return yield* attachToPr(talk, latest);
  }

  const target = ctx.ticket ?? (ctx.pr === undefined ? undefined : String(ctx.pr));
  // A session that goes on with the thread's conversation has no history in its prompt: the reply is in the journal.
  const said =
    [...ctx.journal.matchAll(/replied in chat \(thread \S+\):\n([^\n]*)/g)].at(-1)?.[1] ?? latest;

  if (target && /^(?:also|please|split)\b|\bcan you check\b/i.test(said)) {
    yield {
      type: "tool",
      tool: "work_attach",
      input: { target, confirmed: true, request: said },
    };

    return `Noted for ${target}.`;
  }

  return yield* describeWork();
}

/** Work for a teammate: the ticket is theirs, and the session tells the requester who has it. */
async function* fileFor(assignee: string, title: string): AsyncGenerator<Action, string, string> {
  const created = yield {
    type: "tool",
    tool: "ticket_create",
    input: { title, body: title, assignee },
  };

  return `Filed ${/Created (\S+)\./.exec(created)?.[1] ?? "it"} for ${assignee}; it is theirs.`;
}

/** The key of the ticket a `ticket_create` result names, and whom its role went to. */
const createdFor = (created: string) => ({
  key: need(/Created (\S+)\./.exec(created)?.[1], "the created ticket"),
  to: need(/Role \S+ went to (\S+)\./.exec(created)?.[1], "whom the role went to"),
});

/**
 * Work that spans two roles is one ticket per role, each assigned by role; the second needs the first, so the first
 * blocks it.
 */
async function* fileByRole([
  ,
  firstRole,
  first,
  secondRole,
  second,
]: RegExpExecArray): AsyncGenerator<Action, string, string> {
  const one = createdFor(
    yield {
      type: "tool",
      tool: "ticket_create",
      input: { title: first, body: first, assignee: `role:${firstRole}` },
    },
  );

  const two = createdFor(
    yield {
      type: "tool",
      tool: "ticket_create",
      input: {
        title: second,
        body: second,
        assignee: `role:${secondRole}`,
        blockedBy: [one.key],
      },
    },
  );

  return `Filed ${one.key} for ${one.to} and ${two.key} for ${two.to}, which waits on it.`;
}

/** A change to a ticket that exists is made on that ticket: retitled when asked, then assigned. Nothing is filed. */
async function* changeTicket(latest: string): AsyncGenerator<Action, string | undefined, string> {
  const asked = /^assign (\S+) to (\w+)(?:, retitled "(.+)")?\.?$/i.exec(latest);
  if (!asked) {
    return undefined;
  }

  const [, key, to, title] = asked;
  if (title) {
    yield { type: "tool", tool: "ticket_edit", input: { key, title } };
  }

  yield { type: "tool", tool: "ticket_assign", input: { key, to } };
  return `Assigned ${key} to ${to}; it is theirs now.`;
}

/** A change to a ticket that exists, or new work to file; undefined when the message asks for neither. */
async function* changeOrFile(
  ctx: ItemContext,
  latest: string,
): AsyncGenerator<Action, string | undefined, string> {
  return (
    (yield* changeTicket(latest)) ??
    (yield* fileFeature(latest)) ??
    (yield* fileRequest(ctx, latest))
  );
}

/** A feature is one ticket, to plan it; never its breakdown. Undefined for any other message. */
async function* fileFeature(latest: string): AsyncGenerator<Action, string | undefined, string> {
  const feature = /^feature: (.+)$/i.exec(latest)?.[1];
  if (!feature) {
    return undefined;
  }

  yield {
    type: "tool",
    tool: "ticket_create",
    input: { title: `Plan: ${feature}`, body: feature },
  };

  return "Filed a ticket to plan it.";
}

/** Work for a teammate, or for roles; undefined for any other message. */
async function* fileForOthers(latest: string): AsyncGenerator<Action, string | undefined, string> {
  const byRole = /^new work by role: (\w+): (.+?); then (\w+): (.+)$/i.exec(latest);
  if (byRole) {
    return yield* fileByRole(byRole);
  }

  const forOther = /^new work for (\w+): (.+)$/i.exec(latest);
  return forOther ? yield* fileFor(forOther[1] ?? "", forOther[2] ?? "") : undefined;
}

/**
 * New work is filed as a ticket, which the office turns into the work; a message with pictures is a request to file,
 * and the ticket gets the files, which the agent attaches itself. Returns undefined when the message asks for neither.
 */
async function* fileRequest(
  ctx: ItemContext,
  latest: string,
): AsyncGenerator<Action, string | undefined, string> {
  // The first line is the title; lines after it, when there are any, are the ticket's description.
  const [, filed, more] = /^new work: ([^\n]+)(?:\n([\s\S]+))?$/i.exec(latest) ?? [];
  if (filed) {
    const description = more ? `${filed}\n${more}` : filed;
    yield { type: "tool", tool: "ticket_create", input: { title: filed, body: description } };
    return "Filed.";
  }

  const forOthers = yield* fileForOthers(latest);
  if (forOthers !== undefined) {
    return forOthers;
  }

  if (!ctx.files?.length) {
    return undefined;
  }

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

/** The human answered the question: this pull request, or a follow-up. The request is what they said first. */
async function* answered(
  talk: Message[],
  asked: Message,
  latest: string,
  pr: string,
): AsyncGenerator<Action, string, string> {
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

/** A request about an open pull request is attached to it, after asking when the pull request is in review. */
async function* attachToPr(
  talk: Message[],
  latest: string,
): AsyncGenerator<Action, string, string> {
  const asked = talk.find((m) => m.agent && QUESTION.test(m.text));
  const pr = /PR #(\d+)/i.exec(asked ? asked.text : latest)?.[1];
  if (!pr) {
    return yield* describeWork();
  }

  if (asked) {
    return yield* answered(talk, asked, latest, pr);
  }

  // Without the human's word the verb refuses a pull request in review: ask in the thread, linking both options.
  try {
    yield { type: "tool", tool: "work_attach", input: { target: pr } };
    return `Added to PR #${pr}.`;
  } catch {
    return `Add this to PR #${pr}, which is in review, or do it as a follow-up?`;
  }
}

/** What the agent remembers, from the notes the session started with and the line about a change it does not use. */
function recall(ctx: ItemContext): string {
  const list = ctx.notes?.list ?? [];
  const head = list.length ? `I remember: ${list.join(" | ")}` : "I remember nothing yet.";
  return ctx.notes?.ignored ? `${head}\nNot used: ${ctx.notes.ignored}` : head;
}

/**
 * A trusted human's word about how the agent works: `remember: <text>` is noted with `ost note add`; `what do you
 * remember?` is answered from the notes. Undefined for any other message.
 */
async function* notes(
  ctx: ItemContext,
  latest: string,
): AsyncGenerator<Action, string | undefined, string> {
  const remember = /^remember: (.+)$/i.exec(latest)?.[1];
  if (remember) {
    yield { type: "tool", tool: "note_add", input: { text: remember } };
    return "Noted.";
  }

  return /^what do you remember\??$/i.test(latest) ? recall(ctx) : undefined;
}

/** The refusal of a write a chat session must not make; it fails the script when the write goes through. */
async function* refusedWrite(path: string): AsyncGenerator<Action, string, string> {
  try {
    yield { type: "write", path, text: "changed from chat\n" };
  } catch (e) {
    return String(e);
  }

  throw new Error(`A chat session wrote ${path}.`);
}

/**
 * "Change <file> in the worktree of pull request <n>: <what>". A chat session edits no repository file: the write is
 * refused, and the refusal in that item's worktree names the work and the attach command, which the session runs.
 */
async function* changeInWorktree(
  latest: string,
): AsyncGenerator<Action, string | undefined, string> {
  const asked = /^change (\S+) in the worktree of pull request (\d+): (.+)$/i.exec(latest);
  if (!asked) {
    return undefined;
  }

  const [, file, number] = asked;
  const root = `${homedir()}/worktrees/shop`;
  const dirs = (yield { type: "shell", command: `ls -1 ${q(root)}`, cwd: homedir() })
    .split("\n")
    .map((d) => d.trim())
    .filter(Boolean);

  for (const dir of dirs) {
    const refusal = yield* refusedWrite(`${root}/${dir}/${file}`);
    const target = /ost work attach (\S+) --confirmed\./.exec(refusal)?.[1];
    if (target?.endsWith(`#${number}`)) {
      // The refusal names the work; the reply says it in the agent's own line.
      const say = need(/This is the worktree of [^.]+\./.exec(refusal)?.[0], "whose worktree");

      yield {
        type: "tool",
        tool: "work_attach",
        input: { target, confirmed: true, request: latest, say },
      };

      return `The worktree is that pull request's work, so I added the request to ${target}.`;
    }
  }

  throw new Error(`No refusal named the work of pull request ${number}.`);
}

/**
 * "CI still fails on PR <n>": the wake context says whether that pull request is the agent's own. Its own is a fix to
 * its work, attached at once with the human's word; someone else's is left to them. Undefined for any other message.
 */
async function* ciStillFails(
  ctx: ItemContext,
  latest: string,
): AsyncGenerator<Action, string | undefined, string> {
  const number = /^CI still fails on PR #?(\d+)/i.exec(latest)?.[1];
  if (!number) {
    return undefined;
  }

  if (!ctx.yours?.includes(Number(number))) {
    return `PR #${number} is not mine, so I did not touch it.`;
  }

  yield {
    type: "tool",
    tool: "work_attach",
    input: {
      target: number,
      confirmed: true,
      request: latest,
      say: "Fixing the failing checks now.",
    },
  };

  return `Fixing CI on PR #${number}.`;
}

/**
 * "Why does the deploy still fail?": a round of the agent's own already fixes the failed checks of a merge (the wake
 * context lists it), so the request is attached to that round's ticket, which stays open, and no ticket is filed.
 * Undefined for any other message, or when no such round is listed.
 */
async function* deployStillFails(
  ctx: ItemContext,
  latest: string,
): AsyncGenerator<Action, string | undefined, string> {
  const round = /^why does the deploy still fail/i.test(latest)
    ? ctx.work?.find((w) => w.kind === "merge_checks_failed" && w.ticket)
    : undefined;

  if (!round) {
    return undefined;
  }

  yield {
    type: "tool",
    tool: "work_attach",
    input: {
      target: round.ticket,
      confirmed: true,
      request: latest,
      say: "My round on the failed deploy is already queued; it fixes it.",
    },
  };

  return `Attached to ${round.ticket}: the ${round.kind} round ${round.id} is ${round.status}.`;
}

/** What the chat message asks of the work: a pull request's status, a reply about work, or a change to file. */
async function* aboutWork(
  ctx: ItemContext,
  talk: Message[],
  latest: string,
): AsyncGenerator<Action, string, string> {
  const statusOf = /^what is the status of PR #(\d+)/i.exec(latest)?.[1];
  if (statusOf) {
    return yield* prStatus(statusOf);
  }

  if (ctx.about) {
    return yield* replyAboutWork(ctx, talk, latest);
  }

  const queued = yield* deployStillFails(ctx, latest);
  if (queued !== undefined) {
    return queued;
  }

  const fix = yield* ciStillFails(ctx, latest);
  if (fix !== undefined) {
    return fix;
  }

  const elsewhere = yield* changeInWorktree(latest);
  if (elsewhere !== undefined) {
    return elsewhere;
  }

  const done = yield* changeOrFile(ctx, latest);
  return done ?? (yield* attachToPr(talk, latest));
}

/** A chat message about the agent's notes or for a teammate, or the round with a teammate's answer. */
async function* notesOrTeammate(
  ctx: ItemContext,
  latest: string,
): AsyncGenerator<Action, string | undefined, string> {
  return (yield* notes(ctx, latest)) ?? (yield* teammateInChat(ctx, latest));
}

/**
 * A chat message in a chat session, beside a running round. A question about the work is answered from the office's
 * view of it; a request to change a ticket is made on that ticket; a request about an open pull request is attached
 * to it, after asking when the pull request is in review. A trusted human's
 * word about the agent's notes is noted or answered from them, and a ping is passed on to a teammate, whose answer
 * the next round passes on in the thread. Nothing is ever filed as a new ticket.
 */
export async function* chat(ctx: ItemContext): Script {
  const talk = ctx.conversation ?? [];
  const latest = talk.findLast((m) => !m.agent)?.text ?? "";
  return (
    (yield* notesOrTeammate(ctx, latest)) ??
    (yield* planInChat(talk, latest)) ??
    (yield* startNextMilestone(latest)) ??
    (yield* fileForLater(latest)) ??
    (yield* aboutWork(ctx, talk, latest))
  );
}

/**
 * Why the pull request should not merge yet, from the merge context: the one it is stacked on merges first, of two
 * approved pull requests that change the same files the older one goes first (the scripts' pull requests are the same
 * size), and one that conflicts is rebased first.
 */
function waitFor(ctx: ItemContext, number: number): string | undefined {
  const m = ctx.merge;
  const first = m?.others.find(
    (o) =>
      o.relation.includes("it is stacked on this one") ||
      (o.approved && o.relation.includes("changes the same files") && o.number < number),
  );

  if (first) {
    return `Waiting: #${first.number} merges first.`;
  }

  return m?.mergeable === "conflicting"
    ? `Waiting: #${number} conflicts with its base, so it is rebased first.`
    : undefined;
}

/** The pull request may be ready to merge: decide from the merge context, then run the verb or wait. */
export async function* merge(ctx: ItemContext): Script {
  const number = need(ctx.pr, "the pull request");
  const repo = need(ctx.repo, "the repository");
  const wait = waitFor(ctx, number);
  if (wait) {
    return wait;
  }

  yield { type: "tool", tool: "pr_merge", input: { repo, number } };
  return "Ran pr merge.";
}

/**
 * The checks of the pull request fail: look at them and say so on the ticket. A ticket that says `on failing checks:
 * push a fix` gets a fix pushed to the pull request's branch too.
 */
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

  const ticket = yield { type: "tool", tool: "ticket_show", input: { key } };
  if (!/^on failing checks: push a fix$/m.test(ticket)) {
    return `Looked at the failing checks of pull request ${number}.`;
  }

  const cwd = need(ctx.worktree, "the worktree");
  const branch = yield* branchOf(ctx, key);
  yield* onBranch(cwd, branch);
  const current = yield { type: "read", path: `${cwd}/${FILE}` };
  yield { type: "write", path: `${cwd}/${FILE}`, text: `${current.replace(/\n$/, "")}\nchecked\n` };
  yield { type: "shell", command: "git add -A", cwd };
  yield* commitToPush(ctx, cwd, branch, `${key}: fix the checks`);
  yield* holdAfterPush(ticket);
  yield {
    type: "tool",
    tool: "handback",
    input: { status: "done", message: fixedChecksOf(number) },
  };

  return `Fixed the failing checks of pull request ${number}.`;
}

/**
 * A check failed on the merge commit of the agent's pull request: read more of its log through the office, say on the
 * ticket what failed, and open a fix on the same ticket from the default branch.
 */
export async function* mergeChecksFailed(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  const number = need(ctx.pr, "the pull request");
  const cwd = need(ctx.worktree, "the worktree");
  const repo = need(ctx.repo, "the repository");
  const check = need(ctx.failedChecks?.[0], "the failed check");
  const url = need(check.url, "the failed check's link");
  const more = yield { type: "tool", tool: "ci_log", input: { url, lines: 50 } };
  const cause = /^ {2}(error: .*)$/m.exec(more)?.[1] ?? "see the log";
  const shown = yield { type: "tool", tool: "ticket_show", input: { key } };
  const outside = /^outside cause: (.+)$/m.exec(shown)?.[1];
  if (outside) {
    return yield* blockOnOutsideCause(key, number, check.name, `${outside} (${cause})`);
  }

  // The code host's CLI, through the wrapper's per-call token: re-run the failed run; a merge with it is refused.
  const run = need(/\/actions\/runs\/(\d+)\//.exec(url)?.[1], "the check's workflow run");
  yield { type: "shell", command: `gh run rerun ${run}`, cwd };
  yield* mustBeDenied(`gh pr merge ${number} --merge`, cwd);
  // The team's pinned extension, installed at start: its command runs; installing another is refused.
  const hello = String(yield { type: "shell", command: "gh hello", cwd }).trim();
  yield* mustBeDenied("gh extension install acme/gh-hello --pin v1.0.0", cwd);
  yield {
    type: "tool",
    tool: "ticket_comment",
    input: {
      key,
      body: `${check.name} failed after #${number} merged: ${check.lines.find((l) => l.startsWith("error:")) ?? "no log"} (from the wake). ost ci log: ${cause}. gh run rerun ${run}: requested. gh hello: ${hello}.`,
    },
  };

  yield { type: "shell", command: "git fetch --prune origin", cwd };
  const branch = branchFor(yield* conventions(ctx, cwd), key, `fix ${check.name} after ${number}`);
  yield { type: "shell", command: `git switch -c ${q(branch)} origin/main`, cwd };
  const current = yield { type: "read", path: `${cwd}/${FILE}` };
  yield {
    type: "write",
    path: `${cwd}/${FILE}`,
    text: `${current.replace(/\n$/, "")}\nregion: eu\n`,
  };

  yield { type: "shell", command: "git add -A", cwd };
  yield {
    type: "shell",
    command: `git commit -m ${q(`fix: set the region for ${check.name}`)}`,
    cwd,
  };

  yield { type: "shell", command: `git push origin ${q(branch)}`, cwd };

  const opened = yield {
    type: "tool",
    tool: "pr_open",
    input: {
      repo,
      title: `${key}: fix ${check.name} after #${number}`,
      body: `Closes ${key}\n\nFixes the ${check.name} check that failed on the merge commit of #${number}.\n`,
    },
  };

  return `${check.name} failed after #${number}; opened the fix ${firstUrl(opened)}`;
}

/**
 * A check that failed after the merge for a reason outside the pull request (`outside cause: <what>` on the ticket):
 * nothing in it to fix, so the agent blocks the ticket, says why, and hands it back for a human to decide.
 */
async function* blockOnOutsideCause(
  key: string,
  number: number,
  name: string,
  why: string,
): AsyncGenerator<Action, string, string> {
  yield { type: "tool", tool: "ticket_move", input: { key, to: "blocked" } };
  yield {
    type: "tool",
    tool: "ticket_comment",
    input: {
      key,
      body: `Blocked: ${name} failed after #${number} merged, from outside it: ${why}. Nothing in #${number} to fix.`,
    },
  };

  return `Stopped: ${name} failed after #${number} from outside the pull request: ${why}`;
}

/**
 * A workaround the PM would file as a ticket (`pm would file: <title>`). An unblock round starts no new work, so the
 * filing is refused; she proposes the work on the ticket instead, saying the filing was refused. Returns the comment.
 */
async function* proposeWorkaround(
  key: string,
  title: string,
): AsyncGenerator<Action, string, string> {
  let refused = "";
  try {
    yield { type: "tool", tool: "ticket_create", input: { title, related: key } };
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }

  const comment = refused
    ? `Proposal for a human: ${title}. Filing it myself was refused: ${refused.split(":")[0]}.`
    : `Filed: ${title}.`;

  yield { type: "tool", tool: "ticket_comment", input: { key, body: comment } };
  return comment;
}

/** The PM cannot unblock it: the ticket goes to the requester with what is needed, and any workaround as a proposal. */
async function* toRequester(
  ctx: ItemContext,
  key: string,
  blocked: string,
  shown: string,
): AsyncGenerator<Action, string, string> {
  const requester = need(
    /assign it to the requester, (\S+?), with a comment/.exec(ctx.journal)?.[1],
    "the requester",
  );

  const blocker = /^blocked: (.+)$/m.exec(shown)?.[1] ?? "see the ticket";
  const workaround = /^pm would file: (.+)$/m.exec(shown)?.[1];
  if (workaround) {
    yield* proposeWorkaround(key, workaround);
  }

  yield {
    type: "tool",
    tool: "ticket_comment",
    input: {
      key,
      body: `Needs a human: ${blocker}. Nobody on the team can provide it; ${blocked} carries on once it is here.`,
    },
  };

  yield { type: "tool", tool: "ticket_assign", input: { key, to: requester } };
  return `${key} needs a human: ${blocker}. Gave it to ${requester}.`;
}

/**
 * The PM unblocks a ticket an agent handed back as blocked. A ticket that says `pm knows: <answer>` is answered on the
 * ticket and given back to the blocked agent; any other needs a human, so it goes to the requester the office named,
 * with what is needed, and with the workaround she would have filed (`pm would file: <title>`) as a proposal.
 */
export async function* unblock(ctx: ItemContext): Script {
  const key = need(ctx.ticket, "the ticket");
  const blocked = need(
    ctx.feedback.find((f) => f.kind === "blocked")?.actor,
    "the agent who is blocked",
  );

  const shown = yield { type: "tool", tool: "ticket_show", input: { key } };
  const answer = /^pm knows: (.+)$/m.exec(shown)?.[1];
  if (answer) {
    yield { type: "tool", tool: "ticket_comment", input: { key, body: `Unblocked: ${answer}` } };
    yield { type: "tool", tool: "ticket_assign", input: { key, to: blocked } };
    return `Unblocked ${key}: ${answer}. Gave it back to ${blocked}.`;
  }

  return yield* toRequester(ctx, key, blocked, shown);
}

export const SCRIPTS: Record<string, (ctx: ItemContext) => Script> = {
  assigned,
  ticket: assigned,
  review_feedback: reviewFeedback,
  merged_feedback: mergedFeedback,
  merge,
  doc_feedback: docFeedback,
  ticket_comment: ticketComment,
  asked: mentioned,
  rebase: conflict,
  ci_failed: ciFailed,
  merge_checks_failed: mergeChecksFailed,
  unblock,
  question: (ctx) =>
    /Its plan: /.test(ctx.question?.text ?? "") ? placeFeature(ctx) : answerTeammate(ctx),
  milestone: milestoneDone,
  chat,
};
