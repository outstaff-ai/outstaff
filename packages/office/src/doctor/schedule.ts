/**
 * The next time of day `at` (HH:MM) after `now`, in the process's time zone (the container's TZ). Computed from the
 * calendar each time, so a day with a daylight-saving change still runs at the same wall-clock time.
 */
export function nextDailyRun(now: Date, at: string): Date {
  const [hours, minutes] = at.split(":").map(Number) as [number, number];
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
    next.setHours(hours, minutes, 0, 0);
  }

  return next;
}
