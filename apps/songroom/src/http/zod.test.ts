import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { installZod, type ZodProvider } from "./zod.js";

const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(servers.map(server => server.close())); servers.length = 0; });

describe("Fastify/Zod 端点适配", () => {
  it("统一校验、转换请求并用同一响应 schema 序列化", async () => {
    const app = Fastify().withTypeProvider<ZodProvider>();
    servers.push(app);
    installZod(app);
    app.post("/example", {
      schema: { body: z.strictObject({ name: z.string().trim().min(1) }), response: { 200: z.object({ name: z.string() }) } }
    }, async request => ({ name: request.body.name }));
    expect((await app.inject({ method: "POST", url: "/example", payload: { name: "  一起点歌  " } })).json())
      .toEqual({ name: "一起点歌" });
    const rejected = await app.inject({ method: "POST", url: "/example", payload: { name: "", injected: "private-input" } });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.body).not.toContain("private-input");
  });

  it("响应违规时拒绝输出业务数据", async () => {
    const app = Fastify(); servers.push(app); installZod(app);
    app.get("/example", { schema: { response: { 200: z.object({ id: z.string() }) } } }, async () => ({ private: "secret" }));
    const response = await app.inject("/example");
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("secret");
  });
});
