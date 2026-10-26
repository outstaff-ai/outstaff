export const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
