import type { SecretSpec } from "@outstaff/core";

/** The secrets of both Its a Plan adapters: one member API key per container. */
export const itsaplanSecrets = (scope: "person" | "office"): SecretSpec[] => [
  {
    key: "ITSAPLAN_API_KEY",
    description:
      scope === "person"
        ? "API key of this agent's own member account in Its a Plan"
        : "API key of the member account the office acts as",
    where:
      "Its a Plan > Account settings > API keys, signed in as that member (the key is shown once)",
  },
  {
    key: "ITSAPLAN_MEMBER_ID",
    description: "Member id of the account the API key belongs to",
    where: "Let ost setup --derive look it up (/me)",
    derivable: true,
    optional: true,
  },
];
