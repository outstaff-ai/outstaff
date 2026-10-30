export {
  CHAT_MESSAGE_SUBJECT,
  CHAT_ORIGIN_SUBJECT,
  CHAT_THREAD_SUBJECT,
  publicOrigin,
  readOrigin,
  threadKey,
} from "./origin.js";

export { createChatDesk } from "./desk.js";
export { PM_ROLE } from "./desk-reports.js";
export type { ChatDeskOptions, ChatRequests } from "./desk.types.js";
export { placeQueued } from "./placement.js";
export type { ChatOriginRecord } from "./types.js";
