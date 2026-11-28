// Readable main text of a page as Markdown (SPEC §9.3 `agb text`).
//
// `extractReadableText` runs inside the page, in an isolated JavaScript world (the page's scripts can't patch the
// built-ins it uses). It is serialized with Function.prototype.toString, so it must be self-contained: no imports,
// no references to anything outside its own body.
//
// Text that people can't see is left out and counted (SPEC §10.1, prompt-injection defense): display:none,
// visibility:hidden, opacity 0, aria-hidden, zero-size or clipped boxes, tiny fonts, text positioned off the page,
// and text the same color as its background.

export interface ReadableText {
  text: string;
  hiddenOmitted: number;
}

export function extractReadableText(): ReadableText {
  type WalkCtx = { pre: boolean; depth: number; list?: { n: number; ordered: boolean } };

  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "SVG", "CANVAS", "IFRAME", "FRAME", "OBJECT",
    "EMBED", "VIDEO", "AUDIO", "MAP", "INPUT", "TEXTAREA", "SELECT", "BUTTON", "OPTION", "DATALIST", "DIALOG",
  ]);
  const CHROME_TAGS = new Set(["NAV", "ASIDE", "FOOTER"]);
  const CHROME_ROLES = new Set(["navigation", "complementary", "contentinfo", "banner", "search", "menu", "menubar", "dialog", "alertdialog"]);
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FORM",
    "HEADER", "LI", "MAIN", "P", "SECTION", "SUMMARY",
  ]);
  const PARAGRAPH_TAGS = new Set(["P", "SECTION", "ARTICLE", "FIGURE", "DETAILS", "DL"]);

  let hiddenOmitted = 0;
  const lines: string[] = [];
  let current = "";
  let quote = ""; // "> " prefixes inside blockquotes

  const docWidth = Math.max(document.documentElement.scrollWidth, window.innerWidth);
  const docHeight = Math.max(document.documentElement.scrollHeight, window.innerHeight);

  const flush = () => {
    const t = current.replace(/[ \t]+/g, " ").replace(/\s+$/, "");
    if (t.trim()) lines.push(quote + t);
    current = "";
  };
  const blankLine = () => {
    flush();
    if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  };
  const space = () => {
    if (current && !/\s$/.test(current)) current += " ";
  };

  const parseColor = (c: string): number[] | null => {
    const m = /rgba?\(([^)]+)\)/.exec(c);
    if (!m) return null;
    const p = m[1]!.split(/[\s,/]+/).filter(Boolean).map(Number);
    return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0, p[3] ?? 1];
  };

  const bgCache = new Map<Element, number[] | null>();
  const backgroundOf = (el: Element | null): number[] | null => {
    if (!el) return null;
    const cached = bgCache.get(el);
    if (cached !== undefined) return cached;
    const own = parseColor(getComputedStyle(el).backgroundColor);
    const bg = own && own[3]! > 0.5 ? own : backgroundOf(el.parentElement);
    bgCache.set(el, bg);
    return bg;
  };

  /** Text directly in this element that people can't read: tiny, transparent, or the background's color. */
  const unreadableCache = new Map<Element, boolean>();
  const isUnreadable = (el: Element): boolean => {
    const cached = unreadableCache.get(el);
    if (cached !== undefined) return cached;
    const style = getComputedStyle(el);
    const fg = parseColor(style.color);
    const bg = backgroundOf(el);
    const result =
      parseFloat(style.fontSize) < 4 ||
      (fg !== null && fg[3]! < 0.1) ||
      (fg !== null && bg !== null && Math.abs(fg[0]! - bg[0]!) + Math.abs(fg[1]! - bg[1]!) + Math.abs(fg[2]! - bg[2]!) < 12);
    unreadableCache.set(el, result);
    return result;
  };

  /** Hidden from people: the element and everything in it is skipped. */
  const isHidden = (el: Element, style: CSSStyleDeclaration): boolean => {
    if (el.getAttribute("aria-hidden") === "true" || (el as HTMLElement).hidden) return true;
    if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return true;
    if (parseFloat(style.opacity) === 0) return true;
    if (style.display === "contents") return false;
    // Covers what computed styles don't: the body of a closed <details>, content-visibility: hidden.
    if (typeof (el as HTMLElement).checkVisibility === "function" && !(el as HTMLElement).checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return true;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0 && style.overflow !== "visible") return true;
    if ((rect.width <= 1 || rect.height <= 1) && style.overflow === "hidden") return true; // "visually hidden" helpers
    if (style.clipPath === "inset(50%)" || /rect\(0(px)?,? 0(px)?,? 0(px)?,? 0(px)?\)/.test(style.clip)) return true;
    const right = rect.right + window.scrollX;
    const bottom = rect.bottom + window.scrollY;
    const left = rect.left + window.scrollX;
    const top = rect.top + window.scrollY;
    return right < 0 || bottom < 0 || left > docWidth + 100 || top > docHeight + 100;
  };

  /** Site navigation, sidebars, footers, and the page header: not part of the main text. */
  const isChrome = (el: Element, root: Element): boolean => {
    if (el === root) return false;
    const role = el.getAttribute("role");
    if (role && CHROME_ROLES.has(role)) return true;
    if (CHROME_TAGS.has(el.tagName)) return true;
    return el.tagName === "HEADER" && !el.closest("article, main, [role=main]");
  };

  const plain = (el: Element): string => ((el as HTMLElement).innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim();

  const childrenOf = (node: Node): Node[] => {
    const el = node as Element;
    if (el.shadowRoot) return Array.from(el.shadowRoot.childNodes);
    if (el.tagName === "SLOT") {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return Array.from(node.childNodes);
  };
  const walkChildren = (node: Node, root: Element, ctx: WalkCtx) => {
    for (const child of childrenOf(node)) walk(child, root, ctx);
  };

  const walk = (node: Node, root: Element, ctx: WalkCtx): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const raw = node.nodeValue ?? "";
      if (!raw.trim()) {
        if (ctx.pre) current += raw;
        else space();
        return;
      }
      const parent = node.parentElement;
      if (parent && isUnreadable(parent)) {
        hiddenOmitted++;
        return;
      }
      current += ctx.pre ? raw : raw.replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
    const style = getComputedStyle(el);
    if (isHidden(el, style)) {
      if (el.textContent?.trim()) hiddenOmitted++;
      return;
    }
    if (isChrome(el, root)) return;

    switch (tag) {
      case "BR":
        flush();
        return;
      case "HR":
        blankLine();
        lines.push("---");
        blankLine();
        return;
      case "IMG": {
        const alt = (el.getAttribute("alt") ?? "").trim();
        if (alt) {
          space();
          current += `[image: ${alt}]`;
        }
        return;
      }
      case "H1":
      case "H2":
      case "H3":
      case "H4":
      case "H5":
      case "H6":
        blankLine();
        current = "#".repeat(Number(tag[1])) + " ";
        walkChildren(el, root, ctx);
        blankLine();
        return;
      case "A": {
        const before = current;
        current = "";
        walkChildren(el, root, ctx);
        const label = current.replace(/\s+/g, " ").trim();
        current = before;
        if (!label) return;
        const href = (el as HTMLAnchorElement).href;
        const target = /^https?:/i.test(href) ? href : null;
        if (current && !/[\s([]$/.test(current)) current += " ";
        current += target && target !== label ? `[${label}](${target})` : label;
        return;
      }
      case "CODE":
        if (!ctx.pre) {
          const t = plain(el);
          if (t) current += "`" + t + "`";
          return;
        }
        break;
      case "PRE": {
        blankLine();
        lines.push(quote + "```");
        for (const l of (el.textContent ?? "").replace(/\s+$/, "").split("\n")) lines.push(quote + l);
        lines.push(quote + "```");
        blankLine();
        return;
      }
      case "BLOCKQUOTE": {
        blankLine();
        const outer = quote;
        quote += "> ";
        walkChildren(el, root, ctx);
        flush();
        quote = outer;
        blankLine();
        return;
      }
      case "UL":
      case "OL":
        if (ctx.depth === 0) blankLine();
        else flush();
        walkChildren(el, root, { ...ctx, depth: ctx.depth + 1, list: { n: 0, ordered: tag === "OL" } });
        flush();
        if (ctx.depth === 0) blankLine();
        return;
      case "LI": {
        flush();
        const list = ctx.list;
        current = "  ".repeat(Math.max(0, ctx.depth - 1)) + (list?.ordered ? `${++list.n}. ` : "- ");
        walkChildren(el, root, { ...ctx, list: undefined });
        flush();
        return;
      }
      case "TABLE": {
        blankLine();
        const rows = Array.from((el as HTMLTableElement).rows).filter((r) => !isHidden(r, getComputedStyle(r)));
        rows.forEach((r, i) => {
          const cells = Array.from(r.cells).map((c) => plain(c).replace(/\|/g, "\\|"));
          lines.push(quote + "| " + cells.join(" | ") + " |");
          if (i === 0) lines.push(quote + "|" + cells.map(() => " --- |").join(""));
        });
        blankLine();
        return;
      }
    }

    const d = style.display;
    const block = BLOCK_TAGS.has(tag) || d === "block" || d === "flex" || d === "grid" || d === "list-item" || d === "table";
    if (block) flush();
    walkChildren(el, root, ctx);
    if (block) {
      if (PARAGRAPH_TAGS.has(tag)) blankLine();
      else flush();
    }
  };

  // The main content: <main> / role=main, else a single <article>, else the body.
  const article = document.querySelectorAll("article").length === 1 ? document.querySelector("article") : null;
  let root: Element | null = null;
  for (const c of [document.querySelector("main, [role=main]"), article]) {
    if (c && plain(c).length >= 200) {
      root = c;
      break;
    }
  }
  root ??= document.body ?? document.documentElement;
  if (root) walk(root, root, { pre: false, depth: 0 });
  flush();

  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, hiddenOmitted };
}
