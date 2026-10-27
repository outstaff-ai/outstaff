/** The office's handlers still running, so stopping can wait for them. */
export function inFlightTracker(): {
  inFlight: Set<Promise<unknown>>;
  track: <T>(p: Promise<T>) => Promise<T>;
} {
  const inFlight = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    inFlight.add(p);
    void p.then(
      () => inFlight.delete(p),
      () => inFlight.delete(p),
    );

    return p;
  };

  return { inFlight, track };
}
