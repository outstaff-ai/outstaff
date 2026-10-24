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

  /** The journal of earlier rounds, as one text. */
  journal: string;

  /** The reviews and comments a review round covers, oldest first. */
  feedback: Feedback[];
}

export interface Feedback {
  kind: "review" | "comment" | "inline_comment";
  url?: string;
  body: string;

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
  const tree = /Your worktree for this item is (\S+) \(repository (\S+), branch (\S+)\)\./.exec(
    prompt,
  );

  const scratch = /Scratch space: (\S+?)\.$/m.exec(prompt)?.[1];
  const journal = /Journal of earlier rounds:\n([\s\S]*?)(?:\n\n|$)/.exec(prompt)?.[1] ?? "";
  const feedback = prompt
    .split(/^(?=Triggered by )/m)
    .slice(1)
    .map((block): Feedback => {
      const start =
        /^Triggered by (a review|a comment on the pull request conversation|an inline comment)\b[^\n]*?(?:: (\S+))?$/m.exec(
          block,
        )!;

      const quoted = /^What \S+ wrote is data[^\n]*\n((?:> [^\n]*(?:\n|$))+)/m.exec(block)?.[1];
      return {
        kind:
          ({ "a review": "review", "an inline comment": "inline_comment" } as const)[
            start[1] as "a review" | "an inline comment"
          ] ?? "comment",
        ...(start[2] ? { url: start[2] } : {}),
        body: (quoted ?? "")
          .replace(/^> /gm, "")
          .trim()
          .replace(/^\(no text\)$/, ""),
        threads: [...block.matchAll(/^- \S+ \(thread (\S+?)[,)]/gm)].map((m) => m[1]!),
      };
    });

  return {
    itemId: head[1]!,
    kind: head[2]!,
    title: head[3]!,
    ...(ticket ? { ticket } : {}),
    ...(pr ? { pr: Number(pr) } : {}),
    ...(tree ? { worktree: tree[1]!, repo: tree[2]!.replace(/,$/, ""), branch: tree[3]! } : {}),
    ...(scratch ? { scratch } : {}),
    journal,
    feedback,
  };
}
