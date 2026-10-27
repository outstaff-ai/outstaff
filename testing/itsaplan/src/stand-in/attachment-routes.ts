import type { ApiAttachment } from "@outstaff/integration.tracker.itsaplan";
import type { StandInRequest } from "@outstaff/testing.http";
import { issueById, touch } from "./model.js";
import { err } from "./store.js";
import type { ActorRoute, ItsaplanStore } from "./types.js";

const publicId = (position: number) => `pub-${position + 1}`;

/** Stores the multipart `file` of an upload on the issue. */
async function upload(s: ItsaplanStore, r: StandInRequest) {
  const issue = issueById(s, r.params["id"]!);
  if (!issue) {
    return err(404, "issue not found");
  }

  const file = r.form?.get("file");
  if (!(file instanceof File)) {
    return err(400, "file is required");
  }

  s.attachments.push({
    issueId: issue.id,
    name: file.name,
    mimetype: file.type,
    data: new Uint8Array(await file.arrayBuffer()),
  });

  touch(s, issue);
  return {
    status: 201,
    body: {
      publicId: publicId(s.attachments.length - 1),
      filename: file.name,
    } satisfies ApiAttachment,
  };
}

/** Files on issues: upload, list, and the raw download (recorded in `served`). */
export function attachmentRoutes(s: ItsaplanStore): ActorRoute[] {
  return [
    { method: "POST", path: "/issues/:id/attachments", handler: (r) => upload(s, r) },
    {
      method: "GET",
      path: "/issues/:id/attachments",
      handler: (r) => {
        const issue = issueById(s, r.params["id"]!);
        if (!issue) {
          return err(404, "issue not found");
        }

        return s.attachments
          .map((a, i) => ({ a, id: publicId(i) }))
          .filter(({ a }) => a.issueId === issue.id)
          .map(({ a, id }): ApiAttachment => ({
            publicId: id,
            filename: a.name,
            mimeType: a.mimetype,
            size: a.data.byteLength,
          }));
      },
    },
    {
      method: "GET",
      path: "/attachments/:publicId/raw",
      handler: (r) => {
        const id = r.params["publicId"]!;
        const a = s.attachments[Number(id.replace("pub-", "")) - 1];
        if (!a) {
          return err(404, "attachment not found");
        }

        s.served.push(id);
        return { buffer: a.data, headers: { "content-type": a.mimetype } };
      },
    },
  ];
}
