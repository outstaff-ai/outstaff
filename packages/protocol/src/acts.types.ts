import type { z } from "zod";
import type { actOpSchema } from "./acts.js";

export type ActOpPayload = z.infer<typeof actOpSchema>;
