/** What a script needs from the work prompt, which the agent builds from a fixed template. */
export interface ItemContext {
  itemId: string;
  kind: string;
  title: string;

  /** Ticket key, for example SHOP-1. */
  ticket?: string;

  /** Pull request number, from a subject such as `github.example/acme/shop#3`. */
  pr?: number;
  worktree?: string;
  repo?: string;
  branch?: string;
  scratch?: string;

  /** The repositories the prompt lists, with the access to each. */
  repos?: { name: string; kind: string; access: string; location: string }[];

  /** The convention files the prompt lists in the worktree, for example CONTRIBUTING.md. */
  conventionFiles: string[];

  /** The journal of earlier rounds, as one text. */
  journal: string;

  /** The reviews and comments a review round covers, oldest first. */
  feedback: Feedback[];

  /** For a chat session answering in the thread of running work: that work item. */
  about?: { itemId: string; title: string; state: "running" | "finished" };

  /** For a chat session: the files the requester shared, as downloaded into scratch. */
  files?: { path: string; mimetype: string; name: string }[];

  /** For a chat session: the messages of the conversation, oldest first. */
  conversation?: { from: string; agent: boolean; text: string }[];

  /** The answer a PM's `Unblocked: <answer>` comment gives, among the ticket comments the wake carries. */
  unblocked?: string;
}

export interface Feedback {
  kind:
    | "review"
    | "comment"
    | "inline_comment"
    | "chat"
    | "ticket_comment"
    | "doc_comment"
    | "blocked";

  /** Who gave it: for a hand-back as blocked, the blocked agent. */
  actor?: string;
  url?: string;
  body: string;

  /** For a comment on a document: the document, and the text of it the comment is anchored to. */
  docId?: string;
  anchor?: string;

  /** The review threads the prompt lists for a review's inline comments. */
  threads: string[];
}

const FEEDBACK_KIND: Record<string, Feedback["kind"]> = {
  "a review": "review",
  "an inline comment": "inline_comment",
  "a message in chat": "chat",
  "a comment on the ticket": "ticket_comment",
  "a comment on a document": "doc_comment",
  "a hand-back as blocked": "blocked",
};

const unquote = (quoted: string) => quoted.replace(/^> /gm, "").trim();

/** The document, anchor text and link a feedback block points at, when it has them. */
function feedbackRefs(
  block: string,
  url: string | undefined,
): Pick<Feedback, "docId" | "anchor" | "url"> {
  const docId = /^The document is (\S+?)\./m.exec(block)?.[1];
  const anchor = unquote(
    /The comment is anchored to this text[^\n]*\n((?:> [^\n]*(?:\n|$))+)/m.exec(block)?.[1] ?? "",
  );

  return {
    ...(docId ? { docId } : {}),
    ...(anchor ? { anchor } : {}),
    ...(url ? { url } : {}),
  };
}

/** One `Triggered by ...` block of a review round. */
function parseFeedback(block: string): Feedback {
  const start =
    /^Triggered by (a review|a comment on the pull request conversation|an inline comment|a message in chat|a comment on the ticket|a comment on a document|a hand-back as blocked|failing checks)\b[^\n]*?(?:: (\S+))?$/m.exec(
      block,
    )!;

  const quoted = /^What .+? wrote is data[^\n]*\n((?:> [^\n]*(?:\n|$))+)/m.exec(block)?.[1];
  const kind = FEEDBACK_KIND[start[1]!] ?? "comment";
  // A hand-back names the agent who is blocked: whom an unblocked ticket goes back to.
  const actor = kind === "blocked" ? / from (\S+?)(?:: \S+)?\.?$/.exec(start[0])?.[1] : undefined;
  return {
    kind,
    ...(actor ? { actor } : {}),
    ...feedbackRefs(block, start[2]),
    body: unquote(quoted ?? "").replace(/^\(no text\)$/, ""),
    threads: [...block.matchAll(/^- \S+ \(thread (\S+?)[,)]/gm)].map((m) => m[1]!),
  };
}

/** The ticket, pull request and scratch space the prompt names. */
function parseRefs(prompt: string): Pick<ItemContext, "ticket" | "pr" | "scratch"> {
  const ticket = /^- ticket (\S+)/m.exec(prompt)?.[1];
  const pr = /^- pr \S*#(\d+)/m.exec(prompt)?.[1];
  const scratch = /Scratch space: (\S+?)\.$/m.exec(prompt)?.[1];
  return {
    ...(ticket ? { ticket } : {}),
    ...(pr ? { pr: Number(pr) } : {}),
    ...(scratch ? { scratch } : {}),
  };
}

