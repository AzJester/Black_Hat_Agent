/* global XLSX */

const MAX_UNCOMPRESSED_BYTES = 50_000_000;
const MAX_ZIP_ENTRY_BYTES = 20_000_000;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_SHEETS = 50;

const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_SIGNATURE = 0x06054b50;
const ZIP_DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const ZIP_FLAG_ENCRYPTED = 0x0001;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;

importScripts("./vendor/xlsx.full.min.js");

self.addEventListener("message", async event => {
  const { bytes, maxRows, maxHeaderRows } = event.data || {};
  try {
    if (!(bytes instanceof ArrayBuffer)) throw new Error("Workbook bytes are missing.");
    const directory = preflightZip(bytes);
    if (directory) await measureZipInflation(bytes, directory);
    const workbook = XLSX.read(bytes, {
      type: "array",
      cellDates: true,
      cellFormula: true,
      cellHTML: false,
      cellStyles: true,
      bookVBA: false,
      bookFiles: false,
      sheetRows: Number(maxRows || 0) + Number(maxHeaderRows || 0) + 2,
      WTF: false
    });
    if (!workbook.SheetNames?.length) throw new Error("The file contains no readable worksheets.");
    if (workbook.SheetNames.length > MAX_SHEETS) {
      throw new Error(`The workbook exceeds the ${MAX_SHEETS}-worksheet limit.`);
    }
    delete workbook.vbaraw;
    self.postMessage({ ok: true, workbook });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error?.message || "The workbook could not be parsed safely."
    });
  }
});

// Structural fast-reject over the central directory. Declared sizes are
// attacker-controlled hints, so this only rejects the obviously oversized; the
// real expanded-size ceiling is enforced by measureZipInflation() below.
// Returns null for non-ZIP input (legacy XLS) and the parsed directory otherwise.
function preflightZip(buffer) {
  const bytes = new Uint8Array(buffer);
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    ![0x03, 0x05, 0x07].includes(bytes[2])
  ) {
    return null;
  }
  const view = new DataView(buffer);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error("The workbook ZIP directory is malformed.");

  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 workbooks are not supported by this local importer.");
  }
  if (entryCount > MAX_ZIP_ENTRIES) {
    throw new Error(`The workbook ZIP exceeds the ${MAX_ZIP_ENTRIES}-entry limit.`);
  }
  if (centralOffset + centralSize > view.byteLength) {
    throw new Error("The workbook ZIP directory points outside the selected file.");
  }

  const entries = [];
  let offset = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      offset + 46 > view.byteLength ||
      view.getUint32(offset, true) !== ZIP_CENTRAL_HEADER_SIGNATURE
    ) {
      throw new Error("The workbook ZIP directory contains an invalid entry.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (flags & ZIP_FLAG_ENCRYPTED) throw new Error("Encrypted workbooks are not supported.");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("ZIP64 workbook entries are not supported.");
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES) throw zipEntryLimitError();
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw zipTotalLimitError();
    if (localOffset >= centralOffset) {
      throw new Error("The workbook ZIP directory contains an invalid entry.");
    }
    entries.push({ flags, method, compressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
    if (offset > centralOffset + centralSize || offset > view.byteLength) {
      throw new Error("The workbook ZIP directory is truncated.");
    }
  }
  return { centralOffset, entries };
}

// Measures what each entry really expands to before SheetJS inflates it. The
// bundled inflater starts at the local header's data offset and reads until the
// DEFLATE stream ends, so the slice is bounded the same way and any inflation
// failure on that slice is a rejection rather than a pass-through.
async function measureZipInflation(buffer, directory) {
  if (!supportsRawInflate()) return;
  const view = new DataView(buffer);
  const ordered = [...directory.entries].sort((a, b) => a.localOffset - b.localOffset);
  let totalBytes = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const entry = ordered[index];
    const nextOffset =
      index + 1 < ordered.length ? ordered[index + 1].localOffset : directory.centralOffset;
    const { start, end } = locateEntryData(view, entry, nextOffset);
    let entryBytes = 0;
    const count = produced => {
      entryBytes += produced;
      if (entryBytes > MAX_ZIP_ENTRY_BYTES) throw zipEntryLimitError();
      if (totalBytes + entryBytes > MAX_UNCOMPRESSED_BYTES) throw zipTotalLimitError();
    };
    if (entry.method === ZIP_METHOD_DEFLATE) {
      await inflateRawCounting(buffer.slice(start, end), count);
    } else if (entry.method === ZIP_METHOD_STORED) {
      count(end - start);
    } else {
      throw new Error("The workbook ZIP uses an unsupported compression method.");
    }
    totalBytes += entryBytes;
  }
}

