import { useState, useEffect, useCallback } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "songroom_theme_preference";
export const THEME_CYCLE_ORDER: ThemePreference[] = ["system", "light", "dark"];

export function getNextThemePreference(current: ThemePreference): ThemePreference {
  const nextIdx = (THEME_CYCLE_ORDER.indexOf(current) + 1) % THEME_CYCLE_ORDER.length;
  return THEME_CYCLE_ORDER[nextIdx];
}

export function getThemePreference(): ThemePreference {
  try {
    const val = localStorage.getItem(THEME_STORAGE_KEY);
    if (val === "light" || val === "dark" || val === "system") {
      return val;
    }
  } catch {
    // 忽略安全沙箱或无 localStorage 环境的异常
  }
  return "system";
}

export function getSystemTheme(): ResolvedTheme {
  if (typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference === "light") return "light";
  if (preference === "dark") return "dark";
  return getSystemTheme();
}

export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const resolved = resolveTheme(preference);
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", resolved);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute("content", resolved === "dark" ? "#0b0f19" : "#f8fafc");
    }
  }
  return resolved;
}

if (typeof window !== "undefined") {
  applyTheme(getThemePreference());
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(() => getThemePreference());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(getThemePreference()));

  const setTheme = useCallback((nextPref: ThemePreference) => {
    setPreference(nextPref);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, nextPref);
    } catch {
      // 忽略无法写入 localStorage 的环境
    }
    const resolved = applyTheme(nextPref);
    setResolvedTheme(resolved);
  }, []);

  const cycleTheme = useCallback(() => {
    setTheme(getNextThemePreference(preference));
  }, [preference, setTheme]);

  // 监听系统主题变化（仅在 preference 为 system 时实时响应）
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = () => {
      if (getThemePreference() === "system") {
        const resolved = applyTheme("system");
        setResolvedTheme(resolved);
      }
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return {
    preference,
    resolvedTheme,
    setTheme,
    cycleTheme
  };
}
