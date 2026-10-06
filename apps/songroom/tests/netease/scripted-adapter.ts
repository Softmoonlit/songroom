import type { AdapterInput, AdapterResult, NeteaseAdapter } from "../../src/netease/protocol.js";

/** 仅在测试启动器中注入，永远不连接真实网易云。 */
export class ScriptedNeteaseAdapter implements NeteaseAdapter {
  inputs: AdapterInput[] = [];
  identityError?: Extract<AdapterResult, { ok: false }>["error"];
  identityAccount?: string;
  beforeIdentity?: () => Promise<void>;
  #qr = 0;
  async assertVendorIntegrity() {}
  async dispose() {}
  async call<I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> {
    this.inputs.push(input);
    let data: unknown;
    switch (input.operation) {
      case "qrKey": data = { key: `test-${++this.#qr}` }; break;
      case "qrCreate": data = { url: `https://music.163.com/login?code=${input.key}`, image: "data:image/png;base64,dGVzdA==" }; break;
      case "qrCheck": data = { status: "authorized", cookie: `MUSIC_U=${input.key}` }; break;
      case "identity":
        await this.beforeIdentity?.();
        if (this.identityError) return { ok: false, error: this.identityError };
        data = { accountId: this.identityAccount ?? input.cookie.slice("MUSIC_U=".length), name: "测试网易云身份" };
        break;
      default: return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
    }
    return { ok: true, data } as AdapterResult<I["operation"]>;
  }
}
