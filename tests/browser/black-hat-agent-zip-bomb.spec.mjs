import { test, expect } from "@playwright/test";
import { loadDemoWorkspace } from "./helpers.mjs";

async function gotoFreshBlackHatAgent(page) {
  // Scoped imports need an active pursuit, so start from the demonstration workspace.
  await loadDemoWorkspace(page);
  await expect(page).toHaveTitle(/Black Hat Agent$/i);
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(window.XLSX && typeof window.XLSX.read === "function")),
    )
    .toBe(true);
}

async function openImportWizard(page) {
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Import Excel or CSV", exact: true }).click();
  const wizard = page.locator("#localImportWizard");
  await expect(wizard).toBeVisible();
  return wizard;
}

// In-page ZIP toolkit. Builds a ZIP whose every entry is a streaming/DEFLATE
// (flag 0x08) member declaring uncompressedSize 0 in BOTH the local header and
// the central directory — the exact shape that defeats a declared-size preflight.
async function installZipToolkit(page) {
  await page.evaluate(() => {
    async function pump(stream, input) {
      const writer = stream.writable.getWriter();
      writer.write(input);
      writer.close();
      const reader = stream.readable.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      const out = new Uint8Array(total);
      let at = 0;
      for (const chunk of chunks) {
        out.set(chunk, at);
        at += chunk.byteLength;
      }
      return out;
    }
    window.__zip = {
      deflateRaw: input => pump(new CompressionStream("deflate-raw"), input),
      inflateRaw: input => pump(new DecompressionStream("deflate-raw"), input),
      // entries: [{ name, deflated:Uint8Array, uncompressedLength, crc }]
      buildStreamingZip(entries) {
        const encoder = new TextEncoder();
        const locals = [];
        const centrals = [];
        let offset = 0;
        for (const entry of entries) {
          const name = encoder.encode(entry.name);
          const crc = entry.crc >>> 0;
          const local = new Uint8Array(30 + name.length);
          const lv = new DataView(local.buffer);
          lv.setUint32(0, 0x04034b50, true);
          lv.setUint16(4, 20, true);
          lv.setUint16(6, 0x0008, true); // general-purpose flag: data descriptor
          lv.setUint16(8, 8, true); // method: DEFLATE
          lv.setUint32(14, 0, true); // crc-32 (unknown -> 0)
          lv.setUint32(18, 0, true); // compressed size (unknown -> 0)
          lv.setUint32(22, 0, true); // uncompressed size (unknown -> 0)
          lv.setUint16(26, name.length, true);
          lv.setUint16(28, 0, true);
          local.set(name, 30);
          const descriptor = new Uint8Array(16);
          const dv = new DataView(descriptor.buffer);
          dv.setUint32(0, 0x08074b50, true);
          dv.setUint32(4, crc, true);
          dv.setUint32(8, entry.deflated.length, true);
          dv.setUint32(12, entry.uncompressedLength >>> 0, true);
          const localOffset = offset;
          locals.push(local, entry.deflated, descriptor);
          offset += local.length + entry.deflated.length + descriptor.length;

          const central = new Uint8Array(46 + name.length);
          const cv = new DataView(central.buffer);
          cv.setUint32(0, 0x02014b50, true);
          cv.setUint16(4, 20, true);
          cv.setUint16(6, 20, true);
          cv.setUint16(8, 0x0008, true);
          cv.setUint16(10, 8, true);
          cv.setUint32(16, 0, true); // crc-32
          cv.setUint32(20, 0, true); // compressed size (declared 0)
          cv.setUint32(24, 0, true); // uncompressed size (declared 0)
          cv.setUint16(28, name.length, true);
          cv.setUint32(42, localOffset, true);
          central.set(name, 46);
          centrals.push(central);
        }
        const centralStart = offset;
        let centralSize = 0;
        for (const central of centrals) centralSize += central.length;
        const eocd = new Uint8Array(22);
        const ev = new DataView(eocd.buffer);
        ev.setUint32(0, 0x06054b50, true);
        ev.setUint16(8, entries.length, true);
        ev.setUint16(10, entries.length, true);
        ev.setUint32(12, centralSize, true);
        ev.setUint32(16, centralStart, true);
        const parts = [...locals, ...centrals, eocd];
        let size = 0;
        for (const part of parts) size += part.length;
        const result = new Uint8Array(size);
        let at = 0;
        for (const part of parts) {
          result.set(part, at);
          at += part.length;
        }
        return result;
      },
      // Rewrites a real SheetJS ZIP into the streaming/declared-zero shape while
      // keeping the payload valid, so the workbook still parses if accepted.
      async repackAsStreaming(zipBytes) {
        const u8 = zipBytes instanceof Uint8Array ? zipBytes : new Uint8Array(zipBytes);
        const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        let eocd = u8.length - 22;
        while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
        const count = view.getUint16(eocd + 10, true);
        let offset = view.getUint32(eocd + 16, true);
        const decoder = new TextDecoder();
        const entries = [];
        for (let index = 0; index < count; index += 1) {
          const method = view.getUint16(offset + 10, true);
          const crc = view.getUint32(offset + 16, true);
          const compressedSize = view.getUint32(offset + 20, true);
          const nameLength = view.getUint16(offset + 28, true);
          const extraLength = view.getUint16(offset + 30, true);
          const commentLength = view.getUint16(offset + 32, true);
          const localOffset = view.getUint32(offset + 42, true);
          const name = decoder.decode(u8.subarray(offset + 46, offset + 46 + nameLength));
          const localNameLength = view.getUint16(localOffset + 26, true);
          const localExtraLength = view.getUint16(localOffset + 28, true);
          const dataStart = localOffset + 30 + localNameLength + localExtraLength;
          const data = u8.subarray(dataStart, dataStart + compressedSize);
          const raw = method === 8 ? await this.inflateRaw(data) : data.slice();
          const deflated = await this.deflateRaw(raw);
          entries.push({ name, deflated, uncompressedLength: raw.length, crc });
          offset += 46 + nameLength + extraLength + commentLength;
        }
        return this.buildStreamingZip(entries);
      },
    };
  });
}

