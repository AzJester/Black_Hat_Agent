import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";

import {
  SCHEMA_VERSION,
  buildCompetitiveReport,
  calculateCompetitiveScores,
  calculateWorkAreaScores,
  normalizeWorkspace,
  validateWorkspace
} from "../engine.js";
import {
  assessInputQuality,
  matchCompetitor,
  normalizeBasis,
  normalizeName,
  normalizeSegment,
  parseWorkAreas,
  relinkParticipantInputs,
  summarizeParticipantInputs,
  textContainment
} from "../assessment.js";
import { buildImportPlan, buildTableFromMatrix, suggestColumnMapping } from "../import-engine.js";
import { extractDocxBlocks, parseTaggedEvidence, readTaggedSummary } from "../summary-import.js";

const EXAMPLE =
  "Its scale and relevant reach support a heavyweight assessment. Its stated range experience in multi-vendor integration may strengthen its fit for this work area. Whether it will bid broadly remains to be tested.";

function sessionWorkspace() {
  return normalizeWorkspace(
    {
      schemaVersion: SCHEMA_VERSION,
      active: "p1",
      pursuits: [
        {
          id: "p1",
          name: "Synthetic services vehicle",
          customer: "Synthetic agency",
          workAreas: ["Managed Service", "System Integration", "Test Support"],
          exampleText: EXAMPLE
        }
      ],
      criteria: [
        { id: "cr1", pursuitId: "p1", name: "Service delivery", weight: 30, ourScore: 3, classification: "Inference", workArea: "Managed Service", evidenceIds: [] },
        { id: "cr2", pursuitId: "p1", name: "Integration depth", weight: 30, ourScore: 4, classification: "Inference", workArea: "System Integration", evidenceIds: [] },
        { id: "cr3", pursuitId: "p1", name: "Staffing", weight: 40, ourScore: 4, classification: "Inference", workArea: "", evidenceIds: [] }
      ],
      evidence: [],
      competitors: [
        { id: "c1", pursuitId: "p1", name: "Alpha Systems Inc.", aliases: "", classification: "Inference", scores: { cr1: 5, cr2: 3, cr3: 4 }, evidenceIds: [] },
        { id: "c2", pursuitId: "p1", name: "Bravo Allen Group", aliases: "Bravo, Brovo, BAG", classification: "Inference", scores: { cr1: 3, cr2: 5, cr3: 4 }, evidenceIds: [] },
        { id: "c3", pursuitId: "p1", name: "Charlie", aliases: "", incumbent: false, scores: { cr1: 3, cr2: 3, cr3: 3 }, evidenceIds: [] }
      ],
      actions: [],
      playbooks: [],
      runs: [],
      snapshots: []
    },
    {}
  );
}

function input(id, participant, workArea, rank, competitorId, competitorName, extra = {}) {
  return {
    id,
    pursuitId: "p1",
    participant,
    workArea,
    rank,
    competitorId,
    competitorName,
    segment: "",
    confidence: "Medium",
    basis: "Inference",
    rationale: "",
    source: "",
    gap: "Whether it bids.",
    ...extra
  };
}

test("schema 4 adds work areas, participant inputs, and registers with safe defaults", () => {
  const workspace = sessionWorkspace();
  assert.equal(workspace.schemaVersion, 4);
  assert.deepEqual(workspace.participantInputs, []);
  assert.deepEqual(workspace.registerItems, []);
  assert.equal(workspace.pursuits[0].showScenarioEstimate, false);
  assert.deepEqual(workspace.pursuits[0].workAreas, ["Managed Service", "System Integration", "Test Support"]);
  assert.equal(validateWorkspace(workspace).valid, true);

  const broken = structuredClone(workspace);
  broken.participantInputs.push(input("pi1", "", "Test Support", 1, "missing", ""));
  broken.registerItems.push({ id: "rg1", pursuitId: "p1", kind: "rumor", title: "" });
  const errors = validateWorkspace(broken).errors.join("\n");
  assert.match(errors, /requires a participant/);
  assert.match(errors, /missing competitor/);
  assert.match(errors, /unsupported register type/);
  assert.match(errors, /requires a title/);
});

