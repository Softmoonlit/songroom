import { useEffect, useState } from "react";

export function useVirtualKeyboard() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    let layoutWidth = window.innerWidth;
    let unobscuredHeight = Math.max(window.innerHeight, viewport.height);
    function update() {
      const focused = document.activeElement;
      const editable =
        focused instanceof HTMLElement &&
        (focused.matches(
          "input:not([type=checkbox]):not([type=radio]):not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled])"
        ) ||
          focused.isContentEditable);
      // Width changes establish a new orientation baseline. Preserve the pre-keyboard height
      // when mobile browsers shrink innerHeight together with the visual viewport.
      if (window.innerWidth !== layoutWidth) {
        layoutWidth = window.innerWidth;
        unobscuredHeight = Math.max(window.innerHeight, viewport!.height);
      } else if (viewport!.scale === 1) {
        unobscuredHeight = Math.max(unobscuredHeight, window.innerHeight, viewport!.height);
      }
      // Focus alone (desktop keyboard) and small browser chrome changes are insufficient.
      setOpen(editable && viewport!.scale === 1 && unobscuredHeight - viewport!.height > 120);
    }
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", update);
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", update);
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return open;
}
