import { test, expect } from "@playwright/test";
import { APP_PATH, STORAGE_KEY, loadDemoWorkspace } from "./helpers.mjs";

// These specs exercise pursuit-scoped views, so a fresh page is the on-demand
// demonstration workspace opened on the requested view.
async function freshPage(page, hash = "") {
  await loadDemoWorkspace(page, { hash });
}

async function caretState(locator) {
  return locator.evaluate(input => ({
    value: input.value,
    start: input.selectionStart,
    end: input.selectionEnd
  }));
}

async function typeMidString(page, input) {
  await input.click();
  await input.pressSequentially("abc");
  expect(await caretState(input)).toEqual({ value: "abc", start: 3, end: 3 });
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  expect(await caretState(input)).toEqual({ value: "abc", start: 1, end: 1 });
  await input.pressSequentially("XY");
}

test("F7: the portfolio search keeps the caret where the user is editing across re-renders", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await freshPage(page);
  const search = page.locator("#search");
  await typeMidString(page, search);
  await expect(search).toBeFocused();
  expect(await caretState(page.locator("#search"))).toEqual({ value: "aXYbc", start: 3, end: 3 });
  await page.keyboard.press("Backspace");
  expect(await caretState(page.locator("#search"))).toEqual({ value: "aXbc", start: 2, end: 2 });
  expect(pageErrors).toEqual([]);
});

test("F7: list filters keep the caret mid-string while the collection re-renders", async ({ page }) => {
  await freshPage(page, "#criteria");
  const filter = page.locator('[data-list-filter="criteria"]');
  await expect(filter).toBeVisible();
  await typeMidString(page, filter);
  await expect(page.locator('[data-list-filter="criteria"]')).toBeFocused();
  expect(await caretState(page.locator('[data-list-filter="criteria"]'))).toEqual({
    value: "aXYbc",
    start: 3,
    end: 3
  });
});

test("F8: a clean tab adopts a workspace saved in another tab without a manual reload", async ({
  context,
  page
}) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await freshPage(page, "#command");
  await expect(page.locator(".active-context strong")).toHaveText("Joint Multi-Domain T&E Support");

  const other = await context.newPage();
  await other.goto(APP_PATH, { waitUntil: "domcontentloaded" });
  await other.getByRole("button", { name: "Open workspace" }).first().click();
  await expect(other).toHaveURL(/#command$/);
  const renamed = await other.evaluate(key => {
    const workspace = JSON.parse(localStorage.getItem(key));
    const active = workspace.pursuits.find(item => item.id === workspace.active);
    active.name = "Renamed in another tab";
    localStorage.setItem(key, JSON.stringify(workspace));
    return active.name;
  }, STORAGE_KEY);

  await expect(page.locator(".active-context strong")).toHaveText(renamed);
  await expect(page.locator(".toast[role='status']")).toContainText("Workspace updated from another tab");
  await expect(page.locator(".stale-banner")).toHaveCount(0);
  await expect(page.locator(".save-state")).toContainText("Saved locally");
  expect(pageErrors).toEqual([]);
  await other.close();
});

