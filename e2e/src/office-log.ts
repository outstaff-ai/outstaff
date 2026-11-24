/**
 * The kind of each round the office queued for a person, in order, from its log: one per work item. A wake the office
 * folds into an item already open for that person is logged too ("folded the wake into"), but joins that round
 * instead of making another, so it is not counted again. A wake that took over a held item (", taking over work item
 * <id>") replaces that item's round: the held item never runs.
 */
export function wakesIn(log: string, person: string): string[] {
  const line = new RegExp(
    `pipeline: (?:queued|folded the wake into) work item (\\S+) for ${person} \\((\\w+)\\)(?:, taking over work item ([^\\s"]+))?`,
    "g",
  );

  const rounds = new Map<string, string>();
  for (const [, item, kind, over] of log.matchAll(line)) {
    if (over) {
      rounds.delete(over);
    }

    if (!rounds.has(item!)) {
      rounds.set(item!, kind!);
    }
  }

  return [...rounds.values()];
}
