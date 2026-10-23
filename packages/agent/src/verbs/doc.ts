import { PortError, type DocComment } from "@outstaff/core";
import { z } from "zod";
import { requireKnowledge } from "./support.js";
import { defineVerb, result } from "./types.js";

const id = z.string().min(1).max(500).describe("Document id or path.");
const commentId = z.string().min(1).max(200).describe("Comment id.");
const docPath = z
  .string()
  .min(1)
  .max(300)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), {
    message: "Use a relative path without '..'.",
  })
  .describe("Path of the document in the knowledge base, for example specs/checkout.md.");

const commentLine = (c: DocComment) =>
  `- ${c.id} ${c.resolved ? "[resolved] " : ""}${c.parentId ? "(reply) " : ""}${c.author}: ${c.body.trim()}`;

export const docSearch = defineVerb({
  name: "doc.search",
  summary: "Search the knowledge base.",
  description: "Searches documents by text and lists the matches with their URLs.",
  input: z.strictObject({
    query: z.string().min(1).max(500).describe("Words to search for."),
    limit: z.number().int().min(1).max(50).default(10).describe("Maximum number of results."),
  }),
  args: ["query"],
  examples: ['ost doc search "checkout flow"'],
  async run(env, input) {
    const kb = requireKnowledge(env);
    const docs = await kb.search(input.query, input.limit);
    const urls = docs.map((d) => kb.links.doc(d.id));
    return result(
      docs.length
        ? docs.map((d, i) => `${d.title} (${d.path})\n${urls[i]}`)
        : [`No documents match "${input.query}".`],
      { docs: docs.map(({ body: _body, ...d }) => d) },
      urls,
    );
  },
});

export const docShow = defineVerb({
  name: "doc.show",
  summary: "Show a document and its comments.",
  description:
    "Shows a document's text and its comment threads, with ids you can reply to or resolve.",
  input: z.strictObject({ id }),
  args: ["id"],
  examples: ["ost doc show specs/checkout.md"],
  async run(env, input) {
    const kb = requireKnowledge(env);
    const doc = await kb.get(input.id);
    const comments = await kb.comments(doc.id);
    const url = kb.links.doc(doc.id);
    return result(
      [
        `${doc.title} (${doc.path})`,
        url,
        "",
        doc.body,
        ...(comments.length
          ? ["", `Comments (${comments.length}):`, ...comments.map(commentLine)]
          : []),
      ],
      { doc, comments },
      [url],
    );
  },
});

export const docCreate = defineVerb({
  name: "doc.create",
  summary: "Create a document.",
  description: "Creates a new document. It never overwrites: an existing path is a conflict.",
  input: z.strictObject({
    path: docPath,
    title: z.string().min(1).max(200).describe("Document title."),
    body: z.string().max(200_000).describe("Document text, Markdown."),
  }),
  args: ["path"],
  examples: ['ost doc create specs/checkout.md --title "Checkout" --body "# Checkout"'],
  async run(env, input) {
    const kb = requireKnowledge(env);
    const doc = await kb.create(input);
    const url = kb.links.doc(doc.id);
    return result([`Created ${doc.title} (${doc.path}).`, url], { doc }, [url]);
  },
});

async function ownComment(
  env: Parameters<typeof requireKnowledge>[0],
  docId: string,
  wanted: string,
) {
  const kb = requireKnowledge(env);
  const doc = await kb.get(docId);
  const comment = (await kb.comments(doc.id)).find((c) => c.id === wanted);
  if (!comment) {
    throw new PortError("not_found", `Comment ${wanted} not found on ${doc.path}.`);
  }

  return { kb, doc, comment, url: kb.links.doc(doc.id) };
}

export const docReply = defineVerb({
  name: "doc.reply",
  summary: "Reply to a comment on a document.",
  description: "Replies to a comment thread on a document.",
  input: z.strictObject({
    doc: id,
    commentId,
    body: z.string().min(1).max(20_000).describe("Reply text, Markdown."),
  }),
  args: ["doc", "commentId", "body"],
  examples: ['ost doc reply specs/checkout.md c-3 "Done, see the new section."'],
  async run(env, input) {
    const { kb, doc, url } = await ownComment(env, input.doc, input.commentId);
    const reply = await kb.reply(input.commentId, input.body);
    return result([`Replied to ${input.commentId} on ${doc.title}.`, url], { doc: doc.id, reply }, [
      url,
    ]);
  },
});

export const docResolve = defineVerb({
  name: "doc.resolve",
  summary: "Resolve a comment thread on a document.",
  description: "Marks a comment thread on a document as resolved.",
  input: z.strictObject({ doc: id, commentId }),
  args: ["doc", "commentId"],
  examples: ["ost doc resolve specs/checkout.md c-3"],
  async run(env, input) {
    const { kb, doc, url } = await ownComment(env, input.doc, input.commentId);
    await kb.resolve(input.commentId);
    return result(
      [`Resolved ${input.commentId} on ${doc.title}.`, url],
      { doc: doc.id, commentId: input.commentId, resolved: true },
      [url],
    );
  },
});

export const docVerbs = [docSearch, docShow, docCreate, docReply, docResolve];
