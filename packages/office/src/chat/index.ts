export {
  CHAT_MESSAGE_SUBJECT,
  CHAT_ORIGIN_SUBJECT,
  CHAT_THREAD_SUBJECT,
  publicOrigin,
  readOrigin,
  threadKey,
} from "./origin.js";

export { PM_ROLE, createChatDesk, type ChatDeskOptions, type ChatRequests } from "./desk.js";
export { parsePlacement, placeQueued } from "./placement.js";
export type { ChatOriginRecord, ParsedPlacement } from "./types.js";
