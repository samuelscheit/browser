/**
 * Code that runs inside the page, in an isolated JavaScript world the agent creates per frame
 * (page scripts cannot see or tamper with it). Each function is serialized with
 * `Function.prototype.toString`, so it must be self-contained: no imports, no outer references.
 */

export interface RawElement {
  id: number;
  role: string;
  name: string;
  value?: string;
  states: string[];
  options?: string[];
  href?: string;
  /** Distance in viewport heights from the visible area (0 = visible now). */
  distance: number;
}

export interface RawFrameSnapshot {
  url: string;
  title: string;
  elements: RawElement[];
  text: string;
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
  /** Interactive candidates found before the per-frame cap was applied. */
  total: number;
}

export interface SnapshotScriptOptions {
  maxElements: number;
  textChars: number;
}

/** Collect visible interactive elements of this frame's document (open shadow roots included). */
export function snapshotFrame(options: SnapshotScriptOptions): RawFrameSnapshot {
  type Registry = { ids: WeakMap<Element, number>; elements: Map<number, WeakRef<Element>>; next: number };
  const host = globalThis as unknown as { __fabricTaskAgent?: Registry };
  const registry = host.__fabricTaskAgent ??= { ids: new WeakMap(), elements: new Map(), next: 1 };
  // A long-lived app re-renders constantly: forget refs whose elements were collected.
  if (registry.elements.size > 5_000) for (const [id, ref] of registry.elements) if (!ref.deref()) registry.elements.delete(id);
  const refOf = (element: Element): number => {
    let id = registry.ids.get(element);
    if (id === undefined) {
      id = registry.next++;
      registry.ids.set(element, id);
      registry.elements.set(id, new WeakRef(element));
    }
    return id;
  };

  const clean = (text: string | null | undefined, max: number): string => {
    const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
    return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
  };

  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton", "treeitem", "gridcell",
  ]);
  const INPUT_ROLES: Record<string, string> = {
    checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox",
    submit: "button", button: "button", reset: "button", image: "button", file: "file-input",
  };

  const deepActive = (): Element | null => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return active;
  };
  const focused = deepActive();

  const byIdText = (element: Element, ids: string): string => {
    const root = element.getRootNode() as Document | ShadowRoot;
    return ids.split(/\s+/).map((id) => root.getElementById?.(id) ?? document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null).map((node) => node.innerText || node.textContent || "").join(" ");
  };

  const roleOf = (element: Element): string | undefined => {
    const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit && INTERACTIVE_ROLES.has(explicit)) return explicit;
    const tag = element.localName;
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return (element as HTMLSelectElement).multiple ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const type = (element as HTMLInputElement).type;
      if (type === "hidden") return undefined;
      return INPUT_ROLES[type] ?? "textbox";
    }
    const editable = element.getAttribute("contenteditable");
    if (editable !== null && editable !== "false") return "textbox";
    if (explicit) return undefined;
    const tabIndex = element.getAttribute("tabindex");
    if (tabIndex !== null && Number(tabIndex) >= 0) return "focusable";
    if (element.hasAttribute("onclick")) return "clickable";
    return undefined;
  };

  const nameOf = (element: Element, role: string): string => {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = clean(byIdText(element, labelledBy), 100);
      if (text) return text;
    }
    const aria = clean(element.getAttribute("aria-label"), 100);
    if (aria) return aria;
    const tag = element.localName;
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const control = element as HTMLInputElement;
      const fromLabels = clean(Array.from(control.labels ?? []).map((label) => label.innerText).join(" "), 100);
      if (fromLabels) return fromLabels;
      if (tag === "input" && ["submit", "button", "reset"].includes(control.type)) return clean(control.value || control.type, 100);
      if (tag === "input" && control.type === "image") return clean(control.alt || "Submit", 100);
      const hint = clean(control.getAttribute("placeholder") || element.getAttribute("title") || control.name, 100);
      if (hint) return hint;
    }
    const text = clean((element as HTMLElement).innerText, role === "scrollable" ? 50 : 100);
    if (text && role !== "textbox") return text;
    const image = element.querySelector("img[alt], svg[aria-label], [title]");
    const imageName = clean(image?.getAttribute("alt") ?? image?.getAttribute("aria-label") ?? image?.getAttribute("title"), 100);
    if (imageName) return imageName;
    return clean(element.getAttribute("title") ?? (role === "textbox" ? element.getAttribute("placeholder") : ""), 100);
  };

  const describe = (element: Element, role: string): Omit<RawElement, "id" | "distance"> => {
    const states: string[] = [];
    const tag = element.localName;
    const html = element as HTMLInputElement;
    let value: string | undefined;
    let options: string[] | undefined;
    if (tag === "input" && !["checkbox", "radio", "submit", "button", "reset", "image"].includes(html.type)) {
      if (html.type === "password") value = html.value ? "••••••" : "";
      else if (html.type === "file") value = Array.from(html.files ?? []).map((file) => file.name).join(", ");
      else value = clean(html.value, 120);
      if (html.type !== "text" && INPUT_ROLES[html.type] === undefined) states.push(`type=${html.type}`);
    } else if (tag === "textarea") value = clean(html.value, 200);
    else if (tag === "select") {
      const select = element as HTMLSelectElement;
      value = clean(Array.from(select.selectedOptions).map((option) => option.label || option.text).join(", "), 120);
      options = Array.from(select.options).slice(0, 20).map((option) => clean(option.label || option.text, 40));
      if (select.options.length > 20) options.push(`…${select.options.length - 20} more`);
    } else if (role === "textbox") value = clean((element as HTMLElement).innerText, 200);
    else if (element.getAttribute("aria-valuenow") !== null) value = clean(element.getAttribute("aria-valuetext") ?? element.getAttribute("aria-valuenow"), 40);
    if (role === "checkbox" || role === "radio" || role === "switch" || role === "menuitemcheckbox" || role === "menuitemradio") {
      const checked = tag === "input" ? html.checked : element.getAttribute("aria-checked") === "true";
      states.push(checked ? "checked" : "unchecked");
    }
    if ((element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true") states.push("disabled");
    if ((element as HTMLInputElement).required || element.getAttribute("aria-required") === "true") states.push("required");
    if ((element as HTMLInputElement).readOnly && tag !== "select") states.push("readonly");
    for (const state of ["expanded", "selected", "pressed"] as const) {
      const attribute = element.getAttribute(`aria-${state}`);
      if (attribute === "true") states.push(state);
      else if (attribute === "false" && state === "expanded") states.push("collapsed");
    }
    if (element.getAttribute("aria-invalid") === "true") states.push("invalid");
    if (element === focused) states.push("focused");
    const href = tag === "a" ? clean(element.getAttribute("href"), 80) : undefined;
    return {
      role,
      name: nameOf(element, role),
      ...(value !== undefined ? { value } : {}),
      states,
      ...(options ? { options } : {}),
      ...(href && !href.startsWith("javascript:") ? { href } : {}),
    };
  };

  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 1;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1;
  const candidates: RawElement[] = [];
  let visited = 0;
  const MAX_VISITED = 60_000;

  const visible = (element: Element, rect: DOMRect): boolean =>
    rect.width > 0 && rect.height > 0
    && element.checkVisibility({ opacityProperty: true, visibilityProperty: true } as CheckVisibilityOptions)
    && rect.right > 0 && rect.left < viewportWidth;

  const distanceOf = (rect: DOMRect): number =>
    rect.bottom < 0 ? Math.ceil(-rect.bottom / viewportHeight) : rect.top > viewportHeight ? Math.ceil((rect.top - viewportHeight) / viewportHeight) : 0;

  /** A checkbox/radio hidden behind its styled <label>: the label is what a person clicks. */
  const hiddenControlOf = (label: Element): HTMLInputElement | undefined => {
    const control = (label as HTMLLabelElement).control as HTMLInputElement | null;
    if (!control || (control.type !== "checkbox" && control.type !== "radio")) return undefined;
    return visible(control, control.getBoundingClientRect()) ? undefined : control;
  };

  /** Walk in composed pre-order; returns whether the subtree holds a real (non-"clickable") control. */
  const walk = (root: Document | ShadowRoot | Element, pointerParent: boolean): boolean => {
    let holdsControl = false;
    for (const child of Array.from(root.children)) {
      if (++visited > MAX_VISITED) return holdsControl;
      if ((child as HTMLElement).inert) continue;
      // Prune display:none subtrees (no descendant can render). A display:contents element has
      // no box of its own, so checkVisibility() is false while its children render: walk through it.
      const contents = !child.checkVisibility();
      if (contents && getComputedStyle(child).display !== "contents") continue;
      if (child.localName === "iframe" || child.localName === "frame" || child.localName === "script" || child.localName === "style") continue;
      const control = child.localName === "label" ? hiddenControlOf(child) : undefined;
      if (control) {
        const rect = child.getBoundingClientRect();
        if (visible(child, rect)) {
          const described = describe(control, control.type);
          candidates.push({ id: refOf(child), ...described, name: clean((child as HTMLElement).innerText, 100) || described.name, distance: distanceOf(rect) });
          holdsControl = true;
        }
        continue;
      }
      let role = roleOf(child);
      let pointer = pointerParent;
      if (!role) {
        const style = getComputedStyle(child);
        pointer = style.cursor === "pointer";
        if (pointer && !pointerParent) role = "clickable";
        // A scroll container (not the page itself): the agent scrolls inside it by ref.
        else if ((style.overflowY === "auto" || style.overflowY === "scroll") && child.scrollHeight > child.clientHeight + 20 && child !== document.scrollingElement && child !== document.body) role = "scrollable";
      }
      const index = candidates.length;
      if (role && !contents) {
        const rect = child.getBoundingClientRect();
        if (visible(child, rect)) candidates.push({ id: refOf(child), ...describe(child, role), distance: distanceOf(rect) });
      }
      let inner = false;
      if (child.shadowRoot) inner = walk(child.shadowRoot, pointer);
      // Do not descend into elements that are one control themselves (their text is their name).
      const container = !role || role === "focusable" || role === "clickable" || role === "scrollable" || role === "listbox" || role === "gridcell" || role === "option" || role === "treeitem";
      if (container) inner = walk(child, pointer) || inner;
      // A clickable wrapper around a real control adds nothing.
      if (role === "clickable" && inner && candidates[index]?.id === registry.ids.get(child)) candidates.splice(index, 1);
      holdsControl ||= inner || (role !== undefined && role !== "clickable" && role !== "scrollable");
    }
    return holdsControl;
  };
  walk(document, false);
  const total = candidates.length;
  const elements = candidates.length > options.maxElements
    ? candidates.map((element, order) => ({ element, order }))
      .sort((left, right) => left.element.distance - right.element.distance || left.order - right.order)
      .slice(0, options.maxElements).sort((left, right) => left.order - right.order).map(({ element }) => element)
    : candidates;

  const text = options.textChars > 0 ? clean(document.body?.innerText ?? "", options.textChars) : "";
  return {
    url: location.href,
    title: document.title,
    elements,
    text,
    scrollY: Math.round(window.scrollY),
    scrollHeight: Math.round(document.documentElement.scrollHeight),
    viewportHeight: Math.round(viewportHeight),
    total,
  };
}

/** The element behind a ref, or null when it is gone (re-rendered, removed, or another document). */
export function elementByRef(id: number): Element | null {
  const registry = (globalThis as unknown as { __fabricTaskAgent?: { elements: Map<number, WeakRef<Element>> } }).__fabricTaskAgent;
  const element = registry?.elements.get(id)?.deref() ?? null;
  return element?.isConnected ? element : null;
}

/** Resolve when the document has had no DOM mutation for `quietMs` (bounded by `maxMs`). */
export function waitForDomQuiet(quietMs: number, maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    let timer = setTimeout(finish, quietMs);
    const cap = setTimeout(finish, maxMs);
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(finish, quietMs);
    });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    function finish(): void {
      observer.disconnect();
      clearTimeout(timer);
      clearTimeout(cap);
      resolve();
    }
  });
}

