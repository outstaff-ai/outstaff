export interface Avatars {
  render(
    seed: string,
    opts?: { size?: number },
  ): Promise<{ data: Uint8Array; mime: "image/svg+xml" | "image/png" }>;
}