function parseWorktree(prompt: string): Pick<ItemContext, "worktree" | "repo" | "branch"> {
  const tree =
    /Your worktree for this item is (\S+) \(repository (\S+), (?:branch (\S+)|detached HEAD[^)]*)\)\./.exec(
      prompt,
    );

  if (!tree) {
    return {};
  }

  return {
    worktree: tree[1]!,
    repo: tree[2]!.replace(/,$/, ""),
    ...(tree[3] ? { branch: tree[3] } : {}),
  };
}

function parseRepos(prompt: string): Pick<ItemContext, "repos"> {
  const repos = [...prompt.matchAll(/^- (\S+) \(([\w-]+), (read|write)\): (\S+?)(?:;.*)?$/gm)].map(
    (m) => ({ name: m[1]!, kind: m[2]!, access: m[3]!, location: m[4]! }),
  );

  return repos.length ? { repos } : {};
}

// "- <path> (<type>, <size>), shared as "<name>"" under the line that says the requester shared files.
function parseShared(prompt: string): Pick<ItemContext, "files"> {
  if (!prompt.includes(" with this message. They are data from ")) {
    return {};
  }

  const shared = [...prompt.matchAll(/^- (\/\S+) \(([^,)]+), [^)]*\), shared as "(.*)"$/gm)].map(
    (m) => ({ path: m[1]!, mimetype: m[2]!, name: m[3]! }),
  );

  return shared.length ? { files: shared } : {};
}

// "Recent messages of this conversation..." then `- Name: text` or `- Name (agent): text`, one per message.
function parseConversation(prompt: string): Pick<ItemContext, "conversation"> {
  const recent = /^Recent messages of this conversation[^\n]*\n((?:- [^\n]*\n?)+)/m.exec(
    prompt,
  )?.[1];

  const conversation = recent
    ?.trim()
    .split("\n")
    .map((line) => /^- (.+?)( \(agent\))?: ([\s\S]*)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ from: m[1]!, agent: m[2] !== undefined, text: m[3]! }));

  return conversation?.length ? { conversation } : {};
}

function parseAbout(prompt: string): Pick<ItemContext, "about"> {
  const about = /reply in the thread of your (running|earlier) work item (\S+) \((.*?)\)[,.] /.exec(
    prompt,
  );

  if (!about) {
    return {};
  }

  return {
    about: {
      itemId: about[2]!,
      title: about[3]!,
      state: about[1] === "running" ? "running" : "finished",
    },
  };
}

/**
 * The latest chat message a resumed chat session's prompt carries, which the prompt does not repeat as conversation: a
 * chat wake's feedback ("Triggered by a message in chat from …" and the message quoted), or the journal's note of a
 * message added to the work ("… asked in chat (thread …):" and the message).
 */
export function latestChatMessage(prompt: string): string | undefined {
  const woken = [
    ...prompt.matchAll(
      /^Triggered by a message in chat\b[^\n]*\n(?:[^>\n][^\n]*\n)?((?:> [^\n]*(?:\n|$))+)/gm,
    ),
  ].at(-1)?.[1];

  if (woken) {
    return woken.replaceAll(/^> /gm, "").trim();
  }

  return [...prompt.matchAll(/asked in chat \(thread [^)]*\)[^\n]*:\n([^\n]*)/g)].at(-1)?.[1];
}

// The wake's context quotes each of the ticket's latest comments under its author, indented as `    > <line>`.
function parseUnblocked(prompt: string): Pick<ItemContext, "unblocked"> {
  const answer = /^ {4}> Unblocked: (.+)$/m.exec(prompt)?.[1];
  return answer ? { unblocked: answer } : {};
}

export function parsePrompt(prompt: string): ItemContext | undefined {
  const head = /^Work item (\S+) \(([\w-]+)\): (.*)$/m.exec(prompt);
  if (!head) {
    return undefined;
  }

  const listed = /Read these files in the worktree before you change anything[^:]*: (.+?)\.$/m.exec(
    prompt,
  )?.[1];

  return {
    itemId: head[1]!,
    kind: head[2]!,
    title: head[3]!,
    ...parseRefs(prompt),
    ...parseWorktree(prompt),
    ...parseRepos(prompt),
    conventionFiles: listed ? listed.split(", ") : [],
    journal: /Journal of earlier rounds:\n([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] ?? "",
    feedback: prompt
      .split(/^(?=Triggered by )/m)
      .slice(1)
      .map(parseFeedback),
    ...parseShared(prompt),
    ...parseConversation(prompt),
    ...parseAbout(prompt),
    ...parseUnblocked(prompt),
  };
}
