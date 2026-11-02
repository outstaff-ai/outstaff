import type { WorkflowEvent } from "@outstaff/core";
import type { DocOps, RefreshCtx, WorkstateCore } from "./core.types.js";
import { docNode, personNode, ROOT } from "./links.js";
import { recordSynthetic } from "./synthetic.js";
import type { DocLink, DocRecord } from "./types.js";

/** The record of a document an agent recorded: the first author and the latest ticket stay. */
function recordOf(doc: DocLink, known: DocRecord | undefined, at: string): DocRecord {
  const ticket = doc.ticket ?? known?.ticket;
  return {
    id: doc.id,
    title: doc.title,
    url: doc.url,
    author: known?.author ?? doc.author,
    ...(ticket ? { ticket } : {}),
    touchedAt: at,
  };
}

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

  /** Raises `doc.linked` once per document and ticket, as the agent who recorded the document. */
  const raiseLinked = async (ctx: RefreshCtx, doc: DocLink, ticket: string, at: string) => {
    const event: WorkflowEvent = {
      type: "doc.linked",
      subject: { doc: doc.id, ticket },
      actor: { kind: "agent", id: doc.author },
      data: { ticket, title: doc.title, url: doc.url, at },
    };

    await recordSynthetic(store, ctx, event, `doc.linked:${doc.id}:${ticket}`);
  };

  /**
   * The agent who recorded the document keeps it unless another wrote it first. A ticket it is for now, and was not
   * before, raises `doc.linked`, so the document is linked on the ticket in the tracker.
   */
  const linkDoc: DocOps["linkDoc"] = async (ctx, doc) => {
    const known = docs.get(doc.id);
    const rec = recordOf(doc, known, clock.now().toISOString());
    await saveDoc(rec);
    if (rec.ticket && rec.ticket !== known?.ticket) {
      await raiseLinked(ctx, doc, rec.ticket, rec.touchedAt);
    }
  };

  return { saveDoc, touchDoc, linkDoc };
}
