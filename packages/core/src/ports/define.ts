import { registerAdapterOptions } from "../config/adapters.js";
import type { AdapterInfo, IdentityValidator } from "../config/validate.js";
import type { RulePack } from "../permissions/types.js";
import type { TeamConfig } from "../config/schema.js";
import type { AdapterDefinition, PortName } from "./adapter.js";
import { PortError } from "./errors.js";
import type { Avatars } from "./avatars.js";
import type { Chat } from "./chat.js";
import type { Knowledge } from "./knowledge.js";
import type { Runtime } from "./runtime.js";
import type { Tracker } from "./tracker.js";
import type { Vcs } from "./vcs.js";

export interface PortImpls {
  tracker: Tracker;
  knowledge: Knowledge;
  vcs: Vcs;
  chat: Chat;
  runtime: Runtime;
  avatars: Avatars;
}

/** Identity helper that types the definition and registers its option schema for config validation. */
export function defineAdapter<P extends PortName, Options, Impl extends PortImpls[P]>(
  def: AdapterDefinition<P, Options, Impl>,
): AdapterDefinition<P, Options, Impl> {
  registerAdapterOptions(def.port, def.name, def.options);
  return def;
}

// Definitions with different option types live in one registry.
// oxlint-disable-next-line no-explicit-any
type AnyDefinition<P extends PortName> = AdapterDefinition<P, any, PortImpls[P]>;

export class AdapterRegistry {
  private readonly defs = new Map<string, AnyDefinition<PortName>>();

  register<P extends PortName>(def: AnyDefinition<P>): this {
    const key = `${def.port}/${def.name}`;
    if (this.defs.has(key)) {
      throw new PortError("conflict", `Adapter ${key} is already registered.`);
    }

    this.defs.set(key, def as AnyDefinition<PortName>);
    return this;
  }

  get<P extends PortName>(port: P, name: string): AnyDefinition<P> | undefined {
    return this.defs.get(`${port}/${name}`) as AnyDefinition<P> | undefined;
  }

  list(port?: PortName): AnyDefinition<PortName>[] {
    return [...this.defs.values()].filter((d) => !port || d.port === port);
  }

  /**
   * One `adapter` rule pack per adapter that defines `permissions`, for `buildPolicy({ packs })`.
   * Pass the team to keep only the adapters it actually uses.
   */
  rulePacks(
    scope: "person" | "office" = "person",
    team?: Pick<TeamConfig, "integrations">,
  ): RulePack[] {
    const used = (d: AnyDefinition<PortName>) =>
      !team ||
      (team.integrations as Record<string, { adapter: string } | undefined>)[d.port]?.adapter ===
        d.name;

    return this.list()
      .filter((d) => d.permissions && used(d))
      .map((d) => ({
        id: `adapter.${d.port}.${d.name}`,
        source: "adapter" as const,
        rules: d.permissions!(scope),
      }));
  }

  /** The `adapters` map `validateTeam` expects, keyed `<port>/<adapter>`. */
  toValidationAdapters(): Map<string, AdapterInfo> {
    return new Map(
      this.list().map((d) => [
        `${d.port}/${d.name}`,
        { port: d.port, name: d.name, capabilities: [...d.capabilities] },
      ]),
    );
  }

  /** The `identityValidators` map `validateTeam` expects, for adapters that define `validateIdentities`. */
  toIdentityValidators(): Map<string, IdentityValidator> {
    return new Map(
      this.list().flatMap((d) =>
        d.validateIdentities ? [[`${d.port}/${d.name}`, d.validateIdentities] as const] : [],
      ),
    );
  }
}
