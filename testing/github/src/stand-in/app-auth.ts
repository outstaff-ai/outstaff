import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { StandInRequest } from "@outstaff/testing.http";
import type { AppAuth, AppAuthOptions, TokenHolder } from "./e2e.types.js";

const bearerOf = (req: StandInRequest) =>
  (req.headers.get("authorization") ?? "").replace(/^[Bb]earer /, "");

/** The claims of a JWT signed with the key; undefined when it is not one. */
function claimsOf(token: string, key: KeyObject): { iss?: unknown } | undefined {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) {
    return undefined;
  }

  try {
    return verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(sig, "base64url"))
      ? JSON.parse(Buffer.from(p, "base64url").toString("utf8"))
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * GitHub's App scheme: JWTs signed with the Apps' key and checked against its public half, and installation tokens
 * `ghs_<slug>_<n>` that may write when they were asked for `contents: write`.
 */
export function appAuth(opts: AppAuthOptions): AppAuth {
  const key = createPublicKey(opts.publicKey);
  const tokens = new Map<string, TokenHolder>();
  let issued = 0;
  const appOf = (req: StandInRequest) => {
    const iss = String(claimsOf(bearerOf(req), key)?.iss);
    return opts.apps[iss] === undefined ? undefined : Number(iss);
  };

  return {
    appOf,
    slugOf: (app) => opts.apps[String(app)],
    issue(app, req) {
      const slug = opts.apps[String(app)]!;
      const token = `ghs_${slug}_${++issued}`;
      tokens.set(token, { slug, write: req.json?.permissions?.contents === "write" });
      return {
        status: 201,
        body: { token, expires_at: new Date(Date.now() + 3_600_000).toISOString() },
      };
    },
    actorOf: (req) => {
      const holder = tokens.get(bearerOf(req));
      return holder ? `${holder.slug}[bot]` : undefined;
    },
    holderOf: (token) => tokens.get(token),
  };
}
