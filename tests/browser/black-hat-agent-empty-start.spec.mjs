import { test, expect } from "@playwright/test";
import {
  APP_PATH,
  DEMO_PURSUIT_NAMES,
  STORAGE_KEY,
  UNREADABLE_KEY,
  downloadText,
  loadDemoWorkspace
} from "./helpers.mjs";

const VIEWS = [
  ["portfolio", "Pursuit Portfolio"],
  ["command", "Command Center"],
  ["opportunity", "Opportunity"],
  ["criteria", "Evaluation Criteria"],
  ["evidence", "Evidence Room"],
  ["competitors", "Competitors"],
  ["participants", "Participant Inputs"],
  ["registers", "Black Hat Registers"],
  ["imports", "Data Import"],
  ["playbooks", "Playbook Library"],
  ["session", "Black Hat Session"],
  ["history", "Run History"],
  ["outputs", "Output Center"],
  ["actions", "Action Register"],
  ["recovery", "Recovery"],
  ["guide", "User Guide"]
];
const PURSUIT_SCOPED_VIEWS = [
  "command", "opportunity", "criteria", "evidence", "competitors", "participants", "registers",
  "imports", "session", "history", "outputs", "actions"
];

async function freshEmptyPage(page, hash = "") {
  await page.goto(`${APP_PATH}${hash}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function storageKeys(page) {
  return page.evaluate(() => Object.keys(localStorage).sort());
}

async function expectNoDemoNames(page) {
  const text = await page.evaluate(() => document.body.textContent);
  for (const name of DEMO_PURSUIT_NAMES) {
    expect(text, `${name} is not rendered`).not.toContain(name);
  }
}

test("a first launch opens an empty workspace and touches nothing in storage", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await freshEmptyPage(page);

  await expect(page.getByRole("heading", { name: "No pursuits yet" })).toBeVisible();
  await expect(page.locator(".grid .card")).toHaveCount(0);
  await expect(page.locator(".active-context strong")).toHaveText("No pursuit selected");
  const empty = page.locator(".portfolio-empty");
  await expect(empty.getByRole("button", { name: "Create pursuit", exact: true })).toBeVisible();
  await expect(
    empty.getByRole("button", { name: "Load demonstration workspace", exact: true })
  ).toBeVisible();
  await expect(page.locator(".startup-banner")).toHaveCount(0);
  await expectNoDemoNames(page);
  expect(await storageKeys(page)).toEqual([]);

  // Rendering every view on the empty workspace still writes nothing.
  for (const [view] of VIEWS) {
    await page.evaluate(hash => { location.hash = `#${hash}`; }, view);
    await page.waitForTimeout(50);
  }
  expect(await storageKeys(page)).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("every view renders on the empty workspace without errors, undefined, or NaN", async ({ page }) => {
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  page.on("console", message => { if (message.type() === "error") consoleErrors.push(message.text()); });
  await freshEmptyPage(page);
  const navigation = page.getByRole("navigation", { name: "Workspace navigation" });

  for (const [view, label] of VIEWS) {
    await page.evaluate(hash => { location.hash = `#${hash}`; }, view);
    await expect(navigation.locator('[aria-current="page"]')).toHaveText(label);
    const content = page.locator("#content");
    await expect(content.locator("h1")).toBeVisible();
    const text = await content.evaluate(node => node.textContent);
    expect(text, `${view} renders no "undefined"`).not.toMatch(/\bundefined\b/);
    expect(text, `${view} renders no "NaN"`).not.toMatch(/\bNaN\b/);
    await expect(page.locator(".active-context strong")).toHaveText("No pursuit selected");
    if (PURSUIT_SCOPED_VIEWS.includes(view)) {
      const panel = content.locator(".no-pursuit");
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("heading", { name: "No pursuit selected" })).toBeVisible();
      await expect(panel.locator('[data-view="portfolio"]')).toBeVisible();
    }
  }

  // The Playbook Library lists the built-in playbooks but cannot assign one yet.
  await page.evaluate(() => { location.hash = "#playbooks"; });
  await expect(page.locator(".grid .card")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "Use for active pursuit" })).toHaveCount(0);

  // The link from a scoped view lands on the portfolio.
  await page.evaluate(() => { location.hash = "#criteria"; });
  await page.locator('.no-pursuit [data-view="portfolio"]').click();
  await expect(page).toHaveURL(/#portfolio$/);
  await expect(page.getByRole("heading", { name: "No pursuits yet" })).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test("Load demonstration workspace populates the portfolio on demand", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await loadDemoWorkspace(page);

  await expect(page.locator(".grid .card")).toHaveCount(3);
  for (const name of DEMO_PURSUIT_NAMES) {
    await expect(page.getByRole("heading", { name })).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "No pursuits yet" })).toHaveCount(0);
  await expect(page.locator(".active-context strong")).toHaveText(DEMO_PURSUIT_NAMES[0]);
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  expect(stored.pursuits.map(item => item.name)).toEqual(DEMO_PURSUIT_NAMES);
  expect(stored.snapshots.map(item => item.label)).toEqual([
    "Before loading the demonstration workspace"
  ]);
  expect(stored.snapshots[0].active).toBe("");
  expect(stored.snapshots[0].workspace.pursuits).toEqual([]);

  // The snapshot of the empty workspace round-trips through the validated load.
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".grid .card")).toHaveCount(3);
  await expect(page.locator(".startup-banner")).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

const GARBAGE = '{"not": "a workspace", "tail": "é☃ unterminated';

