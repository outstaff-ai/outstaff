import { z } from "zod";
import { d } from "./schema-meta.js";

export const MEMORY_STORES = ["volume", "knowledge"] as const;

export const memorySchema = z
  .strictObject({
    store: z
      .enum(MEMORY_STORES)
      .default("volume")
      .meta(
        d(
          "Where agents keep their notes (`ost note`): `volume`, files in `memory/` on each agent's home volume, which must then be backed up; or `knowledge`, a page per agent in the knowledge integration, which must provide knowledge.notes.",
        ),
      ),
  })
  .meta(d("Where agents keep their memory: the lasting lessons and preferences they note."));
