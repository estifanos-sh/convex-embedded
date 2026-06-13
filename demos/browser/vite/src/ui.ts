type Child = Node | string | number | false | null | undefined;

type AttrPrimitive = string | number | boolean | null | undefined;
type AttrEventHandler = (event: Event) => void;
type AttrValue = AttrPrimitive | AttrEventHandler | Record<string, string>;

type Attrs = {
  class?: string;
  className?: string;
  style?: string;
  dataset?: Record<string, string>;
  [key: string]: AttrValue | undefined;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) applyAttrs(el, attrs);
  appendChildren(el, children.flat());
  return el;
}

export function svg(
  tag: string,
  attrs?: Record<string, string>,
  ...children: (Child | Child[])[]
): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag) as SVGElement;
  if (attrs) for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  appendChildren(el, children.flat());
  return el;
}

function applyAttrs(el: HTMLElement, attrs: Attrs): void {
  for (const [key, raw] of Object.entries(attrs)) {
    if (raw == null || raw === false) continue;
    if (key === "dataset") {
      Object.assign(el.dataset, raw as Record<string, string>);
    } else if (key.startsWith("on") && typeof raw === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), raw as AttrEventHandler);
    } else if (typeof raw === "string" || typeof raw === "number") {
      const value = String(raw);
      if (key === "class" || key === "className") el.className = value;
      else el.setAttribute(key, value);
    } else if (raw === true) {
      el.setAttribute(key, "");
    }
  }
}

function appendChildren(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child == null || child === false) continue;
    el.append(typeof child === "string" || typeof child === "number" ? String(child) : child);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}