test("a streaming XLSX whose DEFLATE stream inflates past the ceiling is rejected fast", async ({
  page,
}) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await gotoFreshBlackHatAgent(page);
  await installZipToolkit(page);

  const started = Date.now();
  const bombBytes = await page.evaluate(async () => {
    const zeros = new Uint8Array(60_000_000);
    const deflated = await window.__zip.deflateRaw(zeros);
    const zip = window.__zip.buildStreamingZip([
      { name: "xl/worksheets/sheet1.xml", deflated, uncompressedLength: 0, crc: 0 },
    ]);
    return Array.from(zip);
  });

  const wizard = await openImportWizard(page);
  await wizard.locator("#tabularImportFile").setInputFiles({
    name: "zip-bomb.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(bombBytes),
  });

  await expect(wizard.locator(".wizard-status")).toContainText(/expanded-size limit/i);
  await expect(wizard.locator("#importSheet")).toHaveCount(0);
  expect(Date.now() - started).toBeLessThan(20_000);

  // The page is still responsive after the rejection: the file chooser and the
  // template button remain live and the wizard reacts to interaction.
  await expect(wizard.locator("#tabularImportFile")).toBeEnabled();
  await expect(wizard.getByRole("button", { name: "Download workbook template" })).toBeEnabled();
  expect(pageErrors).toEqual([]);
});

test("a streaming XLSX whose DEFLATE stream stays small is accepted", async ({ page }) => {
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await gotoFreshBlackHatAgent(page);
  await installZipToolkit(page);

  const workbookBytes = await page.evaluate(async () => {
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(
      workbook,
      window.XLSX.utils.aoa_to_sheet([
        ["Title", "Source"],
        ["Streaming header evidence", "Repacked local fixture"],
      ]),
      "Evidence",
    );
    const written = new Uint8Array(
      window.XLSX.write(workbook, { bookType: "xlsx", type: "array", compression: true }),
    );
    const repacked = await window.__zip.repackAsStreaming(written);
    return Array.from(repacked);
  });

  const wizard = await openImportWizard(page);
  await wizard.locator("#tabularImportFile").setInputFiles({
    name: "streaming-small.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(workbookBytes),
  });

  await expect(wizard.locator("#importSheet")).toBeVisible();
  await wizard.locator("#importTarget").selectOption("evidence");
  await wizard.getByRole("button", { name: "Map columns" }).click();
  await expect(wizard.locator('select[name="map__title"]')).toHaveValue("0");
  await wizard.getByRole("button", { name: "Validate and review" }).click();
  await expect(wizard.getByText("READY", { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
