import type { Store } from "#/store/types.js";
import type { ActQueue, PendingAct } from "./act.types.js";

/** Acts an agent has not answered, kept per person until it does; the next `welcome` carries them. */
export const PENDING_ACT_SUBJECT = "pending_act";

interface Book {
  acts: PendingAct[];
}

export function createActQueue(store: Pick<Store, "getSubject" | "upsertSubject">): ActQueue {
  // Read, change, write: one at a time, so two changes to one person's book do not overwrite each other.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => undefined);
    return run;
  };

  const read = async (person: string): Promise<Book> =>
    ((await store.getSubject(PENDING_ACT_SUBJECT, person))?.data as Book | undefined) ?? {
      acts: [],
    };

  return {
    add: (person, act) =>
      locked(async () => {
        const book = await read(person);
        if (!book.acts.some((a) => a.id === act.id)) {
          await store.upsertSubject(PENDING_ACT_SUBJECT, person, { acts: [...book.acts, act] });
        }
      }),

    list: async (person) => (await read(person)).acts,

    take: (person, id) =>
      locked(async () => {
        const book = await read(person);
        const act = book.acts.find((a) => a.id === id);
        if (act) {
          await store.upsertSubject(PENDING_ACT_SUBJECT, person, {
            acts: book.acts.filter((a) => a !== act),
          });
        }

        return act;
      }),
  };
}
