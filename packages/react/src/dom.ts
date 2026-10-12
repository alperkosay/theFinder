/**
 * The window an element lives in. theFinder can be rendered into a popup window from the page that
 * opened it, so listeners, observers and frames go through the element's own window, not the global.
 */
export function viewOf(node: Node | null | undefined): Window & typeof globalThis {
  return (node?.ownerDocument?.defaultView ?? window) as Window & typeof globalThis;
}
