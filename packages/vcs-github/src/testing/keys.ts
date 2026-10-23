import { generateKeyPairSync } from "node:crypto";

/** One throwaway RSA key per test run. */
export const testKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
