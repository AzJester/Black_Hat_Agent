// Reads a Black Hat competitor summary (.docx) in the browser and turns its inline
// evidence tags, such as [KNOWN · HIGH · AND G17], into evidence records. Only
// word/document.xml is read: no macros, links, images, or embedded objects. The file
// is parsed on this device and discarded; only the extracted records are kept.

export const MAX_SUMMARY_BYTES = 5_000_000;
const MAX_DOCUMENT_XML_BYTES = 20_000_000;
const MAX_ZIP_ENTRIES = 2_000;
const MAX_CLAIM_CHARACTERS = 1_000;
const MAX_RECORDS = 1_000;

const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_SIGNATURE = 0x06054b50;
const ZIP_FLAG_ENCRYPTED = 0x0001;
const ZIP_METHOD_STORED = 0;
const ZIP_METHOD_DEFLATE = 8;

const TAG_PATTERN = /\[(KNOWN|ASSESSED|CLAIMED|UNKNOWN)\b([^\]]{0,200})\]/g;

const TAG_BASIS = Object.freeze({
  KNOWN: "Documented fact",
  ASSESSED: "Inference",
  CLAIMED: "Claimed",
  UNKNOWN: "Unknown"
});

const DEFAULT_CONFIDENCE = Object.freeze({
  KNOWN: "Medium",
  ASSESSED: "Medium",
  CLAIMED: "Low",
  UNKNOWN: "Low"
});

const BASIS_CLASSIFICATION = Object.freeze({
  "Documented fact": "Confirmed",
  Inference: "Inference",
  Claimed: "Hypothesis",
  Unknown: "Hypothesis"
});

// Reads one .docx File or ArrayBuffer and returns the tagged evidence it contains.
export async function readTaggedSummary(input, { sourceName = "" } = {}) {
  const buffer = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  if (buffer.byteLength > MAX_SUMMARY_BYTES) {
    throw new Error(
      `The document is larger than the ${Math.round(MAX_SUMMARY_BYTES / 1_000_000)} MB limit.`
    );
  }
  const xmlBytes = await readZipEntry(buffer, "word/document.xml", MAX_DOCUMENT_XML_BYTES);
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(xmlBytes);
  const blocks = extractDocxBlocks(xml);
  return parseTaggedEvidence(blocks, { sourceName });
}

export async function readZipEntry(buffer, entryName, maxBytes) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new Error("The file is not a Word .docx document.");
  }
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) throw new Error("The document's ZIP directory is malformed.");
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("ZIP64 documents are not supported.");
  }
  if (entryCount > MAX_ZIP_ENTRIES) throw new Error("The document contains too many parts.");
  if (centralOffset + centralSize > view.byteLength) {
    throw new Error("The document's ZIP directory points outside the file.");
  }
  let offset = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
      throw new Error("The document's ZIP directory contains an invalid entry.");
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== entryName) continue;
    if (flags & ZIP_FLAG_ENCRYPTED) throw new Error("Encrypted documents are not supported.");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
      throw new Error("ZIP64 documents are not supported.");
    }
    if (uncompressedSize > maxBytes) throw new Error("The document text is too large to read.");
    if (
      localOffset + 30 > view.byteLength ||
      view.getUint32(localOffset, true) !== ZIP_LOCAL_HEADER_SIGNATURE
    ) {
      throw new Error("The document contains an invalid ZIP entry.");
    }
    const start =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const end = start + compressedSize;
    if (end > view.byteLength) throw new Error("The document's text points outside the file.");
    const data = bytes.slice(start, end);
    if (method === ZIP_METHOD_STORED) {
      if (data.length > maxBytes) throw new Error("The document text is too large to read.");
      return data;
    }
    if (method === ZIP_METHOD_DEFLATE) return inflateRaw(data, maxBytes);
    throw new Error("The document uses an unsupported compression method.");
  }
  throw new Error("The file has no Word document body (word/document.xml).");
}

