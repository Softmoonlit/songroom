import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes, createDecipheriv } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { CredentialVault } from "./credentials.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it("逐条随机加密且密文只可用于原授权、真实账号和凭据代次", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-key-")); roots.push(root);
  const key = randomBytes(32);
  const keyPath = path.join(root, "credentials.key");
  await fs.writeFile(keyPath, key, { mode: 0o600 });
  const vault = new CredentialVault(keyPath);
  const scope = { authorizationId: "binding-1", accountId: "000123", generation: 1 };
  const first = vault.encrypt("MUSIC_U=secret-cookie", scope);
  const second = vault.encrypt("MUSIC_U=secret-cookie", scope);
  expect(first).not.toBe(second);
  expect(first).not.toContain("secret-cookie");
  expect(vault.decrypt(first, scope)).toBe("MUSIC_U=secret-cookie");
  for (const changed of [{ authorizationId: "binding-2" }, { accountId: "123" }, { generation: 2 }]) {
    expect(() => vault.decrypt(first, { ...scope, ...changed })).toThrow(/凭据/);
  }
  const packet = JSON.parse(first) as { version: number; nonce: string; ciphertext: string; tag: string };
  expect(packet.version).toBe(1);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(packet.nonce, "base64"));
  decipher.setAAD(Buffer.from(JSON.stringify(["binding-1", "000123", 1])));
  decipher.setAuthTag(Buffer.from(packet.tag, "base64"));
  expect(Buffer.concat([decipher.update(Buffer.from(packet.ciphertext, "base64")), decipher.final()]).toString()).toBe("MUSIC_U=secret-cookie");
  packet.tag = Buffer.alloc(16).toString("base64");
  expect(() => vault.decrypt(JSON.stringify(packet), scope)).toThrow(/凭据/);
  await fs.chmod(keyPath, 0o644);
  expect(() => new CredentialVault(keyPath)).toThrow(/私有/);
});

it("凭据主密钥禁止使用符号链接", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "songroom-key-")); roots.push(root);
  const realKey = path.join(root, "real.key");
  await fs.writeFile(realKey, randomBytes(32), { mode: 0o600 });
  const symlinkKey = path.join(root, "symlink.key");
  await fs.symlink(realKey, symlinkKey);
  expect(() => new CredentialVault(symlinkKey)).toThrow(/符号链接/);
});
