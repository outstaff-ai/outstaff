import { createPrivateKey, sign } from "node:crypto";

const b64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

/** RS256 JWT for authenticating as a GitHub App. Backdated a minute for clock drift; GitHub allows at most ten minutes. */
export function signAppJwt(appId: string, privateKeyPem: string, now: Date): string {
  const iat = Math.floor(now.getTime() / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 9 * 60 + 60, iss: appId }));
  const data = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(data), createPrivateKey(privateKeyPem));
  return `${data}.${b64url(signature)}`;
}