/**
 * Judge Chrome's hit test at the exact click point: `hitNode` is what receives the click there
 * (null when it is outside this frame). Returns null when that is the element itself, something
 * inside it (also through shadow roots) or its own label; otherwise a short description of what
 * covers it.
 */
export function coveringElement(this: Element, hitNode: Node | null): string | null {
  const hit = hitNode?.nodeType === Node.ELEMENT_NODE ? hitNode as Element : hitNode?.parentElement ?? null;
  if (!hit) return "something outside this frame";
  if (hit.contains(this) && hit.localName === "label") return null;
  let node: Node | null = hit;
  while (node) {
    if (node === this || (node as HTMLLabelElement).control === this) return null;
    node = node.parentNode ?? (node as ShadowRoot).host ?? null;
  }
  const name = ((hit as HTMLElement).innerText || hit.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 60);
  return `<${hit.localName}${hit.id ? `#${hit.id}` : ""}>${name ? ` "${name}"` : ""}`;
}

/** Prepare an editable element for replacement: select its current content. */
export function selectContents(this: Element): string {
  const element = this as HTMLInputElement;
  if (element.localName === "input" || element.localName === "textarea") {
    element.focus();
    try {
      element.select();
      return "selected";
    } catch {
      return "unselectable";
    }
  }
  if ((element as HTMLElement).isContentEditable) {
    (element as HTMLElement).focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return "selected";
  }
  return "not-editable";
}

