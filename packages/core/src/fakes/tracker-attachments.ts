import { PortError, type NewAttachment, type TicketAttachment } from "#/ports/index.js";
import type { FakeTracker } from "./types.js";

/** The fake's attachments: every file attached, by ticket key (`attached`), listed and downloaded by a made-up id. */
export function fakeAttachments(need: (key: string) => unknown) {
  const attached: FakeTracker["attached"] = new Map();

  return {
    attached,

    async attach(key: string, file: NewAttachment) {
      need(key);
      const list = attached.get(key) ?? [];
      list.push({ name: file.name, mimetype: file.mimetype, data: file.data.slice() });
      attached.set(key, list);
    },

    async attachments(key: string): Promise<TicketAttachment[]> {
      need(key);
      return (attached.get(key) ?? []).map((a, i) => ({
        id: `${key}-a${i + 1}`,
        name: a.name,
        mimetype: a.mimetype,
        size: a.data.byteLength,
      }));
    },

    async download(attachment: TicketAttachment) {
      for (const [key, list] of attached) {
        const hit = list.find((_, i) => `${key}-a${i + 1}` === attachment.id);
        if (hit) {
          return hit.data.slice();
        }
      }

      throw new PortError("not_found", `Attachment ${attachment.id} not found.`);
    },
  };
}
