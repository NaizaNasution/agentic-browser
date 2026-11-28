// Key definitions for CDP Input.dispatchKeyEvent (US layout). Keyboard layouts and typing rhythm come in M4 (§11.8).

export interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  /** Text the key inserts, if any. */
  text?: string;
  /** Needs Shift on a US keyboard. */
  shift?: boolean;
}

export const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 } as const;
export type Modifier = keyof typeof MODIFIER_BITS;

const NAMED: Record<string, KeyDef> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Insert: { key: "Insert", code: "Insert", keyCode: 45 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
  Control: { key: "Control", code: "ControlLeft", keyCode: 17 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
  Alt: { key: "Alt", code: "AltLeft", keyCode: 18 },
  Meta: { key: "Meta", code: "MetaLeft", keyCode: 91 },
  ContextMenu: { key: "ContextMenu", code: "ContextMenu", keyCode: 93 },
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

const ALIASES: Record<string, string> = {
  esc: "Escape", return: "Enter", del: "Delete", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  pgup: "PageUp", pgdn: "PageDown", pageup: "PageUp", pagedown: "PageDown", space: "Space", spacebar: "Space",
  ctrl: "Control", control: "Control", cmd: "Meta", command: "Meta", meta: "Meta", win: "Meta", super: "Meta",
  option: "Alt", alt: "Alt", shift: "Shift", enter: "Enter", tab: "Tab", escape: "Escape", backspace: "Backspace",
  delete: "Delete", home: "Home", end: "End", insert: "Insert",
};

// US layout punctuation: [unshifted, shifted, code, keyCode]
const PUNCT: [string, string, string, number][] = [
  ["`", "~", "Backquote", 192], ["-", "_", "Minus", 189], ["=", "+", "Equal", 187], ["[", "{", "BracketLeft", 219],
  ["]", "}", "BracketRight", 221], ["\\", "|", "Backslash", 220], [";", ":", "Semicolon", 186], ["'", '"', "Quote", 222],
  [",", "<", "Comma", 188], [".", ">", "Period", 190], ["/", "?", "Slash", 191],
];
const DIGIT_SHIFTED = ")!@#$%^&*(";

/** Key for one typed character, or undefined if it has no US-keyboard key (typed with insertText instead). */
export function charKey(ch: string): KeyDef | undefined {
  if (ch === "\n" || ch === "\r") return NAMED.Enter;
  if (ch === "\t") return NAMED.Tab;
  if (ch === " ") return NAMED.Space;
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), text: ch };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), text: ch, shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), text: ch };
  const d = DIGIT_SHIFTED.indexOf(ch);
  if (d >= 0) return { key: ch, code: `Digit${d}`, keyCode: 48 + d, text: ch, shift: true };
  for (const [plain, shifted, code, keyCode] of PUNCT) {
    if (ch === plain) return { key: ch, code, keyCode, text: ch };
    if (ch === shifted) return { key: ch, code, keyCode, text: ch, shift: true };
  }
  return undefined;
}

export interface KeyCombo {
  modifiers: Modifier[];
  key: KeyDef;
}

/** Parses "Enter", "Control+A", "Shift+Tab", "ctrl+shift+k". Throws on an unknown key. */
export function parseCombo(input: string): KeyCombo {
  const parts = input.split("+").map((p) => p.trim());
  // "Control++" means Control and the "+" key.
  if (input.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const modifiers: Modifier[] = [];
  let key: KeyDef | undefined;
  parts.forEach((p, i) => {
    if (!p) throw new Error(`"${input}" isn't a key combination`);
    const named = NAMED[p] ? p : ALIASES[p.toLowerCase()];
    const last = i === parts.length - 1;
    if (!last) {
      if (named !== "Control" && named !== "Shift" && named !== "Alt" && named !== "Meta") throw new Error(`${p} isn't a modifier; use Control, Shift, Alt, or Meta before the key`);
      if (!modifiers.includes(named)) modifiers.push(named);
      return;
    }
    if (named) key = NAMED[named];
    else if (p.length === 1) key = charKey(p.length === 1 && /[A-Z]/.test(p) && modifiers.length ? p.toLowerCase() : p);
    if (!key) throw new Error(`unknown key "${p}"`);
  });
  return { modifiers, key: key! };
}

export function modifierBits(mods: readonly Modifier[]): number {
  return mods.reduce((bits, m) => bits | MODIFIER_BITS[m], 0);
}
