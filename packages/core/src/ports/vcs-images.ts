/** An image to store for a pull request, so that its description or a comment can show it. */
export interface PullRequestImage {
  /** File name; it becomes the stored file's name, made safe for a path. */
  name: string;
  mimetype: string;
  data: Uint8Array;
}

/** Where a pull request's image was stored. */
export interface StoredImage {
  /** A link the host's markdown renders as the image, in a description or a comment. */
  url: string;

  /** Where the file is, within the host's storage for images (for GitHub, `<pr number>/<name>` on the assets branch). */
  path: string;
}
