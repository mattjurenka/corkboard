// The day plan's window: one, wherever it's opened from. Opened by name, so
// asking again finds the one that's open and brings it forward rather than
// opening another; the bridge closes any second one that gets through
// (planWindow in bridge/server.ts). "popup" keeps it an app window.

const NAME = "corkboard-day-plan";

// Returns false when the browser blocked it: call it from a click or a key,
// or within moments of one.
export function openPlan(): boolean {
  const w = window.open("", NAME, "popup");
  if (!w) return false;
  // A window just made by that call is blank; one already open is the plan,
  // and is left as it is.
  let blank = true;
  try {
    blank = w.location.href === "about:blank";
  } catch {}
  if (blank) {
    const url = new URL(location.href);
    url.search = "?view=plan";
    url.hash = "";
    w.location.href = url.toString();
  }
  w.focus();
  return true;
}
