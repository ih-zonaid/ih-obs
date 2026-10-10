// Which interaction profile the app runs under.
//
// Authoring — drawing boxes and marks, the transform frame, split, segment —
// is built for a precise pointer that also has a hover state and a keyboard. A
// finger has none of the three: the drag threshold is 3px, the resize handles
// are 9px, there is no right-click to open a menu and no Esc to back out of a
// tool. Rather than teach every tool to limp along on touch, the phone is the
// *reading* device — scroll, pinch, tap to reveal, play cards — and the desktop
// is where decks get built.
//
// The signal is the *primary* pointer rather than the viewport width: a desktop
// window narrowed to 700px still has a mouse and keeps its tools, while a
// tablet has width to spare and still should not get them.
const COARSE = "(pointer: coarse)";

// `?author=1` forces the desktop profile back on, `?author=0` the reading one.
// A phone is a poor place to build a deck but not an impossible one, and this
// is also how the reading profile gets exercised on a desktop browser. Read
// once at module load: it is a deliberate override, not live state.
const forced = ((): boolean | null => {
  const value = new URLSearchParams(window.location.search).get("author");
  if (value === "1") return true;
  if (value === "0") return false;
  return null;
})();

export function isReadingMode(): boolean {
  if (forced !== null) return !forced;
  return window.matchMedia(COARSE).matches;
}

// Fires when the primary pointer changes — a mouse paired with a tablet, a
// keyboard case on a phone. Reporting it is all this does; rebuilding the
// authoring objects for it is the caller's problem, and today the app only
// re-shapes the chrome (a document opened later gets the full desktop set).
export function onProfileChange(handler: () => void): void {
  window.matchMedia(COARSE).addEventListener("change", handler);
}
