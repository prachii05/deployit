/**
 * AES-256-GCM helpers, shared format with apps/api/src/crypto.ts.
 * The worker only needs decrypt (env vars are written by the API).
 */

import { createDecipheriv } from "node:crypto";
import { env } from "./env.js";

const KEY = Buffer.from(env.ENCRYPTION_KEY, "hex");
const ALG = "aes-256-gcm";

export function decrypt(ciphertext: string): string {
  const [ivB64, tagB64, encB64] = ciphertext.split(".");
  if (!ivB64 || !tagB64 || !encB64) throw new Error("invalid ciphertext");
  const decipher = createDecipheriv(ALG, KEY, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const dec = Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]);
  return dec.toString("utf8");
}