test("F8: a dirty tab shows a persistent banner and refuses to overwrite the fresher workspace", async ({
  context,
  page
}) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await freshPage(page, "#criteria");
  await page.getByRole("button", { name: "Add criterion", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add criterion" });
  await dialog.getByLabel("Criterion name").fill("Stale tab criterion");
  await expect(page.locator(".save-state")).toHaveText("Unsaved changes");

  const other = await context.newPage();
  await other.goto(APP_PATH, { waitUntil: "domcontentloaded" });
  await other.getByRole("button", { name: "Open workspace" }).first().click();
  await expect(other).toHaveURL(/#command$/);
  const fresher = await other.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  expect(fresher).toBeTruthy();

  const banner = page.locator(".stale-banner[role='alert']");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("Workspace changed in another tab");
  await expect(banner.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("Criterion name")).toHaveValue("Stale tab criterion");
  await expect(page.locator(".save-state")).toHaveClass(/\berror\b/);
  await expect(page.locator(".save-state")).toHaveAttribute("aria-live", "assertive");
  await expect(page.locator(".save-state")).toContainText("changed in another tab");

  await dialog.locator("form").evaluate(form => form.requestSubmit());
  await expect(page.locator(".toast[role='alert']")).toContainText("changed in another tab");
  await expect(page.locator(".stale-banner")).toBeVisible();
  const afterRefusedSave = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  expect(afterRefusedSave).toBe(fresher);
  expect(afterRefusedSave).not.toContain("Stale tab criterion");

  page.once("dialog", confirmation => confirmation.accept());
  await page.locator(".stale-banner").getByRole("button", { name: "Reload" }).click();
  await page.waitForLoadState("domcontentloaded");
  await expect(page.locator(".stale-banner")).toHaveCount(0);
  await expect(page.locator(".save-state")).toContainText("Saved locally");
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe(fresher);
  expect(pageErrors).toEqual([]);
  await other.close();
});

test("F9: the save-state indicator is a polite live region that turns assertive on a save error", async ({
  page
}) => {
  await freshPage(page, "#criteria");
  const indicator = page.locator(".save-state");
  await expect(indicator).toHaveAttribute("role", "status");
  await expect(indicator).toHaveAttribute("aria-live", "polite");
  await expect(indicator).toHaveAttribute("aria-atomic", "true");

  await page.getByRole("button", { name: "Add criterion", exact: true }).click();
  await page.getByRole("dialog", { name: "Add criterion" }).getByLabel("Criterion name").fill("Live");
  await expect(indicator).toHaveText("Unsaved changes");
  await expect(indicator).toHaveAttribute("aria-live", "polite");

  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
  });
  page.once("dialog", confirmation => confirmation.accept());
  await page.getByRole("dialog", { name: "Add criterion" }).getByRole("button", { name: "Close dialog" }).click();
  await page.goto(`${APP_PATH}#portfolio`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
  });
  await page.getByRole("button", { name: "Open workspace" }).first().click();
  await expect(page.locator(".save-state")).toContainText("Browser storage is full");
  await expect(page.locator(".save-state")).toHaveAttribute("aria-live", "assertive");
  await expect(page.locator(".save-state")).toHaveAttribute("role", "status");
});

// The trap host must be a different origin from the app (so the frame is cross-origin)
// yet still a loopback address, because Chromium's private-network access rules refuse
// to let a public or opaque-origin page frame 127.0.0.1. `localhost:4173` is served by
// the same static server; its plain 404 page carries no CSP, so it can hold the iframe.
const TRAP_HOST_URL = "http://localhost:4173/hardening-frame-host-does-not-exist";

async function loadFramedApp(page, baseURL, sandbox = "") {
  await page.goto(TRAP_HOST_URL, { waitUntil: "domcontentloaded" });
  expect(new URL(page.url()).origin).not.toBe(new URL(baseURL).origin);
  await page.setContent(
    `<h1>Trap host</h1><iframe id="trap" ${sandbox} src="${baseURL}" width="900" height="700"></iframe>`
  );
  return page.frameLocator("#trap");
}

test("F6: a cross-origin frame never renders the app, only a plain-text refusal", async ({
  page,
  baseURL
}) => {
  const frame = await loadFramedApp(page, baseURL);
  await expect(frame.locator("#app")).toHaveText(
    "Black Hat Agent cannot run inside another page. Open it directly in its own browser tab.",
    { timeout: 15_000 }
  );
  await expect(frame.locator(".app")).toHaveCount(0);
  await expect(frame.locator("#app > *")).toHaveCount(0);
  await expect(frame.locator("[data-action], [data-view]")).toHaveCount(0);
  expect(page.url()).toBe(TRAP_HOST_URL);
  await expect(page.getByRole("heading", { name: "Trap host" })).toBeVisible();
});

test("F6: a sandboxed frame that forbids top navigation gets the same refusal", async ({
  page,
  baseURL
}) => {
  const frame = await loadFramedApp(page, baseURL, 'sandbox="allow-scripts allow-same-origin"');
  await expect(frame.locator("#app")).toContainText("cannot run inside another page", { timeout: 15_000 });
  await expect(frame.locator(".app")).toHaveCount(0);
  await expect(frame.locator("#app > *")).toHaveCount(0);
  expect(page.url()).toBe(TRAP_HOST_URL);
});

test("F6: the frame-buster is a no-op for the top-level page", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await freshPage(page);
  expect(await page.evaluate(() => window.top === window.self)).toBe(true);
  await expect(page.locator(".app")).toHaveCount(1);
  await expect(page.locator("#app")).not.toContainText("cannot run inside another page");
  expect(pageErrors).toEqual([]);
});
