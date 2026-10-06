import fs from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const packetSchema = z.strictObject({
  version: z.literal(1),
  nonce: z.base64().refine(value => Buffer.from(value, "base64").length === 12),
  ciphertext: z.base64(),
  tag: z.base64().refine(value => Buffer.from(value, "base64").length === 16)
});
export type CredentialScope = { authorizationId: string; accountId: string; generation: number };

export class CredentialVault {
  readonly #key: Buffer;

  constructor(keyPath: string) {
    const descriptor = fs.openSync(keyPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(descriptor);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || stat.size !== 32) {
        throw new Error("凭据主密钥必须是当前用户持有的 32 字节私有文件（0600 或 0400）");
      }
      this.#key = fs.readFileSync(descriptor);
      if (this.#key.length !== 32) throw new Error("凭据主密钥长度不正确");
    } finally {
      fs.closeSync(descriptor);
    }
  }

  encrypt(cookie: string, scope: CredentialScope): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(this.#aad(scope));
    const ciphertext = Buffer.concat([cipher.update(cookie, "utf8"), cipher.final()]);
    return JSON.stringify({ version: 1, nonce: nonce.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") });
  }

  decrypt(packet: string, scope: CredentialScope): string {
    try {
      const parsed = packetSchema.parse(JSON.parse(packet));
      const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(parsed.nonce, "base64"));
      decipher.setAAD(this.#aad(scope));
      decipher.setAuthTag(Buffer.from(parsed.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(parsed.ciphertext, "base64")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("凭据无法解密，相关授权不可用");
    }
  }

  #aad(scope: CredentialScope): Buffer {
    return Buffer.from(JSON.stringify([scope.authorizationId, scope.accountId, scope.generation]));
  }
}
