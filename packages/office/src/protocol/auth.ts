import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import type { SecretSource } from "@outstaff/core";

const KEY_LENGTH = 32;

export interface AgentAuth {
  /** True only when the person has a token and `token` matches it. Takes the same time either way. */
  verify(person: string, token: string): Promise<boolean>;
  has(person: string): boolean;
}

export const agentTokenKey = (handle: string) =>
  `OUTSTAFF_AGENT_TOKEN_${handle.toUpperCase().replaceAll("-", "_")}`;

const derive = (secret: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(secret, salt, KEY_LENGTH, (err, key) => (err ? reject(err) : resolve(key))),
  );

/**
 * Hashes every token once, at startup, so the plain tokens are not kept. Handles without a token cannot connect.
 */
export function createAgentAuth(tokens: Record<string, string>): AgentAuth {
  const hashes = new Map<string, { salt: Buffer; hash: Buffer }>();
  for (const [person, token] of Object.entries(tokens)) {
    const salt = randomBytes(16);
    hashes.set(person, { salt, hash: scryptSync(token, salt, KEY_LENGTH) });
  }

  const decoy = { salt: randomBytes(16), hash: randomBytes(KEY_LENGTH) };
  return {
    has: (person) => hashes.has(person),
    async verify(person, token) {
      const known = hashes.get(person);
      const entry = known ?? decoy;
      const candidate = await derive(token, entry.salt);
      return timingSafeEqual(candidate, entry.hash) && known !== undefined;
    },
  };
}

/** Reads `OUTSTAFF_AGENT_TOKEN_<HANDLE>` for each handle from the office's secrets. */
export function agentAuthFromSecrets(secrets: SecretSource, handles: readonly string[]): AgentAuth {
  const tokens: Record<string, string> = {};
  for (const handle of handles) {
    const token = secrets.get(agentTokenKey(handle));
    if (token) {
      tokens[handle] = token;
    }
  }

  return createAgentAuth(tokens);
}
