import { test, expect } from "@playwright/test";

// Regression checks derived from the independent audit (docs/AUDIT.md): the
// application must make no third-party requests, and hostile text stored in the
// workspace must render as escaped data rather than live markup.

const APP = "./";
const STORAGE_KEY = "black_hat_agent_public_v2";
const VIEWS = [
  "portfolio", "command", "opportunity", "criteria", "evidence", "competitors",
  "imports", "playbooks", "session", "history", "outputs", "actions", "recovery", "guide"
];
const PAYLOAD =
  '<img src=x onerror="window.__xss&&window.__xss(\'img\')">' +
  '<svg onload="window.__xss&&window.__xss(\'svg\')"></svg>' +
  '<a href="javascript:window.__xss&&window.__xss(\'jsurl\')">x</a>' +
  '<script>window.__xss&&window.__xss(\'inline\')<\/script>';

test("loads without third-party requests, page errors, or console errors", async ({ page }) => {
  const consoleErrors = [];
  const pageErrors = [];
  const requests = [];
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", error => pageErrors.push(String(error)));
  page.on("request", request => requests.push(request.url()));

  await page.goto(APP, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  const origin = new URL(page.url()).origin;
  const thirdParty = requests.filter(
    url => !url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:")
  );
  expect(thirdParty, "every request stays on the application origin").toEqual([]);
  expect(pageErrors, "no uncaught page errors").toEqual([]);
  expect(consoleErrors, "no console errors").toEqual([]);
});

test("hostile workspace text renders as escaped data in every view and a generated report", async ({ page, context }) => {
  const xssHits = [];
  await page.exposeFunction("__xss", tag => xssHits.push(tag));
  await page.addInitScript(() => { window.alert = () => window.__xss && window.__xss("alert"); });
  page.on("dialog", dialog => dialog.accept().catch(() => {})); // accept the native reset confirm()
  context.on("page", popup => { popup.close().catch(() => {}); }); // close any print/export popup

  // The seed workspace lives in memory until a save; "Reset demo" persists it.
  await page.goto(APP, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(300);
  await page.locator('[data-action="reset-demo"]').first().click();
  await page.waitForTimeout(400);

  const stored = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  expect(stored, "the demo workspace was persisted").not.toBeNull();

  // Inject the payload into every free-text string in the persisted workspace,
  // leaving identifiers, dates, and enumerations intact so validation still passes.
  const injected = await page.evaluate(({ key, payload }) => {
    const data = JSON.parse(localStorage.getItem(key));
    const protectedKeys = new Set([
      "id", "createdAt", "updatedAt", "stage", "status", "confidence", "stance", "type", "posture", "priority"
    ]);
    let count = 0;
    const walk = value => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== "object") return;
      for (const field of Object.keys(value)) {
        const current = value[field];
        if (typeof current === "string" && current.length > 3 && !protectedKeys.has(field) && !/^(E-|C-|P-)/.test(field)) {
          value[field] = `${payload} ${current.slice(0, 20)}`;
          count += 1;
        } else {
          walk(current);
        }
      }
    };
    walk(data);
    localStorage.setItem(key, JSON.stringify(data));
    return count;
  }, { key: STORAGE_KEY, payload: PAYLOAD });
  expect(injected, "the payload reached workspace fields").toBeGreaterThan(0);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(400);

  for (const view of VIEWS) {
    await page.evaluate(hash => { location.hash = `#${hash}`; }, view);
    await page.waitForTimeout(120);
  }

  // Generate an in-page report (export/print buttons open windows and are skipped).
  await page.evaluate(() => { location.hash = "#session"; });
  await page.waitForTimeout(200);
  for (const label of [/run.*analysis/i, /generate report/i, /run black hat/i, /start.*session/i]) {
    const button = page.getByRole("button", { name: label }).first();
    try {
      if (await button.count()) {
        await button.click({ timeout: 800 });
        await page.waitForTimeout(250);
      }
    } catch {
      // A label that does not exist in this state is not a failure.
    }
  }
  await page.evaluate(() => { location.hash = "#outputs"; });
  await page.waitForTimeout(400);

  const rendered = await page.evaluate(() => ({
    liveImages: document.querySelectorAll('img[src="x"]').length,
    liveSvgHandlers: document.querySelectorAll("svg[onload]").length,
    javascriptHrefs: [...document.querySelectorAll("a")].filter(anchor =>
      (anchor.getAttribute("href") || "").toLowerCase().startsWith("javascript:")
    ).length,
    escapedTextPresent: document.body.textContent.includes("<img src=x onerror")
  }));

  expect(rendered.escapedTextPresent, "the payload is visible only as escaped text").toBe(true);
  expect(xssHits, "no injected script or handler executed").toEqual([]);
  expect(rendered.liveImages, "no live injected <img>").toBe(0);
  expect(rendered.liveSvgHandlers, "no live injected SVG handler").toBe(0);
  expect(rendered.javascriptHrefs, "no live javascript: link").toBe(0);
});
