export { buildIdentityPrompt, type IdentityInput, type IdentityRole } from "./identity.js";
export { agentLayout } from "./layout.js";
export {
  createWorkLoop,
  linksIn,
  type WorkConnection,
  type WorkLoop,
  type WorkLoopOptions,
} from "./loop.js";

export { buildWorkPrompt } from "./prompt.js";
export { createSessionManager, type SessionManager, type SessionStore } from "./sessions.js";
export { StartupError, prepareAgent, type PreparedAgent, type StartupOptions } from "./startup.js";
export { agentRegistry } from "./registry.js";
