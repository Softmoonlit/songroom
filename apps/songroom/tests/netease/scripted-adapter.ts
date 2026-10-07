import type { AdapterInput, AdapterResult, NeteaseAdapter } from "../../src/netease/protocol.js";

/** 仅在测试启动器中注入，永远不连接真实网易云。 */
export class ScriptedNeteaseAdapter implements NeteaseAdapter {
  inputs: AdapterInput[] = [];
  identityError?: Extract<AdapterResult, { ok: false }>["error"];
  identityAccount?: string;
  beforeIdentity?: () => Promise<void>;
  playlistDetail?: (input: Extract<AdapterInput, { operation: "playlistDetail" }>) => Promise<AdapterResult<"playlistDetail">> | AdapterResult<"playlistDetail">;
  userPlaylists?: (input: Extract<AdapterInput, { operation: "userPlaylists" }>) => Promise<AdapterResult<"userPlaylists">> | AdapterResult<"userPlaylists">;
  playlistCreate?: (input: Extract<AdapterInput, { operation: "playlistCreate" }>) => Promise<AdapterResult<"playlistCreate">> | AdapterResult<"playlistCreate">;
  playlistDelete?: (input: Extract<AdapterInput, { operation: "playlistDelete" }>) => Promise<AdapterResult<"playlistDelete">> | AdapterResult<"playlistDelete">;
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
      case "userPlaylists":
        if (this.userPlaylists) return await this.userPlaylists(input) as AdapterResult<I["operation"]>;
        data = { playlists: [], more: false };
        break;
      case "playlistCreate":
        if (this.playlistCreate) return await this.playlistCreate(input) as AdapterResult<I["operation"]>;
        data = { playlistId: `cloud-created-${this.inputs.length}` };
        break;
      case "playlistDelete":
        if (this.playlistDelete) return await this.playlistDelete(input) as AdapterResult<I["operation"]>;
        data = { acknowledged: true };
        break;
      case "playlistDetail":
        if (this.playlistDetail) return await this.playlistDetail(input) as AdapterResult<I["operation"]>;
        data = {
          playlist: { id: input.playlistId, name: "默认歌单", creatorId: "test", subscribed: false, status: 0 },
          songIds: [],
          songs: []
        };
        break;
      default: return { ok: false, error: { code: "MODULE_ERROR", outcome: "failed" } };
    }
    return { ok: true, data } as AdapterResult<I["operation"]>;
  }
}
