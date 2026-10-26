import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signAppJwt } from "../jwt.js";
import { testKey } from "../testing/keys.js";

describe("signAppJwt", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const jwt = signAppJwt("12345", testKey.privateKey, now);
  const [header, payload, signature] = jwt.split(".") as [string, string, string];

  it("has an RS256 header and the claims GitHub requires", () => {
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });

    const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      iss: string;
      iat: number;
      exp: number;
    };

    const t = now.getTime() / 1000;
    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(t - 60);
    expect(claims.exp - t).toBeLessThanOrEqual(600);
    expect(claims.exp).toBeGreaterThan(t);
  });

  it("is signed with the private key (verifies with the public key, fails with another)", () => {
    const ok = verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      createPublicKey(testKey.publicKey),
      Buffer.from(signature, "base64url"),
    );

    expect(ok).toBe(true);
    const tampered = verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}x`),
      createPublicKey(testKey.publicKey),
      Buffer.from(signature, "base64url"),
    );

    expect(tampered).toBe(false);
  });
});
