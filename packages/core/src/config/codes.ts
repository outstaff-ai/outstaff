/** Stable machine-readable codes for team.yaml problems. Never rename; add new ones. */
export const CONFIG_CODES = {
  invalidType: "schema.invalid_type",
  invalidValue: "schema.invalid_value",
  invalidFormat: "schema.invalid_format",
  tooSmall: "schema.too_small",
  tooBig: "schema.too_big",
  unknownKey: "schema.unknown_key",
  invalid: "schema.invalid",
  catalogInvalidVersion: "catalog.invalid_version",
  reposDuplicateName: "repos.duplicate_name",
  reposMultiplePrimary: "repos.multiple_primary",
  peopleDuplicateHandle: "people.duplicate_handle",
  peopleInvalidGrantKey: "people.invalid_grant_key",
  peopleUnknownRepo: "people.unknown_repo",
  emailMissingPlaceholder: "email.missing_placeholder",
  usageThresholdOrder: "policies.usage_threshold_order",
  adapterInvalidOptions: "integrations.invalid_options",
  notFound: "config.not_found",
  yamlSyntax: "config.yaml_syntax",
  readFailed: "config.read_failed",
  gitFailed: "config.git_failed",
} as const;

export type ConfigCode = (typeof CONFIG_CODES)[keyof typeof CONFIG_CODES];
