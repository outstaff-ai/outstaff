export interface ReviewThread {
  id: string;
  resolved: boolean;
  path?: string;
  line?: number;
  comments: ReviewThreadComment[];
}

/** One comment of a review thread; a thread's comments are oldest first. */
export interface ReviewThreadComment {
  id: string;
  author: string;

  /** A person of the team (`agent`), another automation (`bot`), or anyone else (`human`). */
  kind: "human" | "agent" | "bot";
  body: string;

  /** When the host recorded it (ISO-8601). */
  at: string;
  url?: string;
}