test("legacy evidence gains a basis derived from its classification", () => {
  const workspace = normalizeWorkspace(
    {
      schemaVersion: 3,
      pursuits: [{ id: "p1", name: "P", customer: "C" }],
      criteria: [],
      evidence: [
        { id: "e1", pursuitId: "p1", title: "T", source: "S", classification: "Confirmed", criterionIds: [] },
        { id: "e2", pursuitId: "p1", title: "T2", source: "S", classification: "Hypothesis", criterionIds: [] }
      ],
      competitors: [],
      actions: [],
      playbooks: [],
      runs: [],
      snapshots: []
    },
    {}
  );
  assert.deepEqual(
    workspace.evidence.map(item => item.basis),
    ["Documented fact", "Inference"]
  );
});

test("competitor names match by name, alias, or a unique leading word only", () => {
  const competitors = sessionWorkspace().competitors;
  assert.equal(normalizeName("Alpha Systems, Inc."), "alpha systems");
  assert.equal(matchCompetitor("alpha systems", competitors).competitor.id, "c1");
  assert.equal(matchCompetitor("Brovo", competitors).competitor.id, "c2");
  assert.equal(matchCompetitor("Bravo Allen", competitors).competitor.id, "c2");
  assert.equal(matchCompetitor("Alpha", competitors).method, "prefix");
  assert.equal(matchCompetitor("Charlie Corp", competitors).competitor.id, "c3");
  assert.equal(matchCompetitor("Delta", competitors).competitor, null);
});

test("labels and evidence bases normalize from worksheet spellings", () => {
  assert.equal(normalizeSegment("Heavyweight/Volume Threat"), "Heavyweight / volume threat");
  assert.equal(normalizeSegment("Incumbent/Legacy Threat"), "Incumbent / legacy threat");
  assert.equal(normalizeSegment("Wildcard/Niche or Agile Threat"), "Wildcard / niche or agile threat");
  assert.equal(normalizeBasis("KNOWN"), "Documented fact");
  assert.equal(normalizeBasis("Summary-stated"), "Summary-stated");
  assert.equal(normalizeBasis("Personal experience"), "Personal experience");
  assert.equal(normalizeBasis("ASSESSED"), "Inference");
  assert.deepEqual(parseWorkAreas("A\n\na\nB, with comma"), ["A", "B, with comma"]);
});

test("work-area scores rank each area separately and report ties", () => {
  const workspace = sessionWorkspace();
  const areas = calculateWorkAreaScores(workspace, "p1");
  assert.deepEqual(areas.map(item => item.workArea), ["Managed Service", "System Integration", "Test Support"]);
  assert.equal(areas[0].leader.name, "Alpha Systems Inc.");
  assert.equal(areas[1].leader.name, "Bravo Allen Group");
  assert.equal(areas[2].criteriaCount, 0);
  assert.deepEqual(areas[2].ranking, []);

  workspace.competitors[1].scores.cr1 = 5;
  const tied = calculateWorkAreaScores(workspace, "p1")[0];
  assert.deepEqual(tied.leaders.map(item => item.name).sort(), ["Alpha Systems Inc.", "Bravo Allen Group"]);
  const report = buildCompetitiveReport(workspace, "p1", {});
  assert.match(report.output, /Alpha Systems Inc\. and Bravo Allen Group tie for the lead/);
});

