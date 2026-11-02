const MINUTE = 60_000;

/** How long before `now` the time `at` was, in words: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(at: string, now: Date): string {
  const ms = now.getTime() - Date.parse(at);
  if (Number.isNaN(ms)) {
    return "at an unknown time";
  }

  const minutes = Math.floor(ms / MINUTE);
  if (minutes < 1) {
    return "just now";
  }

  if (minutes < 60) {
    return `${minutes} min ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return `${hours} h ago`;
  }

  return `${Math.floor(hours / 24)} days ago`;
}

/** The time `at` to the minute in UTC with how long ago it was: "2026-01-31 09:14 UTC, 3 h ago". */
export function when(at: string, now: Date): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) {
    return at;
  }

  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC, ${ago(at, now)}`;
}
