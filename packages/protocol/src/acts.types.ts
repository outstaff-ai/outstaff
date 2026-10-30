import type { z } from "zod";
import type { actOpSchema, queuedActSchema } from "./acts.js";

export type ActOpPayload = z.infer<typeof actOpSchema>;
export type QueuedAct = z.infer<typeof queuedActSchema>;