function locateEntryData(view, entry, nextOffset) {
  const { localOffset } = entry;
  if (
    localOffset + 30 > view.byteLength ||
    view.getUint32(localOffset, true) !== ZIP_LOCAL_HEADER_SIGNATURE
  ) {
    throw new Error("The workbook ZIP contains an invalid local entry header.");
  }
  const nameLength = view.getUint16(localOffset + 26, true);
  const extraLength = view.getUint16(localOffset + 28, true);
  const start = localOffset + 30 + nameLength + extraLength;
  let end;
  if (entry.compressedSize > 0 || !(entry.flags & ZIP_FLAG_DATA_DESCRIPTOR)) {
    end = start + entry.compressedSize;
  } else {
    if (nextOffset < start) throw new Error("The workbook ZIP entry could not be bounded.");
    end = trimDataDescriptor(view, start, nextOffset);
  }
  if (start > view.byteLength || end > view.byteLength || end < start) {
    throw new Error("The workbook ZIP entry points outside the selected file.");
  }
  return { start, end };
}

// A streaming entry ends with a data descriptor (with or without its optional
// signature). When the descriptor's own compressed size lines up with the slice,
// exclude it so the DEFLATE stream is not followed by trailing bytes.
function trimDataDescriptor(view, start, bound) {
  if (bound - start >= 16 && view.getUint32(bound - 16, true) === ZIP_DATA_DESCRIPTOR_SIGNATURE) {
    if (start + view.getUint32(bound - 8, true) === bound - 16) return bound - 16;
  }
  if (bound - start >= 12 && start + view.getUint32(bound - 8, true) === bound - 12) {
    return bound - 12;
  }
  return bound;
}

async function inflateRawCounting(compressed, count) {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const feed = writer.write(new Uint8Array(compressed)).then(() => writer.close());
  feed.catch(() => {});
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      count(value.byteLength);
    }
    await feed;
  } catch (error) {
    if (error?.zipLimit) throw error;
    throw new Error("A workbook ZIP entry could not be decompressed.");
  } finally {
    reader.cancel().catch(() => {});
  }
}

let rawInflateSupport;
function supportsRawInflate() {
  if (rawInflateSupport === undefined) {
    try {
      rawInflateSupport =
        typeof DecompressionStream === "function" &&
        Boolean(new DecompressionStream("deflate-raw"));
    } catch {
      rawInflateSupport = false;
    }
  }
  return rawInflateSupport;
}

function zipEntryLimitError() {
  return zipLimitError(
    `A workbook ZIP entry exceeds the ${formatMegabytes(MAX_ZIP_ENTRY_BYTES)} expanded-size limit.`
  );
}

function zipTotalLimitError() {
  return zipLimitError(
    `The workbook expands beyond the ${formatMegabytes(MAX_UNCOMPRESSED_BYTES)} local-processing limit.`
  );
}

function zipLimitError(message) {
  const error = new Error(message);
  error.zipLimit = true;
  return error;
}

function findEndOfCentralDirectory(view) {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_SIGNATURE) return offset;
  }
  return -1;
}

function formatMegabytes(bytes) {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
