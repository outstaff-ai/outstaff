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

  /** The condition that makes it needed, when the adapter asks for it only for some people; shown in the contract table. */
  when?: string;
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

const MASK = "***";

/** Shapes of credentials that tools print by accident: token prefixes, bearer headers, private keys, URL passwords. */
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const BEARER = /\b(bearer)(\s+)[A-Za-z0-9._~+/=-]{16,}/gi;
const URL_PASSWORD = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi;
const ASSIGNED =
  /\b([A-Za-z0-9_.-]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(["']?)[^\s"']{8,}\3/gi;

/**
 * `text` with credentials replaced by `***`: every value in `known` (at least 8 characters, so a short word is never
 * blanked) and anything shaped like a token, a bearer header, a private key or an assigned secret. A precaution on
 * top of the host's own masking, for text from outside that an agent is about to read.
 */
export function maskSecrets(text: string, known: Iterable<string> = []): string {
  let out = text;
  for (const value of known) {
    if (value.length >= 8) {
      out = out.split(value).join(MASK);
    }
  }

  for (const shape of SECRET_SHAPES) {
    out = out.replace(shape, MASK);
  }

  return out
    .replace(URL_PASSWORD, `$1${MASK}`)
    .replace(BEARER, `$1$2${MASK}`)
    .replace(ASSIGNED, `$1$2$3${MASK}$3`);
}
