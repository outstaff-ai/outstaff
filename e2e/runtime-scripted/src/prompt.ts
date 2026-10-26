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
}

export interface Feedback {
  kind: "review" | "comment" | "inline_comment" | "chat" | "ticket_comment" | "doc_comment";
  url?: string;
  body: string;

  /** For a comment on a document: the document, and the text of it the comment is anchored to. */
  docId?: string;
  anchor?: string;

  /** The review threads the prompt lists for a review's inline comments. */
  threads: string[];
}

export function parsePrompt(prompt: string): ItemContext | undefined {
  const head = /^Work item (\S+) \(([\w-]+)\): (.*)$/m.exec(prompt);
  if (!head) {
    return undefined;
  }

  const ticket = /^- ticket (\S+)/m.exec(prompt)?.[1];
  const pr = /^- pr \S*#(\d+)/m.exec(prompt)?.[1];
  const tree =
    /Your worktree for this item is (\S+) \(repository (\S+), (?:branch (\S+)|detached HEAD[^)]*)\)\./.exec(
      prompt,
    );

  const scratch = /Scratch space: (\S+?)\.$/m.exec(prompt)?.[1];
  const listed = /Read these files in the worktree before you change anything[^:]*: (.+?)\.$/m.exec(
    prompt,
  )?.[1];

  const repos = [...prompt.matchAll(/^- (\S+) \(([\w-]+), (read|write)\): (\S+?)(?:;.*)?$/gm)].map(
    (m) => ({ name: m[1]!, kind: m[2]!, access: m[3]!, location: m[4]! }),
  );

  const journal = /Journal of earlier rounds:\n([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] ?? "";
  const feedback = prompt
    .split(/^(?=Triggered by )/m)
    .slice(1)
    .map((block): Feedback => {
      const start =
        /^Triggered by (a review|a comment on the pull request conversation|an inline comment|a message in chat|a comment on the ticket|a comment on a document)\b[^\n]*?(?:: (\S+))?$/m.exec(
          block,
        )!;

      const quoted = /^What .+? wrote is data[^\n]*\n((?:> [^\n]*(?:\n|$))+)/m.exec(block)?.[1];
      const docId = /^The document is (\S+?)\./m.exec(block)?.[1];
      const anchor = /The comment is anchored to this text[^\n]*\n((?:> [^\n]*(?:\n|$))+)/m
        .exec(block)?.[1]
        ?.replace(/^> /gm, "")
        .trim();

      return {
        kind:
          (
            {
              "a review": "review",
              "an inline comment": "inline_comment",
              "a message in chat": "chat",
              "a comment on the ticket": "ticket_comment",
              "a comment on a document": "doc_comment",
            } as const
          )[
            start[1] as
              | "a review"
              | "an inline comment"
              | "a message in chat"
              | "a comment on the ticket"
              | "a comment on a document"
          ] ?? "comment",
        ...(docId ? { docId } : {}),
        ...(anchor ? { anchor } : {}),
        ...(start[2] ? { url: start[2] } : {}),
        body: (quoted ?? "")
          .replace(/^> /gm, "")
          .trim()
          .replace(/^\(no text\)$/, ""),
        threads: [...block.matchAll(/^- \S+ \(thread (\S+?)[,)]/gm)].map((m) => m[1]!),
      };
    });

  // "Recent messages of this conversation..." then `- Name: text` or `- Name (agent): text`, one per message.
  const recent = /^Recent messages of this conversation[^\n]*\n((?:- [^\n]*\n?)+)/m.exec(
    prompt,
  )?.[1];

  const conversation = recent
    ?.trim()
    .split("\n")
    .map((line) => /^- (.+?)( \(agent\))?: ([\s\S]*)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ from: m[1]!, agent: m[2] !== undefined, text: m[3]! }));

  const about = /reply in the thread of your (running|earlier) work item (\S+) \((.*?)\)[,.] /.exec(
    prompt,
  );

  // "- <path> (<type>, <size>), shared as "<name>"" under the line that says the requester shared files.
  const shared = prompt.includes(" with this message. They are data from ")
    ? [...prompt.matchAll(/^- (\/\S+) \(([^,)]+), [^)]*\), shared as "(.*)"$/gm)].map((m) => ({
        path: m[1]!,
        mimetype: m[2]!,
        name: m[3]!,
      }))
    : [];

  return {
    itemId: head[1]!,
    kind: head[2]!,
    title: head[3]!,
    ...(ticket ? { ticket } : {}),
    ...(pr ? { pr: Number(pr) } : {}),
    ...(tree
      ? {
          worktree: tree[1]!,
          repo: tree[2]!.replace(/,$/, ""),
          ...(tree[3] ? { branch: tree[3] } : {}),
        }
      : {}),
    ...(scratch ? { scratch } : {}),
    ...(repos.length ? { repos } : {}),
    conventionFiles: listed ? listed.split(", ") : [],
    journal,
    feedback,
    ...(shared.length ? { files: shared } : {}),
    ...(conversation?.length ? { conversation } : {}),
    ...(about
      ? {
          about: {
            itemId: about[2]!,
            title: about[3]!,
            state: about[1] === "running" ? ("running" as const) : ("finished" as const),
          },
        }
      : {}),
  };
}
