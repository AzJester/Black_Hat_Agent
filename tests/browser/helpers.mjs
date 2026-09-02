import { expect } from "@playwright/test";

export const APP_PATH = "./";
export const STORAGE_KEY = "black_hat_agent_public_v2";
export const UNREADABLE_KEY = `${STORAGE_KEY}_unreadable`;
export const DEMO_PURSUIT_NAME = "Joint Multi-Domain T&E Support";
export const DEMO_PURSUIT_NAMES = [
  DEMO_PURSUIT_NAME,
  "Space Systems Engineering Services",
  "Range Modernization Recompete"
];

// The application starts empty, so a spec that needs a pursuit loads the built-in
// demonstration through the same on-demand path a user takes: open the Workspace
// menu, choose "Load demonstration workspace", accept the native confirm, and wait
// for the demonstration pursuit to appear. `hash` reopens the app on a view once the
// demonstration is persisted, matching the fresh-page helpers the specs already use.
export async function loadDemoWorkspace(page, { hash = "", clearStorage = true } = {}) {
  await page.goto(APP_PATH, { waitUntil: "domcontentloaded" });
  if (clearStorage) {
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "domcontentloaded" });
  }
  page.once("dialog", dialog => dialog.accept().catch(() => {}));
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.locator('#workspace-menu [data-action="load-demo"]').click();
  await expect(page.getByRole("heading", { name: DEMO_PURSUIT_NAME })).toBeVisible();
  await expect
    .poll(() => page.evaluate(key => Boolean(localStorage.getItem(key)), STORAGE_KEY))
    .toBe(true);
  if (hash) {
    await page.goto(`${APP_PATH}${hash}`, { waitUntil: "domcontentloaded" });
    await page.reload({ waitUntil: "domcontentloaded" });
  }
}

// Reads a Playwright download back as one UTF-8 string.
export async function downloadText(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
