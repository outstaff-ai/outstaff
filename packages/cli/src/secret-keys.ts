import type { AdapterRegistry } from "@outstaff/core";

/** Every secret key the installed adapters read, for either scope. A network token may not reuse one. */
export function adapterSecretKeys(registry: AdapterRegistry): Set<string> {
  return new Set(
    registry
      .list()
      .flatMap((d) => [...d.secrets("person"), ...d.secrets("office")])
      .map((s) => s.key),
  );
}
