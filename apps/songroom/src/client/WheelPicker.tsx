import React, { useEffect, useId, useMemo, useRef } from "react";

export interface WheelPickerProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  disabled?: boolean;
  unit?: string;
  ariaLabel?: string;
}

const ITEM_HEIGHT = 40; // 每行高度 40px
const VISIBLE_ITEMS = 3; // 视窗展示 3 行

export function WheelPicker({
  value,
  onChange,
  min = 10,
  max = 50,
  disabled = false,
  unit = "首",
  ariaLabel = "期望抽选首数"
}: WheelPickerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isScrollingRef = useRef(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const internalValueRef = useRef(value);
  internalValueRef.current = value;

  const numbers = useMemo(() => {
    const list: number[] = [];
    for (let i = min; i <= max; i++) {
      list.push(i);
    }
    return list;
  }, [min, max]);

  // 同步外部 value 到容器滚动位置
  const scrollToValue = (val: number, smooth = false) => {
    const container = containerRef.current;
    if (!container) return;
    const clamped = Math.max(min, Math.min(max, val));
    const targetScrollTop = (clamped - min) * ITEM_HEIGHT;
    if (Math.abs(container.scrollTop - targetScrollTop) > 1) {
      if (smooth) {
        container.scrollTo({ top: targetScrollTop, behavior: "smooth" });
      } else {
        container.scrollTop = targetScrollTop;
      }
    }
  };

  // 初始及外部受控 value 变化时对齐滚动位置
  useEffect(() => {
    if (!isScrollingRef.current) {
      scrollToValue(value, false);
    }
  }, [value, min]);

  // 处理滚动事件及吸附计算
  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;

    isScrollingRef.current = true;
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    const scrollTop = container.scrollTop;
    const index = Math.round(scrollTop / ITEM_HEIGHT);
    const candidateValue = Math.max(min, Math.min(max, min + index));

    if (candidateValue !== internalValueRef.current) {
      onChange(candidateValue);
    }

    // 滚动停止后复位标记并对齐吸附位置
    scrollTimeoutRef.current = setTimeout(() => {
      isScrollingRef.current = false;
      scrollToValue(internalValueRef.current, true);
    }, 120);
  };

  // 桌面端鼠标滚轮滚动阻断与穿透防护
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (disabled) return;
    const container = containerRef.current;
    if (!container) return;

    const atTop = container.scrollTop <= 0 && e.deltaY < 0;
    const maxScroll = (max - min) * ITEM_HEIGHT;
    const atBottom = container.scrollTop >= maxScroll && e.deltaY > 0;

    // 到达边界时彻底拦截，防止滚轮穿透致使父级弹窗和背景页面滚动
    if (atTop || atBottom) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // 在滚轮内部滚动时也阻断向外冒泡
    e.stopPropagation();
  };

  // 键盘无障碍支持：上下方向键单步微调
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const nextVal = Math.max(min, value - 1);
      onChange(nextVal);
      scrollToValue(nextVal, true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextVal = Math.min(max, value + 1);
      onChange(nextVal);
      scrollToValue(nextVal, true);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      const nextVal = Math.max(min, value - 5);
      onChange(nextVal);
      scrollToValue(nextVal, true);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      const nextVal = Math.min(max, value + 5);
      onChange(nextVal);
      scrollToValue(nextVal, true);
    }
  };

  // 点击非中心项直接滚动到该数值
  const handleItemClick = (num: number) => {
    if (disabled) return;
    onChange(num);
    scrollToValue(num, true);
  };

  return (
    <div
      className={`wheel-picker-container ${disabled ? "disabled" : ""}`}
      style={{ height: ITEM_HEIGHT * VISIBLE_ITEMS }}
    >
      {/* 中心高亮指示层 */}
      <div
        className="wheel-picker-indicator"
        style={{
          top: ITEM_HEIGHT,
          height: ITEM_HEIGHT
        }}
        aria-hidden="true"
      >
        <span className="wheel-picker-unit">{unit}</span>
      </div>

      {/* 顶部与底部半透明渐隐遮罩 */}
      <div className="wheel-picker-mask-top" style={{ height: ITEM_HEIGHT }} aria-hidden="true" />
      <div
        className="wheel-picker-mask-bottom"
        style={{ top: ITEM_HEIGHT * 2, height: ITEM_HEIGHT }}
        aria-hidden="true"
      />

      {/* 滚动条目列表（具备键盘可聚焦与 spinbutton 语义，满足无障碍规范） */}
      <div
        ref={containerRef}
        className="wheel-picker-scroll-view"
        tabIndex={disabled ? -1 : 0}
        role="spinbutton"
        aria-label={ariaLabel}
        aria-valuenow={value}
        aria-valuemin={min}
        aria-valuemax={max}
        onKeyDown={handleKeyDown}
        onWheel={handleWheel}
        onScroll={handleScroll}
        style={{
          paddingTop: ITEM_HEIGHT,
          paddingBottom: ITEM_HEIGHT
        }}
      >
        {numbers.map(num => {
          const isSelected = num === value;
          return (
            <div
              key={num}
              className={`wheel-picker-item ${isSelected ? "selected" : ""}`}
              style={{ height: ITEM_HEIGHT, lineHeight: `${ITEM_HEIGHT}px` }}
              onClick={() => handleItemClick(num)}
            >
              <span className="wheel-picker-number">{num}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
