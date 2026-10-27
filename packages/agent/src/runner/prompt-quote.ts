/** Quotes a body someone wrote, line by line, or says it has no text. */
export function quoteBody(body: string, prefix: string): string[] {
  const text = body.trim();

  return (text ? text.split("\n") : ["(no text)"]).map((l) => `${prefix}${l}`);
}
