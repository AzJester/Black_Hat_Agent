import { test, expect } from "@playwright/test";
import { deflateRawSync } from "node:zlib";
import { STORAGE_KEY, loadDemoWorkspace } from "./helpers.mjs";

function docx(xml) {
  const name = Buffer.from("word/document.xml");
  const raw = Buffer.from(xml);
  const data = deflateRawSync(raw);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + data.length, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

const paragraph = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;

test("participant inputs show disagreements, registers feed the report, and the scenario estimate stays off", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await loadDemoWorkspace(page, { hash: "#participants" });

  await expect(page.getByRole("heading", { name: "Each participant's view, by work area" })).toBeVisible();
  const area = page.locator(".participant-area").filter({ hasText: "Test planning and execution" });
  await expect(area.locator(".disagreement-list li")).toContainText([
    /different #1 competitors/,
    /Vector Range Solutions is ranked #1 by Avery Lee and #3 by Jordan Patel/
  ]);
  await expect(page.locator(".quality-list")).toContainText(
    "Jordan Patel rates Northstar Mission Systems (Test planning and execution) High confidence on personal experience"
  );

  // An input typed with a recorded alias links to the competitor.
  await page.getByRole("button", { name: "Add input" }).first().click();
  await page.locator("#field-participant").fill("Sam Ortiz");
  await page.locator("#field-workArea").selectOption("Digital engineering");
  await page.locator("#field-competitorName").fill("NMS");
  await page.locator("#field-confidence").selectOption("Medium");
  await page.getByRole("button", { name: "Save record" }).click();
  const digital = page.locator(".participant-area").filter({ hasText: "Digital engineering" });
  await expect(digital.getByRole("row", { name: /Sam Ortiz/ })).toContainText("Northstar Mission Systems");
  await expect(digital.getByRole("row", { name: /Sam Ortiz/ })).not.toContainText("UNMATCHED");

  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Black Hat Registers" }).click();
  await page.getByRole("button", { name: "Add risk" }).click();
  await page.locator("#field-title").fill("Pricing basis unknown");
  await page.locator("#field-level").selectOption("High");
  await page.getByRole("button", { name: "Save record" }).click();
  await expect(page.getByRole("table", { name: "Risk register" })).toContainText("Pricing basis unknown");

  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Command Center" }).click();
  await expect(page.getByRole("table", { name: "Leaders by work area" })).toContainText("Test planning and execution");
  await expect(page.locator(".metric").filter({ hasText: "SCENARIO ESTIMATE" })).toHaveCount(0);

  await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("link", { name: "Black Hat Session" }).click();
  await page.getByRole("button", { name: "Generate competitive analysis" }).click();
  await expect(page.getByRole("heading", { name: "Editable competitive-analysis reports" })).toBeVisible();
  const output = await page.evaluate(
    key => JSON.parse(localStorage.getItem(key)).runs.at(-1).output,
    STORAGE_KEY
  );
  expect(output).toMatch(/## 4\. Work-area comparison/);
  expect(output).toMatch(/## 13\. Ghosting bank/);
  expect(output).toMatch(/Pricing basis unknown/);
  expect(output).toMatch(/Scenario win estimate:\*\* Off/);
  expect(pageErrors).toEqual([]);
});

test("a tagged Word summary imports as linked evidence without any network request", async ({ page }) => {
  const requests = [];
  page.on("request", request => {
    if (!request.url().startsWith("http://127.0.0.1")) requests.push(request.url());
  });
  await loadDemoWorkspace(page, { hash: "#evidence" });
  const xml = `<w:document xmlns:w="x"><w:body>${paragraph("WHAT THEY DO WELL.")}${paragraph(
    "Runs three range contracts today. [KNOWN · HIGH · FPDS 1234] It will lead with scale. [ASSESSED · MEDIUM · Analyst note] Claims 900 testers. [CLAIMED · Website]"
  )}</w:body></w:document>`;
  await page.locator("#summaryImportFile").setInputFiles({
    name: "Northstar_Black_Hat_Summary.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: docx(xml)
  });
  const dialog = page.locator("#modal");
  await expect(dialog).toContainText("3 tags on 3 claims, giving 3 evidence records");
  await expect(dialog.locator("#field-summaryCompetitor")).toHaveValue("c1");
  await dialog.getByRole("button", { name: "Add 3 evidence records" }).click();
  await expect(page.locator(".evidence-item").filter({ hasText: "Runs three range contracts today." })).toContainText("Documented fact");

  const stored = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), STORAGE_KEY);
  const imported = stored.evidence.filter(item => item.source === "Northstar_Black_Hat_Summary");
  expect(imported.map(item => item.basis)).toEqual(["Documented fact", "Inference", "Claimed"]);
  const northstar = stored.competitors.find(item => item.id === "c1");
  for (const item of imported) expect(northstar.evidenceIds).toContain(item.id);
  expect(stored.snapshots.at(-1).label).toBe("Before importing Northstar_Black_Hat_Summary.docx");
  expect(requests).toEqual([]);

  // The same file again adds nothing.
  await page.locator("#summaryImportFile").setInputFiles({
    name: "Northstar_Black_Hat_Summary.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: docx(xml)
  });
  await dialog.getByRole("button", { name: "Add 3 evidence records" }).click();
  await expect(page.locator(".toast")).toContainText("0 evidence records added, 3 duplicates skipped");
});
