/** Key definitions for CDP Input.dispatchKeyEvent, enough for form and page navigation. */

export interface KeyDefinition {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED: Record<string, KeyDefinition> = {
  Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", keyCode: 9 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete: { key: "Delete", code: "Delete", keyCode: 46 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home: { key: "Home", code: "Home", keyCode: 36 },
  End: { key: "End", code: "End", keyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};
for (let index = 1; index <= 12; index += 1) NAMED[`F${index}`] = { key: `F${index}`, code: `F${index}`, keyCode: 111 + index };

const ALIASES: Record<string, string> = { Return: "Enter", Esc: "Escape", Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Del: "Delete", " ": "Space" };

/** CDP modifier bits. "Mod" is Meta on macOS and Control elsewhere (select-all, copy, …). */
const MODIFIERS: Record<string, { bit: number; definition: KeyDefinition }> = {
  Alt: { bit: 1, definition: { key: "Alt", code: "AltLeft", keyCode: 18 } },
  Control: { bit: 2, definition: { key: "Control", code: "ControlLeft", keyCode: 17 } },
  Meta: { bit: 4, definition: { key: "Meta", code: "MetaLeft", keyCode: 91 } },
  Shift: { bit: 8, definition: { key: "Shift", code: "ShiftLeft", keyCode: 16 } },
};
const MODIFIER_ALIASES: Record<string, string> = { Ctrl: "Control", Cmd: "Meta", Command: "Meta", Option: "Alt", Mod: process.platform === "darwin" ? "Meta" : "Control" };

function characterKey(character: string): KeyDefinition {
  const upper = character.toUpperCase();
  if (/^[a-z]$/i.test(character)) return { key: character, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: character };
  if (/^[0-9]$/.test(character)) return { key: character, code: `Digit${character}`, keyCode: character.charCodeAt(0), text: character };
  return { key: character, code: "", keyCode: 0, text: character };
}

export interface KeyChord {
  modifiers: number;
  modifierKeys: KeyDefinition[];
  key: KeyDefinition;
}

/** Parse "Enter", "Control+A", "Shift+Tab", "Mod+a" or a single character. */
export function parseChord(chord: string): KeyChord {
  const parts = chord === "+" ? ["+"] : chord.split("+").map((part) => part.trim()).filter(Boolean);
  if (!parts.length) throw new Error("empty key");
  const last = parts.pop()!;
  let modifiers = 0;
  const modifierKeys: KeyDefinition[] = [];
  for (const raw of parts) {
    const name = MODIFIER_ALIASES[raw] ?? raw;
    const modifier = MODIFIERS[name];
    if (!modifier) throw new Error(`unknown modifier ${JSON.stringify(raw)}; use Control, Shift, Alt, Meta or Mod`);
    modifiers |= modifier.bit;
    modifierKeys.push(modifier.definition);
  }
  const name = ALIASES[last] ?? last;
  const key = NAMED[name] ?? (last.length === 1 ? characterKey(last) : undefined);
  if (!key) throw new Error(`unknown key ${JSON.stringify(last)}; use a single character or one of ${Object.keys(NAMED).join(", ")}`);
  // With Control/Meta/Alt held, a key types nothing (Mod+A selects, it does not insert "a").
  const typed = modifiers & (1 | 2 | 4) ? { ...key, text: undefined } : modifiers & 8 && key.text && /^[a-z]$/.test(key.text) ? { ...key, key: key.key.toUpperCase(), text: key.text.toUpperCase() } : key;
  return { modifiers, modifierKeys, key: typed };
}
