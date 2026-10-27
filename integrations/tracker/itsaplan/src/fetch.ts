import { readFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { PortError } from "@outstaff/core";
import type { ClientDeps, Connection } from "./types.js";

async function undiciFetch(ca: string): Promise<typeof fetch> {
  const { Agent, fetch: f } = await import("undici");
  const agent = new Agent({ connect: { ca: [...rootCertificates, ca] } });
  return ((input: string | URL, init?: RequestInit) =>
    f(input, { ...init, dispatcher: agent } as never)) as unknown as typeof fetch;
}

export async function buildFetch(
  base: typeof fetch,
  conn: Connection,
  deps: ClientDeps = {},
): Promise<typeof fetch> {
  if (!conn.ca_file) {
    return base;
  }

  let pem: string;
  try {
    pem = (deps.readFile ?? ((p) => readFileSync(p, "utf8")))(conn.ca_file);
  } catch (cause) {
    throw new PortError("invalid", `Cannot read ca_file ${conn.ca_file}.`, { cause });
  }

  return (deps.tlsFetch ?? undiciFetch)(pem);
}
