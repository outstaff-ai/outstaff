import { spawn } from "node:child_process";
import { AUTHOR } from "./git-run.js";
import type { GitHttpRequest, GitHttpResponse } from "./e2e.types.js";

/** The status and headers of a CGI answer's header block. */
function parseHead(head: string): Omit<GitHttpResponse, "body"> {
  const headers: Record<string, string> = {};
  let status = 200;
  for (const line of head.split("\r\n")) {
    const colon = line.indexOf(":");
    const key = line.slice(0, colon).toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "status") {
      status = Number.parseInt(value, 10);
    } else {
      headers[key] = value;
    }
  }

  return { status, headers };
}

const cgiEnv = (root: string, req: GitHttpRequest) => ({
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  GIT_PROJECT_ROOT: root,
  GIT_HTTP_EXPORT_ALL: "1",
  REQUEST_METHOD: req.method,
  PATH_INFO: req.path,
  QUERY_STRING: req.query,
  CONTENT_TYPE: req.contentType ?? "",
  CONTENT_LENGTH: String(req.body.length),
  ...(req.encoding ? { HTTP_CONTENT_ENCODING: req.encoding } : {}),
  REMOTE_USER: req.user,
  REMOTE_ADDR: "127.0.0.1",
  GIT_COMMITTER_NAME: AUTHOR.GIT_COMMITTER_NAME,
  GIT_COMMITTER_EMAIL: AUTHOR.GIT_COMMITTER_EMAIL,
});

/**
 * One request of git's smart HTTP protocol through `git http-backend`, for the repositories under `root`. The CGI
 * answer is a header block, a blank line and the body.
 */
export function httpBackend(root: string, req: GitHttpRequest): Promise<GitHttpResponse> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["http-backend"], { env: cgiEnv(root, req) });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => (err += String(c)));
    child.on("error", reject);
    child.on("close", () => {
      const all = Buffer.concat(out);
      const split = all.indexOf("\r\n\r\n");
      if (split < 0) {
        reject(new Error(`git http-backend gave no headers: ${err.trim()}`));
        return;
      }

      resolve({
        ...parseHead(all.subarray(0, split).toString("utf8")),
        body: all.subarray(split + 4),
      });
    });

    // git can answer and exit before it reads the body; its answer is whole, so a broken pipe here is not an error.
    child.stdin.on("error", () => undefined);
    child.stdin.end(req.body);
  });
}
