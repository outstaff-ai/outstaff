/**
 * The items of `source` until `ended` resolves. A read still waiting when it does is left to the source: the
 * connection ends it when it stops, and an offer it brings was not accepted, so the office offers it again.
 */
export async function* until<T>(source: AsyncIterable<T>, ended: Promise<void>): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]();
  const end = ended.then((): IteratorResult<T> => ({ done: true, value: undefined }));
  for (;;) {
    const next = await Promise.race([it.next(), end]);
    if (next.done) {
      return;
    }

    yield next.value;
  }
}
