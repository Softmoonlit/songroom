import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  THEME_STORAGE_KEY,
  THEME_CYCLE_ORDER,
  getNextThemePreference,
  getThemePreference,
  getSystemTheme,
  resolveTheme,
  applyTheme
} from "./theme.js";

describe("Theme System (深色模式系统)", () => {
  let originalLocalStorage: Storage;
  let originalMatchMedia: typeof window.matchMedia;
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    originalLocalStorage = globalThis.localStorage;
    originalMatchMedia = globalThis.matchMedia;

    (globalThis as any).window = globalThis;

    // 模拟 localStorage
    const storageMock: Storage = {
      getItem: (key: string) => mockStorage[key] ?? null,
      setItem: (key: string, value: string) => {
        mockStorage[key] = String(value);
      },
      removeItem: (key: string) => {
        delete mockStorage[key];
      },
      clear: () => {
        mockStorage = {};
      },
      key: (index: number) => Object.keys(mockStorage)[index] ?? null,
      length: 0
    };
    Object.defineProperty(globalThis, "localStorage", {
      value: storageMock,
      writable: true,
      configurable: true
    });

    // 模拟 document 与 html 根元素
    const attributes: Record<string, string> = {};
    const metaAttrs: Record<string, string> = { name: "theme-color", content: "#f6f7fb" };

    const mockDocument = {
      documentElement: {
        setAttribute: (name: string, value: string) => {
          attributes[name] = value;
        },
        getAttribute: (name: string) => attributes[name] ?? null
      },
      querySelector: (selector: string) => {
        if (selector === 'meta[name="theme-color"]') {
          return {
            setAttribute: (name: string, value: string) => {
              metaAttrs[name] = value;
            },
            getAttribute: (name: string) => metaAttrs[name] ?? null
          };
        }
        return null;
      }
    };
    Object.defineProperty(globalThis, "document", {
      value: mockDocument,
      writable: true,
      configurable: true
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      writable: true,
      configurable: true
    });
    Object.defineProperty(globalThis, "matchMedia", {
      value: originalMatchMedia,
      writable: true,
      configurable: true
    });
    vi.restoreAllMocks();
  });

  it("常量键名应固定为 songroom_theme_preference", () => {
    expect(THEME_STORAGE_KEY).toBe("songroom_theme_preference");
  });

  it("未配置时默认偏好为 system，无效值回退为 system", () => {
    expect(getThemePreference()).toBe("system");

    localStorage.setItem(THEME_STORAGE_KEY, "invalid-theme");
    expect(getThemePreference()).toBe("system");

    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(getThemePreference()).toBe("light");

    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    expect(getThemePreference()).toBe("dark");

    localStorage.setItem(THEME_STORAGE_KEY, "system");
    expect(getThemePreference()).toBe("system");
  });

  it("系统主题检测：根据 matchMedia 返回 dark 或 light", () => {
    globalThis.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query.includes("dark"),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }));

    expect(getSystemTheme()).toBe("dark");

    globalThis.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }));

    expect(getSystemTheme()).toBe("light");
  });

  it("主题计算：显式 light/dark 直接生效，system 跟随操作系统", () => {
    globalThis.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }));

    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
    expect(resolveTheme("system")).toBe("dark");

    globalThis.matchMedia = vi.fn().mockImplementation(() => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    }));

    expect(resolveTheme("system")).toBe("light");
  });

  it("主题三态循环序列正确：system -> light -> dark -> system", () => {
    expect(THEME_CYCLE_ORDER).toEqual(["system", "light", "dark"]);
    expect(getNextThemePreference("system")).toBe("light");
    expect(getNextThemePreference("light")).toBe("dark");
    expect(getNextThemePreference("dark")).toBe("system");
  });

  it("应用主题：正确在 document.documentElement 设置 data-theme 并更新 meta theme-color", () => {
    const resLight = applyTheme("light");
    expect(resLight).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    const metaLight = document.querySelector('meta[name="theme-color"]');
    expect(metaLight?.getAttribute("content")).toBe("#f8fafc");

    const resDark = applyTheme("dark");
    expect(resDark).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    const metaDark = document.querySelector('meta[name="theme-color"]');
    expect(metaDark?.getAttribute("content")).toBe("#0b0f19");
  });
});
