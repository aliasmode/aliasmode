// OS-level input for the gates on macOS (System Events keystrokes and CoreGraphics mouse events; no automation in
// the browser). The calling app needs Accessibility access (GitHub's macOS runners grant it).
// Usage: osascript -l JavaScript mac-input.js <command> [args]   (same commands as linux.sh, minus display-start/stop)
//   activate | open <url> | type <text> | key <combo...> | click <x> <y> | geometry | copytext <out.txt> [xfrac yfrac] | shot <out.png>
// Key names follow xdotool (ctrl+l, Return, Tab, space, Escape); ctrl means Command here, as in the browsers' shortcuts.
ObjC.import("Cocoa");
ObjC.import("CoreGraphics");
const se = Application("System Events");
const app = Application.currentApplication();
app.includeStandardAdditions = true;
const delay = (s) => $.NSThread.sleepForTimeInterval(s);
const CODES = { Return: 36, enter: 36, Tab: 48, space: 49, Escape: 53, BackSpace: 51, Left: 123, Right: 124, Down: 125, Up: 126 };
const MODS = { ctrl: "command down", control: "command down", cmd: "command down", shift: "shift down", alt: "option down" };

function front() { return se.processes.whose({ frontmost: true })[0]; }
function press(combo) {
  const parts = combo.split("+"), key = parts.pop();
  const using = parts.map((p) => MODS[p]).filter(Boolean);
  const opts = using.length ? { using } : {};
  if (key in CODES) se.keyCode(CODES[key], opts);
  else se.keystroke(key.toLowerCase(), opts);
  delay(0.08);
}
function typeText(text) { for (const ch of text) { se.keystroke(ch); delay(0.04); } }
function mouse(type, x, y) {
  const e = $.CGEventCreateMouseEvent(null, type, { x, y }, $.kCGMouseButtonLeft);
  $.CGEventPost($.kCGHIDEventTap, e);
  delay(0.05);
}
function clickAt(x, y) {
  mouse($.kCGEventMouseMoved, x, y); delay(0.2);
  mouse($.kCGEventLeftMouseDown, x, y); mouse($.kCGEventLeftMouseUp, x, y);
}
function geometry() {
  const w = front().windows[0];
  const [x, y] = w.position(), [width, height] = w.size();
  return { x, y, width, height };
}

function run(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case "activate": {
      const names = /chrom|firefox|aliasmode|camoufox/i;
      const procs = se.processes().filter((p) => { try { return names.test(p.name()) && p.windows.length > 0; } catch { return false; } });
      if (!procs.length) return "none";
      const p = procs.sort((a, b) => a.unixId() - b.unixId()).at(-1);
      p.frontmost = true;
      delay(0.3);
      return String(p.unixId());
    }
    case "open": press("ctrl+l"); delay(0.5); typeText(rest[0]); delay(0.3); press("Return"); return "";
    case "type": typeText(rest.join(" ")); return "";
    case "key": rest.forEach(press); return "";
    case "click": clickAt(Number(rest[0]), Number(rest[1])); return "";
    case "geometry": { const g = geometry(); return `${g.x} ${g.y} ${g.width} ${g.height}`; }
    case "copytext": {
      const [out, fx = "0.004", fy = "0.7"] = rest;
      const g = geometry(), board = $.NSPasteboard.generalPasteboard;
      board.clearContents;
      const x = g.x + g.width * Number(fx) + 2, y = g.y + g.height * Number(fy);
      clickAt(x, y); delay(0.3);
      press("ctrl+a"); delay(0.3); press("ctrl+c"); delay(0.7);
      const text = board.stringForType($.NSPasteboardTypeString);
      $(text.isNil() ? "" : text.js).writeToFileAtomicallyEncodingError(out, true, $.NSUTF8StringEncoding, null);
      mouse($.kCGEventLeftMouseDown, x, y); mouse($.kCGEventLeftMouseUp, x, y);
      return "";
    }
    case "shot": app.doShellScript(`screencapture -x '${rest[0].replace(/'/g, "'\\''")}'`); return "";
    default: throw new Error(`unknown command ${command}`);
  }
}
