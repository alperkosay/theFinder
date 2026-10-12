import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { TheFinder, type TheFinderProps } from "./TheFinder";

export interface FinderWindowOptions {
  /** Window width in CSS pixels, capped to the screen. Default: 1120. */
  width?: number;
  /** Window height in CSS pixels, capped to the screen. Default: 720. */
  height?: number;
  /** Text of the window's title bar. Default: "theFinder". */
  title?: string;
}

export interface FinderWindow {
  /** The browser window theFinder runs in. */
  window: Window;
  /** Closes the window. */
  close: () => void;
  /** Resolves once the window is gone, closed by the user or by `close()`. */
  closed: Promise<void>;
}

const STYLES = 'link[rel~="stylesheet"], style';

let seq = 0;

/**
 * Opens an empty same-origin browser window and renders into it from this page, with this page's
 * stylesheets. Nothing has to be served for it: the window runs on the opener's code, and closes
 * with it. Returns null when the browser blocks the popup.
 */
export function mountWindow(render: (close: () => void) => ReactNode, options: FinderWindowOptions = {}): FinderWindow | null {
  if (typeof window === "undefined") return null;
  const { screen } = window;
  const width = Math.min(options.width ?? 1120, screen.availWidth - 32);
  const height = Math.min(options.height ?? 720, screen.availHeight - 64);
  // Centered over the opener, like a dialog would be.
  const left = Math.round(window.screenX + Math.max(0, (window.outerWidth - width) / 2));
  const top = Math.round(window.screenY + Math.max(0, (window.outerHeight - height) / 2));
  const win = window.open("", `thefinder-${Date.now()}-${++seq}`, `popup=yes,width=${width},height=${height},left=${left},top=${top}`);
  if (!win) return null;

  // A doctype, or the blank page renders in quirks mode.
  const doc = win.document;
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>');
  doc.close();
  doc.title = options.title ?? "theFinder";
  // The host's theme switches (`class="dark"`, `lang`, CSS variables) usually live on <html>.
  for (const attr of Array.from(document.documentElement.attributes)) doc.documentElement.setAttribute(attr.name, attr.value);

  const copyStyle = (node: Element) => {
    if (!node.matches(STYLES)) return;
    const clone = doc.importNode(node, true) as HTMLElement;
    if (node instanceof HTMLLinkElement) clone.setAttribute("href", node.href);
    else if (node instanceof HTMLStyleElement && node.sheet) {
      // CSS-in-JS libraries insert rules through the CSSOM, leaving the element empty.
      try {
        clone.textContent = Array.from(node.sheet.cssRules, (rule) => rule.cssText).join("\n");
      } catch {
        // keep the copied text
      }
    }
    doc.head.appendChild(clone);
  };
  document.querySelectorAll(STYLES).forEach(copyStyle);
  // Stylesheets added later (lazy chunks, hot reload) follow.
  const styles = new MutationObserver((records) => {
    for (const record of records) record.addedNodes.forEach((node) => node instanceof Element && copyStyle(node));
  });
  styles.observe(document.head, { childList: true });

  // Inline, so the host page's own body rules cannot scroll or pad the window.
  doc.body.style.cssText = "margin: 0; padding: 0; height: 100dvh; overflow: hidden";
  const host = doc.createElement("div");
  host.className = "tf-window";
  doc.body.appendChild(host);
  const root = createRoot(host);

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    clearInterval(poll);
    styles.disconnect();
    window.removeEventListener("pagehide", close);
    if (!win.closed) win.close();
    resolveClosed();
    // Unmount after the current event finishes; React must not unmount a root mid-render.
    setTimeout(() => root.unmount());
  };
  // The window's own close button (or a reload, which would leave it without its UI).
  win.addEventListener("pagehide", close);
  // pagehide is not guaranteed for windows closed by the browser; the flag is.
  const poll = setInterval(() => win.closed && close(), 500);
  // The window runs on this page's code: it cannot outlive it.
  window.addEventListener("pagehide", close);

  root.render(render(close));
  win.focus();
  return { window: win, close, closed };
}

/**
 * Opens the file manager in its own browser window, like elFinder's standalone mode. Returns null
 * when the browser blocks the popup (call it from a click handler).
 *
 * ```ts
 * const finder = openFinderWindow({ endpoint: "/api/files" });
 * await finder?.closed;
 * ```
 */
export function openFinderWindow(props: Omit<TheFinderProps, "height">, options?: FinderWindowOptions): FinderWindow | null {
  return mountWindow(() => <TheFinder {...props} height="100%" />, options);
}
