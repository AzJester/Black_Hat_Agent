import { test, expect } from "@playwright/test";

const APP_PATH = "./";
const STORAGE_KEY = "black_hat_agent_public_v2";
const FRAMED_MESSAGE =
  "Black Hat Agent cannot run inside another page. Open it directly in its own browser tab.";

// Same trap arrangement as the round-1 F6 specs: a different loopback origin whose
// plain 404 page carries no CSP, so it can hold the cross-origin iframe.
const TRAP_HOST_URL = "http://localhost:4173/hardening-frame-host-does-not-exist";

async function loadFramedApp(page, baseURL) {
  await page.goto(TRAP_HOST_URL, { waitUntil: "domcontentloaded" });
  expect(new URL(page.url()).origin).not.toBe(new URL(baseURL).origin);
  await page.setContent(
    `<h1>Trap host</h1><iframe id="trap" src="${baseURL}" width="900" height="700"></iframe>`
  );
  const frame = page.frameLocator("#trap");
  await expect(frame.locator("#app")).toHaveText(FRAMED_MESSAGE, { timeout: 15_000 });
  return frame;
}

async function expectRefusalOnly(page, frame) {
  await expect(frame.locator("#app")).toHaveText(FRAMED_MESSAGE);
  await expect(frame.locator(".app")).toHaveCount(0);
  await expect(frame.locator("#app > *")).toHaveCount(0);
  await expect(frame.locator("[data-action], [data-view]")).toHaveCount(0);
  await expect(frame.locator("dialog#modal")).toHaveCount(0);
  await expect(frame.locator("button")).toHaveCount(0);
  expect(page.url()).toBe(TRAP_HOST_URL);
}

test("F6: a fragment-only navigation from the hostile parent still renders nothing but the refusal", async ({
  page,
  baseURL
}) => {
  const frame = await loadFramedApp(page, baseURL);
  await expectRefusalOnly(page, frame);

  // Setting only the fragment is a same-document navigation inside the frame: no
  // reload, so the module does not re-run, and popstate fires with a valid view name.
  for (const hash of ["#command", "#criteria", "#portfolio"]) {
    await page.evaluate(
      ({ base, next }) => {
        document.querySelector("#trap").src = `${base}${next}`;
      },
      { base: baseURL, next: hash }
    );
    await expect
      .poll(() => page.evaluate(() => document.querySelector("#trap").src))
      .toBe(`${baseURL}${hash}`);
    await page.waitForTimeout(300);
    await expectRefusalOnly(page, frame);
  }
  await expect(page.getByRole("heading", { name: "Trap host" })).toBeVisible();
});

async function freshPage(page, hash = "") {
  await page.goto(`${APP_PATH}${hash}`, { waitUntil: "domcontentloaded" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect
    .poll(() => page.evaluate(() => Boolean(window.XLSX && typeof window.XLSX.read === "function")))
    .toBe(true);
}

async function prepareCriteriaImport(page, criterionName) {
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Import Excel or CSV", exact: true }).click();
  const wizard = page.locator("#localImportWizard");
  await expect(wizard).toBeVisible();
  await page.locator("#tabularImportFile").setInputFiles({
    name: "criteria.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      ["Criterion,Weight,Our Score,Description", `"${criterionName}",25,4,"Imported while another tab saved"`].join(
        "\r\n"
      ),
      "utf8"
    )
  });
  await expect(page.locator("#importSheet")).toBeVisible();
  await expect(wizard.locator("#importTarget")).toHaveValue("criteria");
  await wizard.getByRole("button", { name: "Map columns" }).click();
  await expect(wizard.locator('select[name="map__name"]')).toHaveValue("0");
  await wizard.getByRole("button", { name: "Validate and review" }).click();
  await expect(wizard.getByText("READY", { exact: true })).toBeVisible();
  return wizard;
}

async function storedWorkspace(page) {
  return page.evaluate(key => {
    const workspace = JSON.parse(localStorage.getItem(key));
    const active = workspace.pursuits.find(item => item.id === workspace.active);
    return {
      activeName: active?.name || "",
      criteriaNames: workspace.criteria.map(item => item.name)
    };
  }, STORAGE_KEY);
}

test("F8: a validated import plan is refused after another tab saved, and accepted once re-validated", async ({
  context,
  page
}) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await freshPage(page, "#command");
  const criterionName = "Cross-tab wizard criterion";
  const wizard = await prepareCriteriaImport(page, criterionName);

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

  // The clean tab adopts the fresher workspace while the wizard stays open on Review.
  await expect(page.locator(".active-context strong")).toHaveText(renamed);
  await expect(page.locator(".toast[role='status']")).toContainText("Validate the import again");
  await expect(wizard).toBeVisible();
  await expect(page.locator(".stale-banner")).toHaveCount(0);

  // Applying the pre-adoption plan must not overwrite the other tab's rename.
  await wizard.getByRole("button", { name: "Apply import" }).click();
  await expect(wizard.locator(".wizard-status")).toContainText("changed in another tab");
  await expect(wizard.locator(".wizard-status")).toContainText("Validate and review");
  await expect(wizard).toBeVisible();
  let stored = await storedWorkspace(page);
  expect(stored.activeName).toBe(renamed);
  expect(stored.criteriaNames).not.toContain(criterionName);
  await expect(page.locator(".active-context strong")).toHaveText(renamed);

  // Rebuilding the plan against the adopted workspace keeps both changes.
  await wizard.getByRole("button", { name: "Back to mapping" }).click();
  await expect(wizard.locator('select[name="map__name"]')).toHaveValue("0");
  await wizard.getByRole("button", { name: "Validate and review" }).click();
  await expect(wizard.getByText("READY", { exact: true })).toBeVisible();
  await wizard.getByRole("button", { name: "Apply import" }).click();
  await expect(page.locator("#localImportWizard")).toHaveCount(0);
  await expect(page.locator(".toast[role='status']")).toContainText("Import complete");
  stored = await storedWorkspace(page);
  expect(stored.activeName).toBe(renamed);
  expect(stored.criteriaNames).toContain(criterionName);
  await expect(page.locator(".active-context strong")).toHaveText(renamed);

  // The other tab adopts the import in turn instead of holding a stale copy.
  await expect(other.locator(".toast[role='status']")).toContainText("Workspace updated from another tab");
  expect(await storedWorkspace(other)).toEqual(stored);
  expect(pageErrors).toEqual([]);
  await other.close();
});

test("F8: a frozen tab's wizard cannot apply an import while saving is paused", async ({ context, page }) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await freshPage(page, "#opportunity");
  // A dirty inline form marks the tab, so the next cross-tab save freezes it.
  const dirtyInput = page.locator(".content form input[type='text']").first();
  await dirtyInput.fill("Dirty edit held in this tab");
  await expect(page.locator(".save-state")).toHaveText("Unsaved changes");

  const other = await context.newPage();
  await other.goto(APP_PATH, { waitUntil: "domcontentloaded" });
  await other.getByRole("button", { name: "Open workspace" }).first().click();
  await expect(other).toHaveURL(/#command$/);
  const fresher = await other.evaluate(key => localStorage.getItem(key), STORAGE_KEY);
  await expect(page.locator(".stale-banner[role='alert']")).toBeVisible();

  const wizard = await prepareCriteriaImport(page, "Frozen tab criterion");
  await wizard.getByRole("button", { name: "Apply import" }).click();
  await expect(wizard.locator(".wizard-status")).toContainText("changed in another tab");
  await expect(wizard).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), STORAGE_KEY)).toBe(fresher);
  expect(pageErrors).toEqual([]);
  await other.close();
});
