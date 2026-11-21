import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/* Every style, in light and dark, keeps WCAG 2.1 AA on the pairs that matter. The values are read from the
   stylesheet itself (the serene:root block and each:root[data-palette] block), resolving var and
   light-dark, so a token changed in app.css is checked here without copying it. */
const css = readFileSync(new URL("../src/styles/app.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(opening: string): Record<string, string> {
  const start = css.indexOf(opening);
  if (start < 0) throw new Error(`block not found: ${opening}`);
  let depth = 0, i = css.indexOf("{", start);
  const from = i + 1;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) break;
  }
  const decls: Record<string, string> = {};
  for (const m of css.slice(from, i).matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) decls[m[1]] = m[2].trim();
  return decls;
}

const sereneLight = block(":root {\n  color-scheme: light;");
const PALETTES = { sereno: {}, calido: block(':root[data-palette="calido"] {'), extravagante: block(':root[data-palette="extravagante"] {') };

/** The top-level arguments of a function call that starts at `open` (the index of its parenthesis). */
function args(s: string, open: number): { list: string[]; end: number } {
  const list: string[] = [];
  let depth = 0, last = open + 1;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) { list.push(s.slice(last, i).trim()); return { list, end: i }; }
    else if (s[i] === "," && depth === 1) { list.push(s.slice(last, i).trim()); last = i + 1; }
  }
  throw new Error(`unbalanced: ${s}`);
}

function resolve(value: string, tokens: Record<string, string>, dark: boolean, depth = 0): string {
  if (depth > 20) throw new Error(`cycle at ${value}`);
  let v = value;
  for (let at = v.indexOf("var("); at >= 0; at = v.indexOf("var(")) {
    const { list, end } = args(v, at + 3);
    const name = list[0].replace(/^--/, "");
    const inner = tokens[name] ?? list[1];
    if (inner == null) throw new Error(`unknown token --${name}`);
    v = v.slice(0, at) + resolve(inner, tokens, dark, depth + 1) + v.slice(end + 1);
  }
  for (let at = v.indexOf("light-dark("); at >= 0; at = v.indexOf("light-dark(")) {
    const { list, end } = args(v, at + 10);
    v = v.slice(0, at) + (dark ? list[1] : list[0]) + v.slice(end + 1);
  }
  return v.trim();
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not an opaque colour: ${hex}`);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** [foreground, background, minimum]: 4.5 for text, 3 for focus rings, field borders and other indicators. */
const PAIRS: [string, string, number][] = [
  ...["bg", "sheet", "surface", "surface-2"].map((bg) => ["color-text", `color-${bg}`, 4.5] as [string, string, number]),
  ["color-text-secondary", "color-sheet", 4.5], ["color-text-secondary", "color-bg", 4.5],
  ["color-text-muted", "color-bg", 4.5], ["color-text-muted", "color-sheet", 4.5], ["color-text-muted", "color-surface-2", 4.5],
  ["color-accent", "color-bg", 4.5], ["color-accent", "color-sheet", 4.5], ["color-accent", "color-accent-soft", 4.5],
  ["color-on-accent", "color-accent-fill", 4.5], ["color-on-accent", "color-accent-fill-hover", 4.5],
  ...(["green", "amber", "red"] as const).flatMap((l) => [
    [`color-status-${l}`, "color-sheet", 4.5], [`color-status-${l}`, "color-bg", 4.5], [`color-status-${l}`, `color-status-${l}-bg`, 4.5],
  ] as [string, string, number][]),
  ["color-on-dark", "color-chrome", 4.5], ["color-on-dark", "color-chrome-raised", 4.5], ["color-on-dark-muted", "color-chrome", 4.5],
  ["color-focus", "color-bg", 3], ["color-focus", "color-sheet", 3], ["color-focus", "color-surface", 3],
  ["color-focus-on-dark", "color-chrome", 3], ["color-field-border", "color-sheet", 3], ["chart-band-edge", "color-sheet", 3],
];
/** The eccentric style: ink text on every toy fill, and its ink borders against the ground. */
const FUN_PAIRS: [string, string, number][] = [
  ...["fun-ball", "fun-gum", "fun-pool", "fun-lilac"].map((f) => ["fun-on", f, 4.5] as [string, string, number]),
  ["fun-ink", "color-bg", 3], ["fun-ink", "color-sheet", 3],
];

describe("styles keep WCAG AA in light and dark", () => {
  for (const [name, palette] of Object.entries(PALETTES)) {
    for (const dark of [false, true]) {
      it(`${name}, ${dark ? "oscuro" : "claro"}`, () => {
        const tokens = { ...sereneLight, ...palette };
        const pairs = name === "extravagante" ? [...PAIRS, ...FUN_PAIRS] : PAIRS;
        const failures = pairs.flatMap(([fg, bg, min]) => {
          const ratio = contrast(resolve(`var(--${fg})`, tokens, dark), resolve(`var(--${bg})`, tokens, dark));
          return ratio >= min ? [] : [`${fg} on ${bg}: ${ratio.toFixed(2)} < ${min}`];
        });
        expect(failures).toEqual([]);
      });
    }
  }

  it("reads the style blocks and catches a failing pair", () => {
    expect(Object.keys(PALETTES.calido).length).toBeGreaterThan(40);
    expect(Object.keys(PALETTES.extravagante).length).toBeGreaterThan(40);
    // White text on the tennis ball would fail: that is why the eccentric style puts ink on its toy fills.
    const fun = { ...sereneLight, ...PALETTES.extravagante };
    expect(contrast("#ffffff", resolve("var(--fun-ball)", fun, false))).toBeLessThan(1.5);
    expect(resolve("var(--color-divider-strong)", { ...sereneLight, ...PALETTES.extravagante }, true)).toBe("#fff1d0");
  });

  it("never restyles the levels, the focus ring, the normal band or the figures", () => {
    for (const palette of [PALETTES.calido, PALETTES.extravagante]) {
      for (const token of Object.keys(palette)) {
        expect(token).not.toMatch(/^(color-status-|color-focus$|chart-baseline|chart-band-edge|font-figure|color-danger-fill|color-success-fill)/);
      }
    }
  });
});
