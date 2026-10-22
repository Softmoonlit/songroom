import { Sun, Moon, Laptop } from "lucide-react";
import { useTheme } from "./theme";

export function ThemeToggle() {
  const { preference, resolvedTheme, cycleTheme } = useTheme();

  const getLabel = () => {
    switch (preference) {
      case "system":
        return `当前：跟随系统 (${resolvedTheme === "dark" ? "深色" : "浅色"}) - 点击切换为浅色模式`;
      case "light":
        return "当前：浅色模式 - 点击切换为深色模式";
      case "dark":
        return "当前：深色模式 - 点击切换为跟随系统";
    }
  };

  const label = getLabel();

  return (
    <button
      type="button"
      className="theme-toggle-btn"
      onClick={cycleTheme}
      title={label}
      aria-label={label}
    >
      {preference === "system" ? (
        <Laptop size={16} aria-hidden="true" />
      ) : preference === "light" ? (
        <Sun size={16} aria-hidden="true" />
      ) : (
        <Moon size={16} aria-hidden="true" />
      )}
    </button>
  );
}