test("participant inputs roll up by work area and surface every disagreement", () => {
  const workspace = sessionWorkspace();
  workspace.participantInputs = [
    input("pi1", "Pat Doe", "Test Support", 1, "c1", "Alpha", { confidence: "High", segment: "Heavyweight / volume threat" }),
    input("pi2", "Pat Doe", "Test Support", 2, "c2", "Bravo"),
    input("pi3", "Lee Roe", "Test Support", 1, "c2", "Bravo"),
    input("pi4", "Lee Roe", "Test Support", 4, "c1", "Alpha", { confidence: "Low", segment: "Wildcard / niche or agile threat" })
  ];
  const summary = summarizeParticipantInputs(workspace, "p1");
  const area = summary.areas.find(item => item.workArea === "Test Support");
  // One first pick each; Bravo's #1 and #2 (1.5 points) beat Alpha's #1 and #4 (1.25).
  assert.deepEqual(area.top.map(item => item.name), ["Bravo Allen Group", "Alpha Systems Inc."]);
  assert.deepEqual(area.top.map(item => item.points), [1.5, 1.25]);
  const types = area.disagreements.map(item => item.type).sort();
  assert.deepEqual(types, ["confidence-split", "first-pick", "label-split", "rank-spread"]);
  assert.match(area.disagreements.find(item => item.type === "rank-spread").message, /#1 by Pat Doe and #4 by Lee Roe/);
});

test("quality checks flag unsourced confidence, label misuse, copied text, and open-action gaps", () => {
  const workspace = sessionWorkspace();
  workspace.participantInputs = [
    input("pi1", "Pat Doe", "Managed Service", 1, "c1", "Alpha", { confidence: "High", basis: "Personal experience" }),
    input("pi2", "Pat Doe", "Managed Service", 2, "c3", "Charlie", { segment: "Incumbent / legacy threat" }),
    input("pi3", "Lee Roe", "Test Support", 1, "c2", "Bravo", { rationale: EXAMPLE }),
    input("pi4", "Lee Roe", "Test Support", 2, "", "Echo Labs"),
    input("pi5", "Lee Roe", "Test Support", 3, "c2", "Bravo", { confidence: "High", source: "Summary p. 2" }),
    input("pi6", "Kim Poe", "Unlisted Area", 1, "c1", "Alpha", { basis: "Documented fact" })
  ];
  workspace.actions.push({ id: "a1", pursuitId: "p1", title: "Confirm staffing", owner: "", due: "", status: "Open", evidencePath: "" });
  const findings = assessInputQuality(workspace, "p1", { participants: "Pat, Lee Roe, Sam Moe" });
  const codes = new Set(findings.map(item => item.code));
  for (const code of [
    "high-confidence-unsourced",
    "incumbent-label",
    "template-text",
    "unmatched-competitor",
    "inconsistent-confidence",
    "unlisted-work-area",
    "missing-source",
    "no-input",
    "action-incomplete"
  ]) {
    assert.ok(codes.has(code), `expected ${code}`);
  }
  assert.equal(findings.filter(item => item.code === "no-input").length, 1);
  assert.match(findings.find(item => item.code === "no-input").message, /Sam Moe/);
  assert.ok(textContainment(EXAMPLE, EXAMPLE) > 0.99);
});

test("a Confirmed judgment backed only by claims or personal experience scores as Inference", () => {
  const workspace = sessionWorkspace();
  workspace.evidence.push({
    id: "e1",
    pursuitId: "p1",
    citation: "E-001",
    title: "Competitor says so",
    source: "Press release",
    basis: "Claimed",
    stance: "Support",
    criterionIds: ["cr1"]
  });
  workspace.criteria[0].evidenceIds = ["e1"];
  workspace.criteria[0].classification = "Confirmed";
  const detail = calculateCompetitiveScores(workspace, "p1").us.details.find(
    item => item.criterionId === "cr1"
  );
  assert.equal(detail.classification, "Inference");
  workspace.evidence[0].basis = "Documented fact";
  assert.equal(
    calculateCompetitiveScores(workspace, "p1").us.details.find(item => item.criterionId === "cr1")
      .classification,
    "Confirmed"
  );
});

test("relinking resolves inputs once a spelling becomes an alias", () => {
  const workspace = sessionWorkspace();
  workspace.participantInputs = [input("pi1", "Pat", "Test Support", 1, "", "Chuck")];
  assert.equal(relinkParticipantInputs(workspace, "p1"), 0);
  workspace.competitors[2].aliases = "Chuck";
  assert.equal(relinkParticipantInputs(workspace, "p1"), 1);
  assert.equal(workspace.participantInputs[0].competitorId, "c3");
});

test("session workbook rows import with fill-down, sheet-order ranks, and name matching", () => {
  const workspace = sessionWorkspace();
  const matrix = [
    ["Participant", "Work Area", "Strongest Competitor", "Rating", "Confidence", "Evidence and Justification", "Gap or What Changes Our View"],
    ["Pat Doe", "managed service", "Alpha Systems", "Heavyweight/Volume Threat", "High", "Runs a service today", "Labor hours"],
    ["", "", "Brovo", "Incumbent/Legacy Threat", "Medium", "Predecessor seat", ""],
    ["Lee Roe", "Test Support", "Echo Labs", "Wildcard/Niche or Agile Threat", "Low", "Niche tool", "Bid intent"]
  ];
  const table = buildTableFromMatrix(matrix, { headerRow: 0 });
  const mapping = suggestColumnMapping("participantInputs", table.headers);
  assert.deepEqual(mapping.missingRequired, []);
  let next = 0;
  const plan = buildImportPlan({
    workspace,
    target: "participantInputs",
    headers: table.headers,
    rows: table.rows,
    mapping: mapping.mapping,
    pursuitId: "p1",
    mode: "append",
    idFactory: () => `pi${++next}`
  });
  assert.equal(plan.valid, true, JSON.stringify(plan.diagnostics));
  const rows = plan.nextWorkspace.participantInputs;
  assert.deepEqual(
    rows.map(item => [item.participant, item.workArea, item.rank, item.competitorId, item.segment]),
    [
      ["Pat Doe", "Managed Service", 1, "c1", "Heavyweight / volume threat"],
      ["Pat Doe", "Managed Service", 2, "c2", "Incumbent / legacy threat"],
      ["Lee Roe", "Test Support", 1, "", "Wildcard / niche or agile threat"]
    ]
  );
  const codes = plan.diagnostics.map(item => item.code);
  assert.ok(codes.includes("filled_down"));
  assert.ok(codes.includes("unmatched_competitor"));

  const again = buildImportPlan({
    workspace: plan.nextWorkspace,
    target: "participantInputs",
    headers: table.headers,
    rows: table.rows,
    mapping: mapping.mapping,
    pursuitId: "p1",
    mode: "append",
    idFactory: () => `pj${++next}`
  });
  assert.equal(again.summary.skipped, 3);
});

test("an imported evidence basis sets the scoring classification", () => {
  const workspace = sessionWorkspace();
  const table = buildTableFromMatrix(
    [
      ["Title", "Source", "Basis", "Locator"],
      ["Claimed capability", "Brochure", "CLAIMED", "p. 4"],
      ["Contract record", "FPDS", "Known", "PIID 123"]
    ],
    { headerRow: 0 }
  );
  const plan = buildImportPlan({
    workspace,
    target: "evidence",
    headers: table.headers,
    rows: table.rows,
    mapping: suggestColumnMapping("evidence", table.headers).mapping,
    pursuitId: "p1",
    mode: "append",
    idFactory: (() => {
      let n = 0;
      return () => `ev${++n}`;
    })()
  });
  assert.equal(plan.valid, true, JSON.stringify(plan.diagnostics));
  assert.deepEqual(
    plan.nextWorkspace.evidence.map(item => [item.basis, item.classification, item.locator]),
    [
      ["Claimed", "Hypothesis", "p. 4"],
      ["Documented fact", "Confirmed", "PIID 123"]
    ]
  );
});

test("the report leads with work areas and includes the Black Hat registers and checks", () => {
  const workspace = sessionWorkspace();
  workspace.participantInputs = [input("pi1", "Pat", "Managed Service", 1, "c1", "Alpha")];
  workspace.registerItems = [
    { id: "rg1", pursuitId: "p1", kind: "ghost", competitorId: "c1", title: "We are cheaper | always", detail: "Full labor basis", response: "Realism case", status: "Open" },
    { id: "rg2", pursuitId: "p1", kind: "question", competitorId: "c2", title: "Has Bravo run a red team?", detail: "Range staff", status: "Open" },
    { id: "rg3", pursuitId: "p1", kind: "risk", title: "Teaming rights", detail: "Teaming", level: "High", response: "Sign terms", owner: "Legal", status: "Open" },
    { id: "rg4", pursuitId: "p1", kind: "price", workArea: "Managed Service", title: "Operators on site", detail: "Low bid on staffing", response: "Price realism", status: "Open" }
  ];
  workspace.actions.push({ id: "a1", pursuitId: "p1", title: "Verify teaming", owner: "CM", due: "2026-11-01", status: "Open", priority: "High", evidencePath: "", workArea: "" });
  workspace.competitors[0].mostLikelyPlay = "Prime where it owns the product.";
  workspace.competitors[0].mostDangerousPlay = "Buy the missing analysts.";
  assert.equal(validateWorkspace(workspace).valid, true, validateWorkspace(workspace).errors.join("\n"));
  const report = buildCompetitiveReport(workspace, "p1", { participants: "Pat" });
  const output = report.output;
  assert.ok(output.indexOf("## 4. Work-area comparison") < output.indexOf("## 8. Weighted scoring matrix"));
  for (const heading of [
    "Participant assessments and disagreement",
    "Work-area roll-up",
    "Ghosting bank",
    "Price posture by work area",
    "Questions for the room",
    "Input quality checks"
  ]) {
    assert.match(output, new RegExp(`## \\d+\\. ${heading}`));
  }
  assert.match(output, /Most dangerous play: Buy the missing analysts\./);
  assert.match(output, /We are cheaper \/ always/, "pipes in table cells are neutralized");
  assert.match(output, /evidence path: not set/);
  assert.match(output, /Open action "Verify teaming" has no evidence path/);
  assert.match(output, /Scenario win estimate:\*\* Off/);
});

// A minimal stored-or-deflated ZIP writer, enough to build .docx fixtures in memory.
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of entries) {
    const nameBytes = Buffer.from(name);
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  const buffer = Buffer.concat([...locals, centralBuffer, end]);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

const paragraph = text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell = text => `<w:tc>${paragraph(text)}</w:tc>`;

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="x"><w:body>
${paragraph("WHAT THEY DO WELL.")}
<w:tbl>
<w:tr>${cell("STRENGTH")}${cell("EVIDENCE")}</w:tr>
<w:tr>${cell("Common C2")}${cell("Selected as common C2 &amp; obligated $142M. [KNOWN · HIGH · AND G14] [KNOWN · MEDIUM · AND P15] Strongest line is integration. [ASSESSED · MEDIUM · AND G27]")}</w:tr>
</w:tbl>
${paragraph("WHERE THEY ARE VULNERABLE.")}
<w:tbl><w:tr><w:tc>${paragraph("BOTTOM LINE / THE CONTEST")}${paragraph("• Reports about 7,000 staff. [CLAIMED · AND C20]")}${paragraph("• No red-team record found. [UNKNOWN · searched FPDS · AND G08]")}</w:tc></w:tr></w:tbl>
</w:body></w:document>`;

test("tagged summary text becomes evidence records with basis, confidence, and locator", () => {
  const blocks = extractDocxBlocks(DOCUMENT_XML);
  const result = parseTaggedEvidence(blocks, { sourceName: "Alpha summary" });
  assert.equal(result.counts.tags, 5);
  assert.equal(result.counts.claims, 4);
  assert.deepEqual(
    result.records.map(item => [item.basis, item.confidence, item.locator]),
    [
      ["Documented fact", "High", "WHAT THEY DO WELL · AND G14"],
      ["Documented fact", "Medium", "WHAT THEY DO WELL · AND P15"],
      ["Inference", "Medium", "WHAT THEY DO WELL · AND G27"],
      ["Claimed", "Low", "BOTTOM LINE / THE CONTEST · AND C20"],
      ["Unknown", "Low", "BOTTOM LINE / THE CONTEST · searched FPDS · AND G08"]
    ]
  );
  assert.match(result.records[0].title, /^Common C2: Selected as common C2 & obligated/);
  assert.equal(result.records[0].classification, "Confirmed");
  assert.equal(result.records[3].note, "Reports about 7,000 staff. (BOTTOM LINE / THE CONTEST)");
});

test("a .docx summary is read from its ZIP container and malformed files are refused", async () => {
  const result = await readTaggedSummary(zip([["word/document.xml", DOCUMENT_XML]]), {
    sourceName: "Alpha"
  });
  assert.equal(result.records.length, 5);
  await assert.rejects(
    readTaggedSummary(new TextEncoder().encode("not a zip").buffer),
    /not a Word \.docx/
  );
  await assert.rejects(
    readTaggedSummary(zip([["word/other.xml", DOCUMENT_XML]])),
    /no Word document body/
  );
  await assert.rejects(readTaggedSummary(new ArrayBuffer(5_000_001)), /larger than/);
});
