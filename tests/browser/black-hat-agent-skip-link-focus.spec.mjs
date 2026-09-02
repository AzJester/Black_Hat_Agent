import { test, expect } from "@playwright/test";

const APP_PATH = "./";
const MIN_NON_TEXT_CONTRAST = 3;

function parseRgb(color) {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  expect(match, `${color} is an rgb() colour`).not.toBeNull();
  return match.slice(1, 4).map(channel => Number(channel) / 255);
}

function relativeLuminance(color) {
  const [r, g, b] = parseRgb(color).map(channel =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground, background) {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

// The skip link is the very first Tab stop and is painted on top of the ink
// sidebar (desktop) or the ink mobile header (narrow viewports). Its ring must
// therefore be measured against the pill it sits in, not the surface behind it.
for (const [label, viewport] of [
  ["desktop", { width: 1280, height: 800 }],
  ["mobile", { width: 390, height: 800 }],
]) {
  test(`the first Tab stop (${label}) shows a skip-link focus ring that clears 3:1 against its own pill`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    const response = await page.goto(APP_PATH, { waitUntil: "load" });
    expect(response?.status()).toBe(200);
    await page.locator("a.skip-link").waitFor({ state: "attached" });

    await page.keyboard.press("Tab");

    const probe = await page.evaluate(() => {
      const el = document.activeElement;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const width = parseFloat(style.outlineWidth);
      const offset = parseFloat(style.outlineOffset);
      // Centre of the ring band along the pill's left edge: |offset| inward
      // from the edge, then half the ring width further in.
      const bandCentreX = rect.left - offset - width / 2;
      const bandCentreY = rect.top + rect.height / 2;
      const underBand = document.elementFromPoint(bandCentreX, bandCentreY);
      // Just outside the pill: what the old, outward ring used to land on.
      const outside = document.elementFromPoint(rect.left - 4, bandCentreY);
      const describe = node =>
        node
          ? `${node.tagName.toLowerCase()}${node.className && typeof node.className === "string" ? "." + node.className.split(" ").join(".") : ""}`
          : "none";
      return {
        activeClass: el.className,
        matchesFocusVisible: el.matches(":focus-visible"),
        outlineStyle: style.outlineStyle,
        outlineColor: style.outlineColor,
        outlineWidth: width,
        outlineOffset: offset,
        pillBackground: style.backgroundColor,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        underBand: describe(underBand),
        underBandIsSkipLink: underBand === el,
        outside: describe(outside),
        outsideBackground: outside ? getComputedStyle(outside).backgroundColor : "none",
      };
    });

    expect(pageErrors).toEqual([]);
    expect(probe.activeClass).toBe("skip-link");
    expect(probe.matchesFocusVisible).toBe(true);
    expect(probe.rect.top).toBeGreaterThanOrEqual(0);
    expect(probe.outlineStyle).toBe("solid");
    expect(probe.outlineWidth).toBeGreaterThanOrEqual(2);

    // The ring sits entirely inside the pill.
    expect(probe.outlineOffset).toBeLessThanOrEqual(-probe.outlineWidth);
    expect(probe.underBandIsSkipLink, `ring band is over ${probe.underBand}`).toBe(true);

    // Measured against the pill it is drawn on, the ring clears WCAG 1.4.11.
    const ringVsPill = contrastRatio(probe.outlineColor, probe.pillBackground);
    expect(
      ringVsPill,
      `${probe.outlineColor} on ${probe.pillBackground} is ${ringVsPill.toFixed(2)}:1`
    ).toBeGreaterThanOrEqual(MIN_NON_TEXT_CONTRAST);

    // And the pill itself is still an obvious change against the dark surface
    // behind it, which is what an outward ring would have had to fight.
    expect(probe.outside).toMatch(/sidebar|mobile-header/);
    const pillVsSurface = contrastRatio(probe.pillBackground, probe.outsideBackground);
    expect(pillVsSurface).toBeGreaterThanOrEqual(MIN_NON_TEXT_CONTRAST);
  });
}
