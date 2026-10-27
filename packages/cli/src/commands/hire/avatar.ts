import {
  AdapterRegistry,
  envSecretSource,
  silentLogger,
  type Avatars,
  type TeamConfig,
} from "@outstaff/core";
import type { Context } from "#/types.js";

/** A fixed set of adapters that render avatars, for teams whose `integrations.avatars` names one. */
async function avatarRegistry(ctx: Context): Promise<AdapterRegistry> {
  if (ctx.registry?.list("avatars").length) {
    return ctx.registry;
  }

  const { dicebearAvatars, directoryAvatars, urlAvatars } =
    await import("@outstaff/integration.avatars.dicebear");

  return new AdapterRegistry()
    .register(dicebearAvatars)
    .register(directoryAvatars)
    .register(urlAvatars);
}

export async function renderAvatar(
  ctx: Context,
  config: TeamConfig,
  seed: string,
  secretsDir: string,
): Promise<{ data: Uint8Array; ext: "png" | "svg" } | { skipped: string }> {
  const ref = config.integrations.avatars;
  if (!ref) {
    return { skipped: "No integrations.avatars in the team file, so no avatar was rendered." };
  }

  const def = (await avatarRegistry(ctx)).get("avatars", ref.adapter);
  if (!def) {
    return { skipped: `Avatar adapter "${ref.adapter}" is not shipped in this build.` };
  }

  const { adapter: _adapter, ...raw } = ref;
  const options = def.options.parse(raw);
  const avatars: Avatars = await def.create({
    options,
    secrets: envSecretSource(ctx.env, secretsDir),
    team: config,
    log: silentLogger,
    fetch: ctx.fetch ?? fetch,
    now: ctx.now ?? (() => new Date()),
  });

  const image = await avatars.render(seed);
  return { data: image.data, ext: image.mime === "image/png" ? "png" : "svg" };
}
