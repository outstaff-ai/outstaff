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
  return {
    itemId: head[1]!,
    kind: head[2]!,
    title: head[3]!,
    ...(ticket ? { ticket } : {}),
    ...(pr ? { pr: Number(pr) } : {}),
    ...(tree ? { worktree: tree[1]!, repo: tree[2]!.replace(/,$/, ""), branch: tree[3]! } : {}),
    ...(scratch ? { scratch } : {}),
    journal,
  };
}
