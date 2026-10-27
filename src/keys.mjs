// xdotool-style key chords ("ctrl+a", "super+c", "Return", "shift+Tab") parsed
// into a platform-neutral form. Backends map `key` names to native key codes.

const MODIFIERS = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  meta: "super",
  super: "super",
  cmd: "super",
  command: "super",
  win: "super",
  fn: "fn",
};

// Canonical names; anything else of length 1 is a literal character.
const NAMES = {
  return: "Return",
  enter: "Return",
  kp_enter: "KP_Enter",
  tab: "Tab",
  escape: "Escape",
  esc: "Escape",
  space: "space",
  backspace: "BackSpace",
  delete: "Delete",
  del: "Delete",
  forward_delete: "Delete",
  insert: "Insert",
  home: "Home",
  end: "End",
  page_up: "Page_Up",
  pageup: "Page_Up",
  prior: "Page_Up",
  page_down: "Page_Down",
  pagedown: "Page_Down",
  next: "Page_Down",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  minus: "minus",
  plus: "plus",
  equal: "equal",
  comma: "comma",
  period: "period",
  slash: "slash",
  backslash: "backslash",
  semicolon: "semicolon",
  apostrophe: "apostrophe",
  grave: "grave",
  bracketleft: "bracketleft",
  bracketright: "bracketright",
  caps_lock: "Caps_Lock",
};

for (let n = 1; n <= 20; n++) NAMES[`f${n}`] = `F${n}`;

export function parseChord(chord) {
  if (typeof chord !== "string" || chord.length === 0) {
    throw new TypeError("pressKey expects a key such as \"Return\" or \"ctrl+a\"");
  }
  // "ctrl++" means ctrl and the plus key.
  const parts = chord === "+" ? ["+"] : chord.replace(/\+\+$/, "+plus").split("+").filter(Boolean);
  const mods = [];
  let key = null;
  for (const [i, raw] of parts.entries()) {
    const lower = raw.toLowerCase();
    if (i < parts.length - 1) {
      const mod = MODIFIERS[lower];
      if (!mod) throw new TypeError(`Unknown modifier "${raw}" in "${chord}"`);
      if (!mods.includes(mod)) mods.push(mod);
      continue;
    }
    if (MODIFIERS[lower] && parts.length === 1) {
      // A bare modifier press.
      key = MODIFIERS[lower];
    } else if (NAMES[lower]) {
      key = NAMES[lower];
    } else if ([...raw].length === 1) {
      key = raw;
    } else {
      throw new TypeError(`Unknown key "${raw}" in "${chord}"`);
    }
  }
  return { key, mods };
}

// Accepts "ctrl+a", "ctrl+a ctrl+c" (space-separated sequence), or an array.
export function parseKeys(input) {
  const list = Array.isArray(input) ? input : String(input).trim().split(/\s+/);
  return list.map(parseChord);
}
