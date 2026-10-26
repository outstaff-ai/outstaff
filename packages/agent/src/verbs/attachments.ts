import { readFileSync } from "node:fs";
import { silentLogger, type Tracker } from "@outstaff/core";
import { humanSize } from "../runner/attachments.js";
import type { Attachment } from "../runner/types.js";
import type { AgentEnv, Uploaded } from "./types.js";

/** The tracker, when it can take attachments. */
export const canAttach = (tracker: Tracker | undefined): tracker is Tracker =>
  typeof tracker?.attach === "function";

/** What the ticket body says about the files of the chat message the ticket is filed from. */
export function attachmentsSection(files: readonly Attachment[], attaching: boolean): string {
  const attached = attaching ? files.filter((f) => f.path) : [];
  const stayed = files.filter((f) => !attached.includes(f));
  const line = (f: Attachment) => `- ${f.name} (${f.mimetype}, ${humanSize(f.size)})`;
  return [
    ...(attached.length
      ? ["Attached to this ticket, from the chat message:", ...attached.map(line)]
      : []),
    ...(stayed.length
      ? [
          `${attached.length ? "Also shared" : "Shared"} in the chat message and not attached here; ${stayed.length === 1 ? "it stays" : "they stay"} in chat:`,
          ...stayed.map(line),
        ]
      : []),
  ].join("\n");
}

/**
 * Attaches the downloaded files to a ticket. A failed upload is logged and reported, never thrown: the ticket
 * exists either way.
 */
export async function uploadAttachments(
  env: AgentEnv,
  key: string,
  files: readonly Attachment[],
): Promise<Uploaded> {
  const log = env.log ?? silentLogger;
  const out: Uploaded = { attached: [], failed: [] };
  const tracker = env.tracker;
  if (!canAttach(tracker)) {
    return out;
  }

  for (const f of files) {
    if (!f.path) {
      continue;
    }

    try {
      await tracker.attach!(key, {
        name: f.name,
        mimetype: f.mimetype,
        data: new Uint8Array(readFileSync(f.path)),
      });

      out.attached.push(f.name);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log.warn("could not attach a file to a ticket", { key, file: f.name, error: reason });
      out.failed.push({ name: f.name, reason });
    }
  }

  return out;
}

export const uploadedLines = (u: Uploaded) => [
  ...(u.attached.length ? [`Attached ${u.attached.join(", ")}.`] : []),
  ...(u.failed.length ? [`Could not attach ${u.failed.map((f) => f.name).join(", ")}.`] : []),
];

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
};

/** The media type of a file from its extension. */
export const mimetypeOf = (name: string) =>
  TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
