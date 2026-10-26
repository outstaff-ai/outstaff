import type { ConfigCode, WarningCode } from "./types.js";

export const documentedCodes: Record<ConfigCode | WarningCode, string> = {
  "schema.invalid_type": "A value has the wrong type.",
  "schema.invalid_value": "A value is not one of the allowed values.",
  "schema.invalid_format": "A value does not match the required format.",
  "schema.too_small": "A value, list or string is below its minimum.",
  "schema.too_big": "A value, list or string is above its maximum.",
  "schema.unknown_key": "A key is not part of the schema.",
  "config.not_found": "No team file was found in any of the places searched.",
  "config.yaml_syntax": "The team file is not valid YAML.",
  "config.read_failed": "The team file could not be read.",
  "config.git_failed": "The team repository could not be fetched or checked out.",
  "schema.invalid": "A value fails a schema rule not covered by a more specific code.",
  "catalog.invalid_version": "catalog.version is not an exact version (for example 1.0.0).",
  "repos.duplicate_name": "Two repos share the same name.",
  "repos.multiple_primary": "More than one repo has kind primary.",
  "people.duplicate_handle": "Two people share the same handle.",
  "people.invalid_grant_key": "A repo grant key is not a repo name, kind:<kind> or *.",
  "people.unknown_repo": "A repo grant names a repo that is not listed in repos.",
  "email.missing_placeholder": "email.pattern does not contain {handle}.",
  "policies.usage_threshold_order": "defer_scheduled_at is higher than pause_automatic_at.",
  "policies.retry_backoff_order": "base_minutes is higher than cap_minutes.",
  "policies.usage_shared_unknown_person":
    "A policies.usage.shared group names someone who is not in people.",
  "policies.usage_shared_overlap": "A person appears in more than one policies.usage.shared group.",
  "policies.command_program":
    "A policies.commands entry names git, which repository grants govern.",
  "tools.invalid_version":
    "A tool version is a range, prefix or alias instead of an exact version.",
  "tools.duplicate": "A tool lists a verb twice, or two tools share a source.",
  "tools.rule_program": "A structured rule of a tool names a different program than the tool.",
  "tools.options_without_source": "A tool sets options but no source to pass them to.",
  "tools.reserved_option": "A tool option is version, which the tool's version field sets.",
  "tools.http_checksum":
    "A tool with an http: source has no checksum, or a platform without one, so the download is not pinned.",
  "integrations.invalid_options": "An integration's options are rejected by its adapter.",
  "people.unknown_role": "A person's role is not in the catalog.",
  "people.unknown_extends": "An extends entry names a role that is not in the catalog.",
  "people.write_without_vcs":
    "A person has a write grant but no vcs integration supports pull requests.",
  "integrations.unknown_adapter":
    "An integration names an adapter that is not installed for that port.",
  "network.invalid_url":
    "A network http grant url is not an origin (scheme, host and optional port only).",
  "network.duplicate_name": "Two network grants of the same kind share a name.",
  "network.adb_mode": "An adb grant gives both port and pairing, or neither.",
  "network.reserved_token":
    "A network token names a secret the framework or an adapter reads, so it cannot be a service token.",
  "roles.unknown_role": "A roles entry names a role that is not in the catalog.",
  "workflow.duplicate_rule_id": "Two workflow rules share the same id.",
  "workflow.unknown_rule": "A rule is disabled by id but the preset has no rule with that id.",
  "workflow.unknown_template":
    "A rule refers to a template that is neither built in nor defined in workflow.templates.",
  "workflow.unknown_placeholder":
    "A workflow template is malformed or uses a variable that does not exist.",
  "workflow.duplicate_status_name": "Two canonical statuses map to the same tracker status name.",
  "capability.missing": "A role needs a capability that no configured integration provides.",
  "capability.optional_missing":
    "A role can use a capability that no configured integration provides.",
  "trust.default": "humans is omitted, so the default trust rule applies.",
  "people.missing_vcs_identity":
    "A person has a write grant but no identities.vcs, while a vcs integration is configured.",
  "people.missing_chat_identity":
    "A person has no identities.chat while a chat integration is configured.",
  "people.missing_tracker_identity":
    "A person has no identities.tracker while a tracker integration is configured.",
  "people.reviewer_without_github":
    "A person in the reviewer role has no repo grant, or no identities.vcs, so cannot review pull requests as themselves.",
  "identities.chat_not_member_id":
    "A chat identity is not a Slack member id (for example U0123ABCD); names never match.",
  "identities.vcs_not_login":
    "A human's vcs identity is not a GitHub login (letters, digits, hyphens or underscores, up to 39 characters).",
  "identities.vcs_not_bot_login":
    "A person's vcs identity is not a GitHub App bot login (<slug>[bot]), so the agent's own activity is not recognized.",
  "identities.tracker_empty": "A tracker identity is blank.",
  "policies.merge_unknown_repo": "policies.merge.repos names a repo that is not listed in repos.",
  "policies.merge_without_checks":
    "policies.merge.on_approval is on for a repo with no checks configured, so an approval merges untested code.",
  "policies.capability_missing":
    "A policies switch is on, but the configured adapter lacks the capability it needs.",
};
