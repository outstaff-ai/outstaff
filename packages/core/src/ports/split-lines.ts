/** Split text into chunks of at most `max` characters, breaking at line breaks where possible. */
export function splitAtLines(text: string, max: number): string[] {
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      chunks.push(current);
    }

    current = "";
  };

  for (const line of text.split("\n")) {
    if (line.length > max) {
      flush();
      for (let i = 0; i < line.length; i += max) {
        chunks.push(line.slice(i, i + max));
      }

      continue;
    }

    const next = current ? `${current}\n${line}` : line;
    if (next.length > max) {
      flush();
      current = line;
    } else {
      current = next;
    }
  }

  flush();
  return chunks.length ? chunks : [""];
}