async function inflateRaw(data, maxBytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This browser cannot decompress Word documents.");
  }
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  const feed = writer.write(data).then(() => writer.close());
  feed.catch(() => {});
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("The document text is too large to read.");
      chunks.push(value);
    }
    await feed;
  } catch (error) {
    if (/too large/.test(error?.message || "")) throw error;
    throw new Error("The document text could not be decompressed.");
  } finally {
    reader.cancel().catch(() => {});
  }
  const output = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.byteLength;
  }
  return output;
}

function findEndOfCentralDirectory(view) {
  const minimum = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimum; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_OF_CENTRAL_SIGNATURE) return offset;
  }
  return -1;
}

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (match, entity) => {
    const lower = entity.toLowerCase();
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "amp") return "&";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
}

// Flattens WordprocessingML into paragraphs and table rows in document order. Text in
// a nested table belongs to the innermost cell, so a claim is never read twice.
export function extractDocxBlocks(xml) {
  const blocks = [];
  const stack = [];
  let paragraph = null;
  let inText = false;
  const tokens = String(xml).match(/<[^>]+>|[^<]+/g) || [];
  for (const token of tokens) {
    if (token[0] !== "<") {
      if (inText && paragraph !== null) paragraph += decodeEntities(token);
      continue;
    }
    const match = /^<(\/?)([\w:]+)[^>]*?(\/?)>$/.exec(token);
    if (!match) continue;
    const [, closing, name, selfClosing] = match;
    if (name === "w:t") {
      inText = !closing && !selfClosing;
    } else if (name === "w:tab" || name === "w:br" || name === "w:cr") {
      if (paragraph !== null) paragraph += " ";
    } else if (name === "w:p") {
      if (selfClosing) continue;
      if (!closing) {
        paragraph = "";
      } else if (paragraph !== null) {
        const text = paragraph.replace(/\s+/g, " ").trim();
        paragraph = null;
        if (!text) continue;
        const cell = stack[stack.length - 1];
        if (cell?.kind === "tc") cell.paragraphs.push(text);
        else blocks.push({ type: "paragraph", text });
      }
    } else if (name === "w:tbl") {
      if (!closing) stack.push({ kind: "tbl" });
      else if (stack[stack.length - 1]?.kind === "tbl") stack.pop();
    } else if (name === "w:tr") {
      if (!closing) stack.push({ kind: "tr", cells: [], paragraphs: [] });
      else if (stack[stack.length - 1]?.kind === "tr") {
        const row = stack.pop();
        if (row.cells.some(Boolean)) {
          blocks.push({ type: "row", cells: row.cells, paragraphs: row.paragraphs });
        }
      }
    } else if (name === "w:tc") {
      if (!closing) stack.push({ kind: "tc", paragraphs: [] });
      else if (stack[stack.length - 1]?.kind === "tc") {
        const cell = stack.pop();
        const row = stack[stack.length - 1];
        if (row?.kind === "tr") {
          row.cells.push(cell.paragraphs.join(" "));
          row.paragraphs.push(cell.paragraphs);
        }
      }
    }
  }
  return blocks;
}

function isHeading(text) {
  if (text.length > 80 || TAG_PATTERN.test(text)) {
    TAG_PATTERN.lastIndex = 0;
    return false;
  }
  TAG_PATTERN.lastIndex = 0;
  const letters = text.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && letters.replace(/[^A-Z]/g, "").length / letters.length >= 0.8;
}

function cleanHeading(text) {
  return text.replace(/[.:]+$/, "").trim();
}

function cleanClaim(text) {
  return text
    .replace(/^[\s•·\-–—*]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_CLAIM_CHARACTERS);
}

function shortTitle(text, words = 14) {
  const parts = text.split(" ");
  const title = parts.slice(0, words).join(" ");
  return (parts.length > words ? `${title}...` : title).slice(0, 180);
}

