import { PortError } from "./errors.js";

/** The largest image a pull request takes: 10 MB, as for a ticket's attachment. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The image types a pull request takes, with the extensions a name of each may end in. */
const IMAGE_TYPES: Record<string, { extensions: string[]; magic: (d: Uint8Array) => boolean }> = {
  "image/png": { extensions: ["png"], magic: (d) => starts(d, [0x89, 0x50, 0x4e, 0x47]) },
  "image/jpeg": { extensions: ["jpg", "jpeg"], magic: (d) => starts(d, [0xff, 0xd8, 0xff]) },
  "image/gif": { extensions: ["gif"], magic: (d) => text(d, 0, 4) === "GIF8" },
  "image/webp": {
    extensions: ["webp"],
    magic: (d) => text(d, 0, 4) === "RIFF" && text(d, 8, 12) === "WEBP",
  },
};

const starts = (d: Uint8Array, bytes: number[]) => bytes.every((b, i) => d[i] === b);
const text = (d: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...d.subarray(from, to));

/** The image types a pull request takes, for messages. */
export const IMAGE_TYPE_NAMES = "png, jpeg, gif or webp";

/**
 * The name to store a pull request's image under, after checking it: a png, jpeg, gif or webp (by its type and its
 * bytes) of at most `MAX_IMAGE_BYTES`, whose name ends in an extension of its type. Folders are dropped from the name
 * and characters other than letters, digits, dot, dash and underscore become dashes. Anything else is `invalid`.
 */
export function imageFileName(image: { name: string; mimetype: string; data: Uint8Array }): string {
  const kind = IMAGE_TYPES[image.mimetype];
  if (!kind || !kind.magic(image.data)) {
    throw new PortError(
      "invalid",
      `${image.name} is not an image a pull request takes (${IMAGE_TYPE_NAMES}).`,
    );
  }

  if (image.data.byteLength > MAX_IMAGE_BYTES) {
    throw new PortError("invalid", `${image.name} is larger than 10 MB.`);
  }

  const name = (image.name.split(/[/\\]/).pop() ?? "")
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(-100);

  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (!kind.extensions.includes(extension)) {
    throw new PortError(
      "invalid",
      `${image.name} must end in .${kind.extensions.join(" or .")}, as a ${image.mimetype} file.`,
    );
  }

  return name;
}
