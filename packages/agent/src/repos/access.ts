import {
  envSecretSource,
  PortError,
  profileAllowsWrite,
  type GitMode,
  type Profile,
  type SecretSource,
} from "@outstaff/core";

/**
 * The most a person's role profile lets them do with a repository. `readonly` gets read tokens even where the grant
 * says write; the other profiles follow the grant (the policy's path rules still limit what a docs role may edit).
 */
export function cappedAccess(grant: GitMode, profile: Profile): GitMode {
  return grant === "write" && profileAllowsWrite(profile) ? "write" : "read";
}

/**
 * Secrets for the git credential helper. git starts it from inside the agent's shell, where credential-looking
 * variables have been scrubbed, so it reads files only and never the environment. The one exception is
 * `OUTSTAFF_PERSON`, who the container acts as: it is not a secret, and the vcs adapter refuses to issue write
 * credentials without it.
 */
export function fileOnlySecrets(env: NodeJS.ProcessEnv): SecretSource {
  const dir = env["OUTSTAFF_SECRETS_DIR"] ?? "/run/secrets/outstaff";
  const files = envSecretSource({}, dir);
  const missing = (key: string) =>
    new PortError(
      "invalid",
      `Missing secret ${key}: secrets must be provided as files under ${dir}; env-only secrets are not visible to git's credential helper.`,
    );

  const get = (key: string) => (key === "OUTSTAFF_PERSON" ? env[key] || undefined : files.get(key));
  return {
    get,
    require(key) {
      const value = get(key);
      if (value === undefined) {
        throw missing(key);
      }

      return value;
    },
  };
}
