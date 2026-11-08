import { imageFileName } from "#/ports/index.js";
import type { PullRequestImage, RepoRef, StoredImage } from "#/ports/index.js";
import type { FakeVcsState } from "./vcs.types.js";

/** The fake's images: every image stored for a pull request, by `<repo key>/<number>/<name>`, the last one kept. */
export function fakeVcsImages(st: FakeVcsState) {
  const { key, need, grant, links } = st;
  const images = new Map<string, Omit<PullRequestImage, "name">>();
  const at = (repo: RepoRef, number: number, name: string) => `${key(repo)}/${number}/${name}`;

  return {
    images,

    async storeImage(repo: RepoRef, number: number, image: PullRequestImage): Promise<StoredImage> {
      grant(repo, "write");
      need(repo, number);
      const name = imageFileName(image);
      images.set(at(repo, number, name), { mimetype: image.mimetype, data: image.data.slice() });
      const path = `${number}/${name}`;
      return { url: `${links.pr(repo, number)}/images/${name}`, path };
    },

    async storedImage(repo: RepoRef, number: number, name: string) {
      const found = images.get(at(repo, number, name));
      return found ? { data: found.data.slice() } : undefined;
    },
  };
}