const CORRUPTION_SCENARIOS = [
  {
    name: "unparseable JSON",
    async prepare(page) {
      await freshEmptyPage(page);
      await page.evaluate(
        ({ key, value }) => localStorage.setItem(key, value),
        { key: STORAGE_KEY, value: GARBAGE }
      );
      return GARBAGE;
    }
  },
  {
    name: "a schema-shaped workspace whose criterion references missing evidence",
    async prepare(page) {
      await loadDemoWorkspace(page);
      return page.evaluate(key => {
        const workspace = JSON.parse(localStorage.getItem(key));
        workspace.criteria[0].evidenceIds = ["missing-evidence"];
        const raw = JSON.stringify(workspace);
        localStorage.setItem(key, raw);
        return raw;
      }, STORAGE_KEY);
    }
  }
];

for (const scenario of CORRUPTION_SCENARIOS) {
  test(`${scenario.name} is set aside, not replaced by the demonstration, and can be downloaded or discarded`, async ({
    page
  }) => {
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    const raw = await scenario.prepare(page);
    await page.reload({ waitUntil: "domcontentloaded" });

    const banner = page.locator(".startup-banner[role='alert']");
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("could not be read");
    await expect(banner).toContainText("copy of the unreadable data was kept");
    await expect(page.getByRole("heading", { name: "No pursuits yet" })).toBeVisible();
    await expect(page.locator(".grid .card")).toHaveCount(0);
    await expect(page.locator(".active-context strong")).toHaveText("No pursuit selected");
    await expectNoDemoNames(page);

    const copy = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), UNREADABLE_KEY);
    expect(copy.raw).toBe(raw);
    expect(Number.isFinite(Date.parse(copy.savedAt))).toBe(true);
    expect(copy.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    // The unreadable value itself is untouched until the user saves.
    expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe(raw);

    await banner.getByRole("button", { name: "Open Recovery" }).click();
    await expect(page).toHaveURL(/#recovery$/);
    const panel = page.locator(".unreadable-copy");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText(new Date(copy.savedAt).getFullYear().toString());
    await expect(panel).toContainText(`${Buffer.byteLength(raw, "utf8").toLocaleString()} bytes`);
    expect(await panel.evaluate(node => node.textContent)).not.toContain(raw.slice(0, 12));

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      panel.getByRole("button", { name: "Download unreadable workspace copy" }).click()
    ]);
    expect(download.suggestedFilename()).toMatch(/^black-hat-agent-unreadable-workspace-\d{4}-\d{2}-\d{2}\.json$/);
    expect(await downloadText(download)).toBe(raw);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).raw, UNREADABLE_KEY)).toBe(raw);

    page.once("dialog", dialog => dialog.dismiss());
    await panel.getByRole("button", { name: "Discard copy" }).click();
    await expect(panel).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), UNREADABLE_KEY)).not.toBeNull();

    page.once("dialog", dialog => dialog.accept());
    await panel.getByRole("button", { name: "Discard copy" }).click();
    await expect(page.locator(".unreadable-copy")).toHaveCount(0);
    await expect(page.locator(".toast[role='status']")).toContainText("discarded");
    expect(await page.evaluate(key => localStorage.getItem(key), UNREADABLE_KEY)).toBeNull();
    expect(pageErrors).toEqual([]);
  });
}

test("the same unreadable value keeps its original timestamp across reloads and the first save replaces it", async ({
  page
}) => {
  await freshEmptyPage(page);
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: GARBAGE }
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  const first = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), UNREADABLE_KEY);
  await page.waitForTimeout(20);
  await page.reload({ waitUntil: "domcontentloaded" });
  const second = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), UNREADABLE_KEY);
  expect(second).toEqual(first);

  await page.locator(".startup-banner").getByRole("button", { name: "Dismiss" }).click();
  await expect(page.locator(".startup-banner")).toHaveCount(0);

  // Creating the first pursuit saves a valid workspace over the unreadable value and
  // leaves the set-aside copy in place.
  await page.locator(".portfolio-empty").getByRole("button", { name: "Create pursuit" }).click();
  const dialog = page.getByRole("dialog", { name: "Add pursuit" });
  await dialog.getByLabel("Opportunity name").fill("First real pursuit");
  await dialog.getByLabel("Customer").fill("Real customer");
  await dialog.getByRole("button", { name: "Save record" }).click();
  await expect(page).toHaveURL(/#command$/);
  await expect(page.locator(".active-context strong")).toHaveText("First real pursuit");
  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  expect(stored.pursuits.map(item => item.name)).toEqual(["First real pursuit"]);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), UNREADABLE_KEY)).toEqual(first);

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator(".startup-banner")).toHaveCount(0);
  await expect(page.locator(".active-context strong")).toHaveText("First real pursuit");
});

test("F8: an unreadable copy saved by another tab neither replaces this tab's data nor touches the recovery key", async ({
  context,
  page
}) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await loadDemoWorkspace(page, { hash: "#command" });
  await expect(page.locator(".active-context strong")).toHaveText(DEMO_PURSUIT_NAMES[0]);
  const good = await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY);

  const other = await context.newPage();
  await other.goto(APP_PATH, { waitUntil: "domcontentloaded" });
  await other.evaluate(
    ({ key, value }) => localStorage.setItem(key, value),
    { key: STORAGE_KEY, value: GARBAGE }
  );

  await expect(page.locator(".toast[role='alert']")).toContainText("stored copy could not be loaded");
  await expect(page.locator(".active-context strong")).toHaveText(DEMO_PURSUIT_NAMES[0]);
  await expect(page.locator(".startup-banner")).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), UNREADABLE_KEY)).toBeNull();

  // This tab still holds the good workspace and can persist it again.
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Create recovery snapshot" }).click();
  await expect(page.locator(".toast[role='status']")).toContainText("Recovery snapshot created");
  const restored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  expect(restored.pursuits.map(item => item.name)).toEqual(JSON.parse(good).pursuits.map(item => item.name));
  expect(pageErrors).toEqual([]);
  await other.close();
});
