/**
 * The kind of each round the office queued for a person, in order, from its log: one per work item. A wake the office
 * folds into an item already open for that person is logged too ("folded the wake into"), but joins that round
 * instead of making another, so it is not counted again.
 */
export function wakesIn(log: string, person: string): string[] {
  const line = new RegExp(
    `pipeline: (?:queued|folded the wake into) work item (\\S+) for ${person} \\((\\w+)\\)`,
    "g",
  );

  const rounds = new Map<string, string>();
  for (const [, item, kind] of log.matchAll(line)) {
    if (!rounds.has(item!)) {
      rounds.set(item!, kind!);
    }
  }

  return [...rounds.values()];
}
