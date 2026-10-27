import { PortError, type ChatFile } from "@outstaff/core";
import type { SlackFile } from "./api.js";

/** Files are served from slack.com hosts only; the bot token is never sent anywhere else. */
const isSlackHost = (host: string) => host === "slack.com" || host.endsWith(".slack.com");

export const filesOf = (files: SlackFile[] | undefined): ChatFile[] =>
  (files ?? []).flatMap((f) => {
    const url = f.url_private_download ?? f.url_private;
    // A file Slack no longer serves (deleted, over the workspace's limit) has no URL.
    return f.id && url
      ? [
          {
            id: f.id,
            name: f.name ?? f.title ?? f.id,
            mimetype: f.mimetype ?? "application/octet-stream",
            size: f.size ?? 0,
            url,
          },
        ]
      : [];
  });

/** The file's download address, which must be an https URL on a Slack host. */
function slackUrlOf(file: ChatFile): URL {
  let url: URL;
  try {
    url = new URL(file.url);
  } catch {
    throw new PortError("invalid", `File ${file.id} has no valid download address.`);
  }

  if (url.protocol !== "https:" || !isSlackHost(url.hostname)) {
    throw new PortError("invalid", `File ${file.id} is not hosted by Slack.`);
  }

  return url;
}

/** Throws when Slack refused the file or answered with something other than the file. */
function assertFileResponse(res: Response, file: ChatFile): void {
  if (!res.ok) {
    throw new PortError(
      res.status === 401 || res.status === 403 ? "forbidden" : "unavailable",
      `Slack refused file ${file.id}: ${res.status}.`,
    );
  }

  // Without the files:read scope Slack answers 200 with a sign-in page instead of the file.
  if (
    res.headers.get("content-type")?.startsWith("text/html") &&
    !file.mimetype.startsWith("text/html")
  ) {
    throw new PortError(
      "forbidden",
      "Slack sent a web page instead of the file: the app needs the files:read scope.",
    );
  }
}

/** Download a shared file from Slack's file host with the bot token. */
export async function downloadSlackFile(
  fetchFn: typeof fetch,
  token: string,
  file: ChatFile,
): Promise<Uint8Array> {
  const url = slackUrlOf(file);
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { authorization: `Bearer ${token}` } });
  } catch (error) {
    throw new PortError("unavailable", `Slack could not be reached for file ${file.id}.`, {
      cause: error,
    });
  }

  assertFileResponse(res, file);
  return new Uint8Array(await res.arrayBuffer());
}
