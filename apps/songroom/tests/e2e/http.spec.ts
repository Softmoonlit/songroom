import { expect, test } from "@playwright/test";

const expectedHealth = {
  service: "songroom",
  schemaVersion: 13
};

test.describe("公开 HTTP 边界", () => {
  test("健康接口使用共享响应形状和 no-store 缓存", async ({ request }) => {
    const statusResponse = await request.get("/api/status");
    expect(statusResponse.status()).toBe(200);
    expect(statusResponse.headers()["cache-control"]).toContain("no-store");
    expect(statusResponse.headers()["content-type"]).toContain("application/json");
    expect(await statusResponse.json()).toMatchObject({ ...expectedHealth, status: "ready" });

    const healthResponse = await request.get("/healthz");
    expect(healthResponse.status()).toBe(200);
    expect(healthResponse.headers()["cache-control"]).toContain("no-store");
    expect(await healthResponse.json()).toMatchObject({ ...expectedHealth, status: "ready" });
  });

  test("HTML 与静态资源提供缓存和安全响应头", async ({ request }) => {
    const documentResponse = await request.get("/");
    expect(documentResponse.status()).toBe(200);
    expect(documentResponse.headers()["cache-control"]).toContain("no-store");
    expect(documentResponse.headers()["content-type"]).toContain("text/html");
    expect(documentResponse.headers()["content-security-policy"]).toContain("default-src 'self'");
    expect(documentResponse.headers()["x-content-type-options"]).toBe("nosniff");
    expect(documentResponse.headers()["referrer-policy"]).toBeTruthy();

    const html = await documentResponse.text();
    const assetPath = html.match(/src="(\/assets\/[^\"]+\.js)"/)?.[1];
    expect(assetPath).toBeTruthy();

    const assetResponse = await request.get(assetPath!);
    expect(assetResponse.status()).toBe(200);
    expect(assetResponse.headers()["cache-control"]).toMatch(/public/);
    expect(assetResponse.headers()["cache-control"]).toMatch(/immutable/);
    expect(assetResponse.headers()["x-content-type-options"]).toBe("nosniff");
  });
});