/** The kind of value entry an element accepts. */
export function editKind(this: Element): string {
  const element = this as HTMLInputElement;
  if (element.localName === "select") return "select";
  if (element.localName === "textarea") return "text";
  if (element.localName === "input") {
    if (["date", "datetime-local", "month", "time", "week", "color", "range"].includes(element.type)) return "value";
    if (element.type === "file") return "file";
    if (["checkbox", "radio", "submit", "button", "reset", "image"].includes(element.type)) return "none";
    return "text";
  }
  return (element as HTMLElement).isContentEditable ? "text" : "none";
}

/**
 * Set a value the way a picker would (date, color, range): assign and fire input + change. A value
 * the input rejects (the browser sanitizes it to something else) leaves the old value in place.
 */
export function assignValue(this: Element, value: string): { ok: boolean; value: string } {
  const element = this as HTMLInputElement;
  const previous = element.value;
  element.focus();
  element.value = value;
  if (element.value !== value) {
    element.value = previous;
    return { ok: false, value: previous };
  }
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value };
}

/** Choose options of a <select> by value, then exact label, then case-insensitive substring. */
export function chooseOptions(this: Element, wanted: string[]): { ok: boolean; selected: string[]; available: string[] } {
  const select = this as HTMLSelectElement;
  const options = Array.from(select.options);
  const available = options.map((option) => option.label || option.text).slice(0, 30);
  const picks: HTMLOptionElement[] = [];
  for (const raw of wanted) {
    const want = raw.trim().toLowerCase();
    const match = options.find((option) => option.value === raw)
      ?? options.find((option) => (option.label || option.text).trim().toLowerCase() === want)
      ?? options.find((option) => (option.label || option.text).toLowerCase().includes(want));
    if (!match || match.disabled) return { ok: false, selected: [], available };
    picks.push(match);
  }
  if (!select.multiple && picks.length > 1) return { ok: false, selected: [], available };
  select.focus();
  for (const option of options) option.selected = picks.includes(option);
  select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, selected: picks.map((option) => option.label || option.text), available };
}

