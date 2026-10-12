import { viewOf } from "./dom";
import { useCallback, useEffect, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** Parts of a title bar that keep their own pointer handling (typing, search). */
const NOT_A_HANDLE = "input, textarea, select, [contenteditable], .tf-search";
/** How much of the dialog stays on screen when it is dragged towards an edge. */
const KEEP_VISIBLE = 96;
/** Below this width dialogs fill the screen and stay put. */
const SMALL_SCREEN = "(max-width: 640px)";

const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

/**
 * Lets the user move a modal `<dialog>` by its title bar (`handle`, a selector), like a window.
 * The position lives only as long as the dialog, so every dialog opens centered.
 */
export function useMovable(ref: RefObject<HTMLDialogElement | null>, handle: string) {
  // Where the user put the dialog; null while it sits centered.
  const at = useRef<{ left: number; top: number } | null>(null);

  const isHandle = useCallback(
    (target: EventTarget | null) => {
      const el = target as Element | null;
      // A dialog opened from inside another one only moves itself.
      const bar = el?.closest?.(handle);
      return !!bar && bar.closest("dialog") === ref.current && !el!.closest(NOT_A_HANDLE);
    },
    [handle, ref],
  );

  const place = useCallback(
    (to: { left: number; top: number } | null) => {
      const el = ref.current;
      if (!el) return;
      if (!to) {
        at.current = null;
        for (const prop of ["margin", "inset", "transform", "translate"]) el.style.removeProperty(prop);
        return;
      }
      // Keep the title bar reachable.
      const view = viewOf(el);
      const left = clamp(to.left, KEEP_VISIBLE - el.offsetWidth, view.innerWidth - KEEP_VISIBLE);
      const top = clamp(to.top, 0, view.innerHeight - KEEP_VISIBLE / 2);
      at.current = { left, top };
      // Moved with inset, not a transform: a transform would make the dialog the containing block of
      // the context menus and overlays inside it, which are positioned against the viewport.
      el.style.margin = "0";
      el.style.inset = `${top}px auto auto ${left}px`;
      // A host page may center its dialogs with a transform; here the position alone counts.
      el.style.transform = "none";
      el.style.translate = "none";
    },
    [ref],
  );

  useEffect(() => {
    const view = viewOf(ref.current);
    const onResize = () => {
      if (at.current) place(view.matchMedia(SMALL_SCREEN).matches ? null : at.current);
    };
    view.addEventListener("resize", onResize);
    return () => view.removeEventListener("resize", onResize);
  }, [place, ref]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDialogElement>) => {
    const el = ref.current;
    if (!el || e.button !== 0 || !e.isPrimary || !isHandle(e.target)) return;
    const view = viewOf(el);
    if (view.matchMedia(SMALL_SCREEN).matches) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const from = at.current ?? { left: rect.left, top: rect.top };
    let moving = false;

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!moving) {
        // Below this it is a click on the path bar or a button, not a drag.
        if (Math.hypot(dx, dy) < 4) return;
        moving = true;
        el.classList.add("is-moving");
        view.getSelection()?.removeAllRanges();
        try {
          el.setPointerCapture(ev.pointerId);
        } catch {
          // the pointer is already gone; the window listeners still end the drag
        }
      }
      place({ left: from.left + dx, top: from.top + dy });
    };
    const end = () => {
      view.removeEventListener("pointermove", move);
      view.removeEventListener("pointerup", end);
      view.removeEventListener("pointercancel", end);
      if (!moving) return;
      el.classList.remove("is-moving");
      // The drag may have started on a button or the path bar: swallow the click that ends it.
      const swallow = (ev: MouseEvent) => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      view.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => view.removeEventListener("click", swallow, { capture: true }));
    };
    view.addEventListener("pointermove", move);
    view.addEventListener("pointerup", end);
    view.addEventListener("pointercancel", end);
  };

  /** Double click on the title bar puts the dialog back in the middle. */
  const onDoubleClick = (e: ReactMouseEvent) => {
    if (isHandle(e.target) && !(e.target as Element).closest("button, a, .tf-pathbar")) place(null);
  };

  return { onPointerDown, onDoubleClick };
}
