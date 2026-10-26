import type { LinkMessage } from "@outstaff/protocol";
import { nextTraces } from "./cursor.js";
import type { Notifier, OfficeLinkOptions, TraceCursor } from "./link.types.js";
import { listPeople } from "./people.js";
import { present } from "./present.js";

const BATCH = 100;

/**
 * What the office tells a connected service without being asked: the people when they change, each trace as it is
 * recorded, and items that were queued or changed status. It looks for changes rather than being told of them, so
 * nothing else in the office changes for it.
 */
export function createNotifier(opts: OfficeLinkOptions, send: (m: LinkMessage) => void): Notifier {
  const { store, clock } = opts;
  let people: string | undefined;
  let cursor: TraceCursor = { sent: new Set() };
  let items = new Map<string, string>();

  const sendPeople = async (always: boolean) => {
    const list = await listPeople(opts);
    const json = JSON.stringify(list);
    if (always || json !== people) {
      people = json;
      send({ type: "people", payload: { at: clock.now().toISOString(), people: list } });
    }
  };

  const statuses = async () => new Map((await store.listItems()).map((i) => [i.id, i]));

  return {
    async begin() {
      // Only what is recorded from now on is news; what was recorded at this very time is not.
      const from = clock.now().toISOString();
      const already = await store.listTracesRecorded({ from, limit: 1000 });
      cursor = { from, sent: new Set(already.map((t) => t.ref)) };
      items = new Map([...(await statuses())].map(([id, i]) => [id, i.status]));
      await sendPeople(true);
    },

    async look() {
      await sendPeople(false);
      for (;;) {
        const next = await nextTraces(store, cursor, BATCH);
        cursor = next.cursor;
        for (const item of next.items) {
          send({
            type: "trace",
            payload: { recordedAt: item.recordedAt, trace: present(item.trace, opts.links) },
          });
        }

        if (next.items.length < BATCH) {
          break;
        }
      }

      const now = await statuses();
      for (const [id, i] of now) {
        if (items.get(id) !== i.status) {
          send({
            type: "item",
            payload: {
              id,
              person: i.person,
              kind: i.kind,
              status: i.status,
              updatedAt: i.updatedAt,
            },
          });
        }
      }

      items = new Map([...now].map(([id, i]) => [id, i.status]));
    },
  };
}
