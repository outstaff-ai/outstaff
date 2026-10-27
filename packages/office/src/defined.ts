/**
 * The properties that are not `undefined`, so optional ones can be passed on under `exactOptionalPropertyTypes`
 * without a `...(x === undefined ? {} : { x })` per key. Only `undefined` is dropped; `null`, `""`, `0` and `false` stay.
 */
export function defined<T extends Record<string, unknown>>(
  props: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}
