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
  const isProgrammaticScrollRef = useRef(false);
  const programmaticScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const wheelAccumulatorRef = useRef(0);
  const wheelResetTimeoutRef = useRef<NodeJS.Timeout | null>(null);
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
        isProgrammaticScrollRef.current = true;
        if (programmaticScrollTimeoutRef.current) {
          clearTimeout(programmaticScrollTimeoutRef.current);
        }
        container.scrollTo({ top: targetScrollTop, behavior: "smooth" });
        programmaticScrollTimeoutRef.current = setTimeout(() => {
          isProgrammaticScrollRef.current = false;
        }, 220);
      } else {
        container.scrollTop = targetScrollTop;
      }
    }
  };

  // 初始及外部受控 value 变化时对齐滚动位置
  useEffect(() => {
    if (!isScrollingRef.current && !isProgrammaticScrollRef.current) {
      scrollToValue(value, false);
    }
  }, [value, min]);

  // 处理原生滚动事件及吸附计算（主要用于移动端触控滑动与吸附对齐）
  const handleScroll = () => {
    if (isProgrammaticScrollRef.current) {
      return;
    }
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
      internalValueRef.current = candidateValue;
      onChange(candidateValue);
    }

    // 滚动停止后复位标记并精细校准吸附位置
    scrollTimeoutRef.current = setTimeout(() => {
      isScrollingRef.current = false;
      scrollToValue(internalValueRef.current, true);
    }, 120);
  };

  // 桌面端鼠标滚轮滚动：非 passive 原生监听，阻断穿透并平滑单步微调
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onWheel = (e: WheelEvent) => {
      if (disabled) return;
      e.stopPropagation();

      const currentVal = internalValueRef.current;
      const isAtMin = currentVal <= min && e.deltaY < 0;
      const isAtMax = currentVal >= max && e.deltaY > 0;

      // 到达边界时彻底拦截默认滚动，杜绝外部弹窗或底层页面产生晃动
      if (isAtMin || isAtMax) {
        e.preventDefault();
        wheelAccumulatorRef.current = 0;
        return;
      }

      e.preventDefault();

      if (wheelResetTimeoutRef.current) {
        clearTimeout(wheelResetTimeoutRef.current);
      }
      wheelResetTimeoutRef.current = setTimeout(() => {
        wheelAccumulatorRef.current = 0;
      }, 150);

      wheelAccumulatorRef.current += e.deltaY;
      const THRESHOLD = 35; // 累积阈值，适配不同灵敏度的鼠标滚轮与触控板

      if (Math.abs(wheelAccumulatorRef.current) >= THRESHOLD) {
        const direction = wheelAccumulatorRef.current > 0 ? 1 : -1;
        wheelAccumulatorRef.current = 0;
        const nextVal = Math.max(min, Math.min(max, currentVal + direction));
        if (nextVal !== currentVal) {
          internalValueRef.current = nextVal;
          onChange(nextVal);
          scrollToValue(nextVal, true);
        }
      }
    };

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
      if (wheelResetTimeoutRef.current) {
        clearTimeout(wheelResetTimeoutRef.current);
      }
      if (programmaticScrollTimeoutRef.current) {
        clearTimeout(programmaticScrollTimeoutRef.current);
      }
    };
  }, [disabled, min, max, onChange]);

  // 键盘无障碍支持：上下方向键单步微调
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;

    if (e.key === "ArrowUp") {
      e.preventDefault();
      const nextVal = Math.max(min, internalValueRef.current - 1);
      internalValueRef.current = nextVal;
      onChange(nextVal);
      scrollToValue(nextVal, true);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextVal = Math.min(max, internalValueRef.current + 1);
      internalValueRef.current = nextVal;
      onChange(nextVal);
      scrollToValue(nextVal, true);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      const nextVal = Math.max(min, internalValueRef.current - 5);
      internalValueRef.current = nextVal;
      onChange(nextVal);
      scrollToValue(nextVal, true);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      const nextVal = Math.min(max, internalValueRef.current + 5);
      internalValueRef.current = nextVal;
      onChange(nextVal);
      scrollToValue(nextVal, true);
    }
  };

  // 点击非中心项直接滚动到该数值
  const handleItemClick = (num: number) => {
    if (disabled) return;
    internalValueRef.current = num;
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
