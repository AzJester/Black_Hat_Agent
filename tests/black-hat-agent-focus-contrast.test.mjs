import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, "..");
const styles = readFileSync(resolve(rootDir, "styles.css"), "utf8");

const MIN_NON_TEXT_CONTRAST = 3;

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function parseCustomProperties(css) {
  const rootBlock = css.match(/:root\s*\{([^}]*)\}/s);
  assert.ok(rootBlock, "styles.css declares :root custom properties");
  const tokens = {};
  for (const declaration of rootBlock[1].split(";")) {
    const [name, ...rest] = declaration.split(":");
    if (name && name.trim().startsWith("--")) {
      tokens[name.trim()] = rest.join(":").trim();
    }
  }
  return tokens;
}

function resolveVar(value, tokens) {
  let resolved = value.trim();
  for (let depth = 0; depth < 8 && /var\(/.test(resolved); depth += 1) {
    resolved = resolved.replace(/var\((--[\w-]+)\)/g, (match, name) => {
      assert.ok(name in tokens, `custom property ${name} is defined on :root`);
      return tokens[name];
    });
  }
  assert.doesNotMatch(resolved, /var\(/, `custom property chain resolves: ${value}`);
  return resolved;
}

function hexToRgb(hex) {
  const normalized = hex.trim().toLowerCase();
  const short = normalized.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  const long = normalized.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  const parts = short ? short.slice(1).map((c) => c + c) : long?.slice(1);
  assert.ok(parts, `${hex} is a hex colour`);
  return parts.map((channel) => parseInt(channel, 16) / 255);
}

function channelLuminance(channel) {
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(channelLuminance);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

function findRule(css, selectorPattern) {
  const rule = css.match(new RegExp(`${selectorPattern.source}\\s*\\{([^}]*)\\}`, "s"));
  assert.ok(rule, `styles.css contains a rule matching ${selectorPattern}`);
  return rule[1];
}

function outlineColor(declarations) {
  const shorthand = declarations.match(/(?:^|;)\s*outline\s*:\s*[^;]*?(var\(--[\w-]+\)|#[0-9a-fA-F]{3,6})/s);
  const longhand = declarations.match(/(?:^|;)\s*outline-color\s*:\s*([^;]+)/s);
  const raw = longhand?.[1] ?? shorthand?.[1];
  assert.ok(raw, `rule declares an outline colour: ${declarations.trim()}`);
  return raw.trim();
}

const css = stripComments(styles);
const tokens = parseCustomProperties(css);
const white = "#ffffff";
const paper = resolveVar("var(--paper)", tokens);
const panel = resolveVar("var(--panel)", tokens);
const ink = resolveVar("var(--ink)", tokens);

test("the contrast helpers reproduce the WCAG reference values", () => {
  assert.equal(contrastRatio("#000", "#fff").toFixed(2), "21.00");
  assert.equal(contrastRatio("#fff", "#fff").toFixed(2), "1.00");
  assert.equal(contrastRatio("#29aae1", "#ffffff").toFixed(2), "2.65");
  assert.equal(contrastRatio("#29aae1", "#f5f6f8").toFixed(2), "2.45");
});

test("the palette tokens used by the focus rules resolve to hex colours", () => {
  assert.equal(paper, "#f5f6f8");
  assert.equal(panel, "#fff");
  assert.equal(ink, "#171327");
});

test("the global focus-visible ring clears 3:1 on both light surfaces", () => {
  const globalRule = findRule(
    css,
    /:where\(a,button,input,select,textarea[^{]*\):focus-visible/
  );
  assert.match(globalRule, /outline-offset\s*:\s*3px/);
  const ring = resolveVar(outlineColor(globalRule), tokens);
  const againstWhite = contrastRatio(ring, white);
  const againstPaper = contrastRatio(ring, paper);
  assert.ok(
    againstWhite >= MIN_NON_TEXT_CONTRAST,
    `focus ring ${ring} is ${againstWhite.toFixed(2)}:1 against ${white}; needs ${MIN_NON_TEXT_CONTRAST}:1`
  );
  assert.ok(
    againstPaper >= MIN_NON_TEXT_CONTRAST,
    `focus ring ${ring} is ${againstPaper.toFixed(2)}:1 against ${paper}; needs ${MIN_NON_TEXT_CONTRAST}:1`
  );
});

test("the sidebar navigation focus ring clears 3:1 against the dark sidebar", () => {
  const navRule = findRule(css, /\.nav button:focus-visible(?:,\.nav a:focus-visible)?/);
  const ring = resolveVar(outlineColor(navRule), tokens);
  const againstInk = contrastRatio(ring, ink);
  assert.ok(
    againstInk >= MIN_NON_TEXT_CONTRAST,
    `sidebar focus ring ${ring} is ${againstInk.toFixed(2)}:1 against ${ink}; needs ${MIN_NON_TEXT_CONTRAST}:1`
  );
});

test("every focusable control on a dark surface keeps a ring that clears 3:1 against ink", () => {
  const darkRule = findRule(css, /\.sidebar :focus-visible,\.mobile-header :focus-visible/);
  const ring = resolveVar(outlineColor(darkRule), tokens);
  const againstInk = contrastRatio(ring, ink);
  assert.ok(
    againstInk >= MIN_NON_TEXT_CONTRAST,
    `dark-surface focus ring ${ring} is ${againstInk.toFixed(2)}:1 against ${ink}; needs ${MIN_NON_TEXT_CONTRAST}:1`
  );
});

function cssLength(declarations, property) {
  const match = declarations.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(-?[\\d.]+)px`, "s"));
  assert.ok(match, `rule declares ${property} in px: ${declarations.trim()}`);
  return Number(match[1]);
}

test("the skip link paints its focus ring inside its own white pill, not on the dark surface behind it", () => {
  const skipLink = findRule(css, /\.skip-link(?=\s*\{)/);
  const background = skipLink.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/s);
  assert.ok(background, "the skip link declares its own background");
  const pillBackground = resolveVar(background[1], tokens);
  assert.equal(pillBackground, "#fff", "the skip link pill has a white background");

  const globalRule = findRule(css, /:where\(a,button,input,select,textarea[^{]*\):focus-visible/);
  const skipRule = findRule(css, /\.skip-link:focus-visible/);
  const ring = resolveVar(outlineColor(/outline(?:-color)?\s*:/.test(skipRule) ? skipRule : globalRule), tokens);
  const width = cssLength(/outline-width\s*:/.test(skipRule) ? skipRule : globalRule, "outline(?:-width)?");
  const offset = cssLength(skipRule, "outline-offset");

  // The pill is a sibling of `.app` painted over the ink sidebar / mobile
  // header. Either the ring sits fully inside the pill (offset at least one
  // ring width inward) and is measured against the pill, or it is drawn
  // outward and must clear 3:1 against the ink surface it lands on.
  const inset = offset <= -width;
  const surface = inset ? pillBackground : ink;
  const ratio = contrastRatio(ring, surface);
  assert.ok(
    ratio >= MIN_NON_TEXT_CONTRAST,
    `skip link ring ${ring} (offset ${offset}px) is ${ratio.toFixed(2)}:1 against ${inset ? "its pill" : "the ink surface behind it"} ${surface}; needs ${MIN_NON_TEXT_CONTRAST}:1`
  );
});

test("no focus-visible rule paints a ring below 3:1 on its surface", () => {
  const rules = [...css.matchAll(/([^{}]*:focus-visible[^{]*)\{([^}]*)\}/gs)];
  assert.ok(rules.length >= 3, "styles.css defines the global, sidebar, and dark-surface focus rules");
  for (const [, selector, declarations] of rules) {
    if (!/outline(?:-color)?\s*:/.test(declarations)) continue;
    const ring = resolveVar(outlineColor(declarations), tokens);
    const onDarkSurface = /\.nav |\.sidebar |\.mobile-header /.test(selector);
    const surfaces = onDarkSurface ? [ink] : [white, paper];
    for (const surface of surfaces) {
      const ratio = contrastRatio(ring, surface);
      assert.ok(
        ratio >= MIN_NON_TEXT_CONTRAST,
        `${selector.trim()} paints ${ring} at ${ratio.toFixed(2)}:1 against ${surface}`
      );
    }
  }
});