function parseTag(kind, inner) {
  const parts = String(inner || "")
    .split(/[·•]/)
    .map(item => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let confidence = DEFAULT_CONFIDENCE[kind];
  if (["HIGH", "MEDIUM", "LOW"].includes(parts[0]?.toUpperCase())) {
    confidence = `${parts[0][0].toUpperCase()}${parts[0].slice(1).toLowerCase()}`;
    parts.shift();
  }
  return { kind, basis: TAG_BASIS[kind], confidence, locator: parts.join(" · ") };
}

// Splits tagged text into claims. The text before a tag (back to the previous tag) is
// the claim; consecutive tags with no text between them all belong to that claim.
function claimsInText(text) {
  const claims = [];
  let cursor = 0;
  let current = null;
  TAG_PATTERN.lastIndex = 0;
  for (let match = TAG_PATTERN.exec(text); match; match = TAG_PATTERN.exec(text)) {
    const between = cleanClaim(text.slice(cursor, match.index));
    if (between || !current) {
      current = { text: between, tags: [] };
      claims.push(current);
    }
    current.tags.push(parseTag(match[1], match[2]));
    cursor = match.index + match[0].length;
  }
  return claims.filter(item => item.text);
}

export function parseTaggedEvidence(blocks, { sourceName = "" } = {}) {
  const records = [];
  const counts = { tags: 0, claims: 0, byBasis: {} };
  let heading = "";
  let truncated = false;
  const source = String(sourceName || "Competitor summary").slice(0, 180);
  const addClaims = (text, label) => {
    for (const claim of claimsInText(text)) {
      counts.claims += 1;
      counts.tags += claim.tags.length;
      // One record per distinct basis and confidence; their locators are combined.
      const groups = new Map();
      for (const tag of claim.tags) {
        const key = `${tag.basis}\u0000${tag.confidence}`;
        if (!groups.has(key)) groups.set(key, { ...tag, locators: [] });
        if (tag.locator) groups.get(key).locators.push(tag.locator);
      }
      for (const group of groups.values()) {
        if (records.length >= MAX_RECORDS) {
          truncated = true;
          return;
        }
        counts.byBasis[group.basis] = (counts.byBasis[group.basis] || 0) + 1;
        const context = [heading, label].filter(Boolean).join(" / ");
        records.push({
          title: label ? `${label}: ${shortTitle(claim.text, 10)}`.slice(0, 180) : shortTitle(claim.text),
          source,
          locator: [heading, ...group.locators].filter(Boolean).join(" · ").slice(0, 300),
          type: "Competitor",
          basis: group.basis,
          classification: BASIS_CLASSIFICATION[group.basis],
          confidence: group.confidence,
          stance: "Context",
          note: context ? `${claim.text} (${context})` : claim.text
        });
      }
    }
  };
  for (const block of blocks) {
    if (block.type === "paragraph") {
      if (isHeading(block.text)) {
        heading = cleanHeading(block.text);
        continue;
      }
      addClaims(block.text, "");
      continue;
    }
    const cells = block.cells;
    const cellParagraphs = block.paragraphs || cells.map(cell => [cell]);
    const tagged = cells.map(cell => {
      TAG_PATTERN.lastIndex = 0;
      const found = TAG_PATTERN.test(cell);
      TAG_PATTERN.lastIndex = 0;
      return found;
    });
    if (!tagged.some(Boolean)) {
      // A one-cell box with a heading-style first line ("BOTTOM LINE / ...").
      if (cells.length === 1 && isHeading(cells[0])) heading = cleanHeading(cells[0]);
      continue;
    }
    // In a two-or-more column table, the untagged first cell names the row. A claim and
    // its tags share a paragraph, so each paragraph is read on its own.
    const label = !tagged[0] && cells.length > 1 ? shortTitle(cells[0], 10) : "";
    cellParagraphs.forEach((paragraphs, index) => {
      if (!tagged[index]) return;
      for (const text of paragraphs) {
        if (cells.length === 1 && isHeading(text)) heading = cleanHeading(text);
        else addClaims(text, label);
      }
    });
  }
  return { records, counts, truncated };
}
