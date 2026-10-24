const tokenKey = (handle: string): string =>
  `OUTSTAFF_AGENT_TOKEN_${handle.toUpperCase().replaceAll("-", "_")}`;

/**
 * The compose pieces for one person, in the pattern of examples/compose. `keys` are the person's secret keys as
 * `ost setup` lists them; the office's own App keys (`GH_OFFICE_APP_*`) come from the secrets the office service defines.
 */
export function composeSnippet(handle: string, keys: string[]): string {
  const mine = keys.filter((k) => !k.startsWith("GH_OFFICE_APP_"));
  const office = keys.filter((k) => k.startsWith("GH_OFFICE_APP_"));
  const secretLines = [
    ...mine.map((k) => `      - { source: ${handle}_${k}, target: /run/secrets/outstaff/${k} }`),
    ...office.map((k) => `      - { source: office_${k}, target: /run/secrets/outstaff/${k} }`),
  ];

  return [
    "# services:",
    `  ${handle}:`,
    "    <<: *agent",
    "    environment:",
    "      <<: *agent-env",
    `      OUTSTAFF_PERSON: ${handle}`,
    "    volumes:",
    "      - { <<: *team }",
    `      - ${handle}-home:/home/outstaff`,
    "    networks: [default]",
    "    secrets:",
    ...secretLines,
    "",
    "# services.office.secrets (the office checks the agent's token):",
    `      - { source: ${handle}_OUTSTAFF_AGENT_TOKEN, target: /run/secrets/outstaff/${tokenKey(handle)} }`,
    "",
    "# volumes:",
    `  ${handle}-home:`,
    "",
    "# secrets:",
    ...mine.flatMap((k) => [
      `  ${handle}_${k}:`,
      `    file: \${SECRETS_DIR:-./secrets}/${handle}/${k}`,
    ]),
  ].join("\n");
}

/** `people/<handle>/kustomization.yaml`, in the pattern of examples/k8s. */
export function k8sKustomization(handle: string): string {
  return `apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../../agent
nameSuffix: -${handle}
labels:
  - pairs:
      outstaff.work/person: ${handle}
    includeSelectors: true
    includeTemplates: true
patches:
  - target: { kind: StatefulSet }
    patch: |-
      - { op: replace, path: /spec/template/spec/containers/0/env/0/value, value: ${handle} }
      - { op: replace, path: /spec/template/spec/volumes/0/projected/sources/0/secret/name, value: outstaff-agent-${handle} }
`;
}