/** Whether the frame's visible text contains `text` (case-insensitive). */
export function frameHasText(text: string): boolean {
  return (document.body?.innerText ?? "").toLowerCase().includes(text.toLowerCase());
}

/** All of the frame's visible text, for extraction. */
export function frameText(maxChars: number): string {
  const text = (document.body?.innerText ?? "").replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
}

/** Scroll the document itself; false when it cannot move that way (an app shell scrolls an inner element). */
export function scrollDocument(dx: number, dy: number): boolean {
  const before = [window.scrollX, window.scrollY];
  window.scrollBy({ left: dx, top: dy, behavior: "instant" as ScrollBehavior });
  return window.scrollX !== before[0] || window.scrollY !== before[1];
}

/**
 * What the browser's CAPTCHA guardian (llm-captcha) published for this document on
 * `<html data-captcha-state data-captcha-detail>`. Null when it never saw a challenge or is idle.
 */
export function captchaState(): { state: "solving" | "solved" | "failed"; detail: string } | null {
  const state = document.documentElement.dataset.captchaState;
  const detail = document.documentElement.dataset.captchaDetail ?? "";
  return state === "solving" || state === "solved" || state === "failed" ? { state, detail } : null;
}

/** Scroll position and size of the frame's document. */
export function scrollState(): { scrollY: number; scrollHeight: number; viewportHeight: number } {
  return { scrollY: Math.round(window.scrollY), scrollHeight: Math.round(document.documentElement.scrollHeight), viewportHeight: Math.round(window.innerHeight) };
}

/** Serialize a page function into an expression calling it with JSON arguments. */
export function callExpression(fn: (...args: never[]) => unknown, ...args: unknown[]): string {
  return `(${fn.toString()})(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;
}
