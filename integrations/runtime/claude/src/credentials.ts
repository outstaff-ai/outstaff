// What Claude Code needs to sign in. The operator supplies one way; it is read through the SecretSource (a file or the
// environment) and handed to the Claude Code process only. Provider flags, regions, base URLs and
// GOOGLE_APPLICATION_CREDENTIALS (a path to a file, which belongs in the secrets dir) are not secrets and pass through.
export const CREDENTIAL_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
] as const;

// Claude Code's own scrub keeps these on purpose; git gets credentials from the `ost git-credential` helper, never the environment.
export const ALWAYS_DROPPED = ["GH_TOKEN", "GITHUB_TOKEN"] as const;
