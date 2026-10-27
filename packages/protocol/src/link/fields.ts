import { z } from "zod";

export const time = z.string().min(1).describe("ISO-8601 time, UTC.");
