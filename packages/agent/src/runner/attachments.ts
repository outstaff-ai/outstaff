import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { silentLogger, type Logger, type Tracker } from "@outstaff/core";
import type { Attachment, RemoteFile, SaveOptions } from "./types.js";

/** Most bytes of one file the agent downloads. Bigger files are listed by name and type. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const TEXT_TYPES = new Set([
  "application/json",
  "application/x-ndjson",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "application/toml",
  "application/javascript",
  "application/x-sh",
]);

/** Pictures and text the model can read; everything else is only listed. */
export const readable = (mimetype: string) => {
  const type = mimetype.split(";")[0]!.trim().toLowerCase();
  return type.startsWith("image/") || type.startsWith("text/") || TEXT_TYPES.has(type);
};

/** A file name that stays inside a directory: no path parts, no control characters, bounded length. */
export function safeFileName(name: string): string {
  const base = basename(name.replaceAll("\\", "/"))
    // oxlint-disable-next-line no-control-regex
    .replaceAll(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "_")
    .trim();

  return (base || "file").slice(-100);
}

export const humanSize = (bytes: number) =>
  bytes < 1024
    ? `${bytes} bytes`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(0)} KB`
      : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const TOO_LARGE = `larger than ${humanSize(MAX_ATTACHMENT_BYTES)}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Why a file is not worth downloading, judged by what the message says of it. */
function skipReason(file: RemoteFile): string | undefined {
  if (!readable(file.mimetype)) {
    return "not an image or a text file";
  }

  return file.size > MAX_ATTACHMENT_BYTES ? TOO_LARGE : undefined;
}

/** Downloads one file into `dir` as `<n>-<name>`, or says why there is no copy. */
async function downloadFile<F extends RemoteFile>(
  file: F,
  n: number,
  download: (file: F) => Promise<Uint8Array>,
  dir: string,
  log: Logger,
): Promise<Attachment> {
  const base = { name: file.name, mimetype: file.mimetype, size: file.size };
  try {
    const data = await download(file);
    // The size in the message is the sender's platform's word; the bytes decide.
    if (data.byteLength > MAX_ATTACHMENT_BYTES) {
      return { ...base, skipped: TOO_LARGE };
    }

    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${n}-${safeFileName(file.name)}`);
    writeFileSync(path, data);

    return { ...base, size: statSync(path).size, path };
  } catch (e) {
    log.warn("could not download a file", { file: file.name, error: errorText(e) });

    return { ...base, skipped: "the download failed" };
  }
}

async function saveAttachment<F extends RemoteFile>(
  file: F,
  n: number,
  opts: SaveOptions<F>,
  log: Logger,
): Promise<Attachment> {
  const base = { name: file.name, mimetype: file.mimetype, size: file.size };
  const skipped = skipReason(file);
  if (skipped) {
    return { ...base, skipped };
  }

  if (!opts.download) {
    return { ...base, skipped: "files cannot be downloaded from here" };
  }

  return downloadFile(file, n, opts.download, opts.dir, log);
}

/**
 * Downloads the readable files of a message into `dir`, within the size cap, and lists the rest. A download that
 * fails is logged and the file is listed with the reason; it never fails the message.
 */
export async function saveAttachments<F extends RemoteFile>(
  files: readonly F[],
  opts: SaveOptions<F>,
): Promise<Attachment[]> {
  const log = opts.log ?? silentLogger;
  const out: Attachment[] = [];
  for (const [i, file] of files.entries()) {
    out.push(await saveAttachment(file, i + 1, opts, log));
  }

  return out;
}

/** The lines the prompt shows for the files of a message. */
export function attachmentLines(files: readonly Attachment[]): string[] {
  return files.map((f) =>
    f.path
      ? `- ${f.path} (${f.mimetype}, ${humanSize(f.size)}), shared as "${f.name}"`
      : `- "${f.name}" (${f.mimetype}, ${humanSize(f.size)}): not downloaded, ${f.skipped ?? "unavailable"}`,
  );
}

/** Tickets of one item whose files are fetched, and files per ticket. */
const MAX_TICKETS = 3;
const MAX_TICKET_FILES = 10;

type TicketFileSource = Pick<Tracker, "download"> & Required<Pick<Tracker, "attachments">>;

const listsFiles = (
  tracker: Pick<Tracker, "attachments" | "download"> | undefined,
): tracker is TicketFileSource => Boolean(tracker?.attachments);

/** The files of one ticket, saved under `dir/<key>/`; undefined when it has none or they cannot be listed. */
async function saveFilesOfTicket(
  tracker: TicketFileSource,
  key: string,
  dir: string,
  log: Logger,
): Promise<Attachment[] | undefined> {
  try {
    const files = (await tracker.attachments(key)).slice(0, MAX_TICKET_FILES);
    if (!files.length) {
      return undefined;
    }

    return await saveAttachments(files, {
      download: tracker.download ? (f) => tracker.download!(f) : undefined,
      dir: join(dir, safeFileName(key)),
      log,
    });
  } catch (e) {
    log.warn("could not read the files attached to a ticket", { key, error: errorText(e) });

    return undefined;
  }
}

/**
 * The files attached to the tickets an item concerns, downloaded under `dir/<key>/` within the size cap. A ticket
 * whose files cannot be listed is logged and left out; nothing here fails the item.
 */
export async function saveTicketFiles(
  tracker: Pick<Tracker, "attachments" | "download"> | undefined,
  keys: readonly string[],
  dir: string,
  log: Logger = silentLogger,
): Promise<Record<string, Attachment[]>> {
  const out: Record<string, Attachment[]> = {};
  if (!listsFiles(tracker)) {
    return out;
  }

  for (const key of keys.slice(0, MAX_TICKETS)) {
    const files = await saveFilesOfTicket(tracker, key, dir, log);
    if (files) {
      out[key] = files;
    }
  }

  return out;
}
