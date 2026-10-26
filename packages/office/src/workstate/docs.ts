import type { WorkflowEvent } from "@outstaff/core";
import type { DocOps, WorkstateCore } from "./core.types.js";
import { docNode, personNode, ROOT } from "./links.js";
import type { DocRecord } from "./types.js";

/** Knowledge documents agents wrote, kept so comments on them reach the agent. */
export function createDocs(core: WorkstateCore): DocOps {
  const { store, clock, docs } = core;
  const saveDoc = async (rec: DocRecord) => {
    docs.set(rec.id, rec);
    await store.upsertSubject("doc", rec.id, rec);
    await store.link(ROOT, docNode(rec.id), "tracks");
    await store.link(docNode(rec.id), personNode(rec.author), "authored_by");
  };

  const touchDoc = async (id: string, event: WorkflowEvent) => {
    const rec = docs.get(id);
    const at = typeof event.data["at"] === "string" ? event.data["at"] : clock.now().toISOString();
    if (rec && Date.parse(at) > Date.parse(rec.touchedAt)) {
      await saveDoc({ ...rec, touchedAt: at });
    }
  };

  return { saveDoc, touchDoc };
}
