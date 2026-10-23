import { readFileSync } from "node:fs";
import { PortError } from "./errors.js";

export interface SecretSpec {
  key: string;
  description: string;

  /** Where to get it; shown by `ost setup`. */
  where: string;

  /** `ost setup --derive` can compute it. */
  derivable?: boolean;

  /** The adapter works without it (for example when another credential is supplied instead). */
  optional?: boolean;
}

export interface SecretSource {
  get(key: string): string | undefined;
  require(key: string): string;
}

const SECRET_KEY = /^[A-Za-z0-9_]+$/;

/**
 * Secrets come from files first (`<dir>/<KEY>`, the Docker and Kubernetes secrets convention), then from the
 * environment as a fallback for platforms that can only inject env vars. Files are preferred because anything in
 * the environment is inherited by an agent's shell; see `scrubEnv`.
 */
export function envSecretSource(
  env: Record<string, string | undefined> = process.env,
  dir = env["OUTSTAFF_SECRETS_DIR"] ?? "/run/secrets/outstaff",
  readFile: (path: string) => string = (p) => readFileSync(p, "utf8"),
): SecretSource {
  const get = (key: string): string | undefined => {
    if (!SECRET_KEY.test(key)) {
      throw new PortError("invalid", `Invalid secret key "${key}".`);
    }

    try {
      const fromFile = readFile(`${dir}/${key}`).trim();
      if (fromFile) {
        return fromFile;
      }
    } catch {
      // not provided as a file
    }

    return env[key] || undefined;
  };

  return {
    get,
    require(key) {
      const value = get(key);
      if (value === undefined) {
        throw new PortError("invalid", `Missing secret ${key}.`);
      }

      return value;
    },
  };
}

/** A copy of `env` without the given secret keys, for the environment of child processes an agent can reach. */
export function scrubEnv(
  env: Record<string, string | undefined>,
  keys: Iterable<string>,
): Record<string, string> {
  const drop = new Set(keys);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && !drop.has(k)) {
      out[k] = v;
    }
  }

  return out;
}
