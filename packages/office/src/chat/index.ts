export {
  CHAT_MESSAGE_SUBJECT,
  CHAT_ORIGIN_SUBJECT,
  CHAT_THREAD_SUBJECT,
  publicOrigin,
  readOrigin,
  threadKey,
  type ChatOriginRecord,
} from "./origin.js";

export { PM_ROLE, createChatDesk, type ChatDeskOptions, type ChatRequests } from "./desk.js";
export { parsePlacement, placeQueued, type ParsedPlacement } from "./placement.js";
