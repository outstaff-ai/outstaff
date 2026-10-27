import { z } from "zod";
import { AdapterRegistry, defineAdapter } from "#/ports/index.js";
import { createFakeAvatars } from "./avatars.js";
import { createFakeChat } from "./chat.js";
import { createFakeKnowledge } from "./knowledge.js";
import { createFakeRuntime } from "./runtime.js";
import { createFakeTracker } from "./tracker.js";
import { createFakeVcs } from "./vcs.js";

const options = z.looseObject({});
const none = () => [];

/** A registry with a fake for every port, all under the adapter name "fake". */
export function createFakeAdapterRegistry(): AdapterRegistry {
  return new AdapterRegistry()
    .register(
      defineAdapter({
        port: "tracker",
        name: "fake",
        capabilities: ["tracker.issues", "tracker.assign", "tracker.attachments"],
        options,
        secrets: none,
        create: (ctx) =>
          createFakeTracker({ statusMap: ctx.team.workflow?.statuses ?? {}, now: ctx.now }),
      }),
    )
    .register(
      defineAdapter({
        port: "knowledge",
        name: "fake",
        capabilities: ["knowledge.docs"],
        options,
        secrets: none,
        create: (ctx) => createFakeKnowledge({ now: ctx.now }),
      }),
    )
    .register(
      defineAdapter({
        port: "vcs",
        name: "fake",
        capabilities: [
          "vcs.pullRequests",
          "vcs.reviewThreads",
          "vcs.workflows",
          "vcs.reactions",
          "vcs.merge",
        ],
        options,
        secrets: none,
        create: (ctx) => createFakeVcs({ now: ctx.now }),
      }),
    )
    .register(
      defineAdapter({
        port: "chat",
        name: "fake",
        capabilities: ["chat.messages", "chat.history", "chat.agentProfile", "chat.files"],
        options,
        secrets: none,
        create: (ctx) => createFakeChat({ now: ctx.now }),
      }),
    )
    .register(
      defineAdapter({
        port: "runtime",
        name: "fake",
        capabilities: ["runtime.sessions", "runtime.usage", "runtime.permissions"],
        options,
        secrets: none,
        create: () => createFakeRuntime(),
      }),
    )
    .register(
      defineAdapter({
        port: "avatars",
        name: "fake",
        capabilities: ["avatars.generate"],
        options,
        secrets: none,
        create: () => createFakeAvatars(),
      }),
    );
}
