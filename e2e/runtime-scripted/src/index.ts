import { defineAdapter } from "@outstaff/core";
import { z } from "zod";
import { createScriptedRuntime } from "./runtime.js";

export { createScriptedRuntime } from "./runtime.js";
export { createStubChat, stubChat } from "./chat.js";
export { parsePrompt, type ItemContext } from "./prompt.js";
export { SCRIPTS, type Action, type Script } from "./scripts.js";

export const scriptedRuntime = defineAdapter({
  port: "runtime",
  name: "scripted",
  capabilities: ["runtime.usage"],
  options: z.strictObject({}),
  secrets: () => [],
  create: (ctx) => createScriptedRuntime({ log: ctx.log }),
});
