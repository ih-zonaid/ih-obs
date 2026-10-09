// Scrolls `el` into view *within* `container` instead of using
// Element.scrollIntoView. scrollIntoView also scrolls every scrollable
// ancestor, including the document element; since `html` is overflow:hidden
// that programmatic document scroll is not undone by user scrolling, so the
// whole 44px-tall toolbar row gets shifted off-screen and stays hidden until a
// reload. Scrolling the container directly never touches the document scroll.
// The nearest scrollable ancestor, so callers that only hold the element (the
// segment layer's boxes/markers) can scroll it without the document moving.
export function scrollParent(el: HTMLElement): HTMLElement | null {
  let node = el.parentElement;
  while (node) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === "auto" || overflowY === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

export function scrollIntoContainer(
  container: HTMLElement,
  el: HTMLElement,
  block: "start" | "center" | "nearest" = "start"
): void {
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  // The element's top relative to the container's current scroll position.
  const delta = eRect.top - cRect.top;
  const current = container.scrollTop;
  let top: number;
  if (block === "center") {
    top = current + delta - (container.clientHeight - eRect.height) / 2;
  } else if (block === "nearest") {
    // Only move when the element is outside the visible band, like
    // scrollIntoView({block:"nearest"}).
    if (delta >= 0 && delta + eRect.height <= container.clientHeight) return;
    top = delta < 0 ? current + delta : current + delta - container.clientHeight + eRect.height;
  } else {
    top = current + delta;
  }
  container.scrollTop = Math.max(0, top);
}
