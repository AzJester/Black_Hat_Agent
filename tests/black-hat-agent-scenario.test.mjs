import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompetitiveReport,
  calculateCompetitiveScores,
  normalizeWorkspace
} from "../engine.js";

function scoredWorkspace(priorEstimate) {
  return {
    schemaVersion: 2,
    appVersion: "2.0.0",
    active: "p1",
    pursuits: [
      {
        id: "p1",
        name: "Scenario pursuit",
        customer: "Scenario customer",
        playbook: "Competitive assessment",
        priorEstimate,
        showScenarioEstimate: true,
        archived: false
      }
    ],
    criteria: [
      {
        id: "cr1",
        pursuitId: "p1",
        name: "Technical merit",
        weight: 60,
        ourScore: 5,
        classification: "Confirmed",
        evidenceIds: ["e1"],
        isGate: true
      },
      {
        id: "cr2",
        pursuitId: "p1",
        name: "Price",
        weight: 40,
        ourScore: 2,
        classification: "Hypothesis",
        evidenceIds: [],
        isGate: false
      }
    ],
    evidence: [
      {
        id: "e1",
        pursuitId: "p1",
        title: "Technical proof",
        source: "Source",
        url: "",
        confidence: "High",
        classification: "Confirmed",
        stance: "Support",
        note: "",
        criterionIds: ["cr1"]
      }
    ],
    competitors: [
      {
        id: "co1",
        pursuitId: "p1",
        name: "Competitor One",
        position: "Challenger",
        classification: "Hypothesis",
        evidenceIds: ["e1"],
        scores: { cr1: 3, cr2: 4 }
      }
    ],
    actions: [],
    playbooks: [
      {
        id: "pb1",
        name: "Competitive assessment",
        description: "Test playbook",
        sections: "Full report",
        builtIn: true
      }
    ],
    runs: [],
    snapshots: []
  };
}

function scoresFor(priorEstimate) {
  return calculateCompetitiveScores(scoredWorkspace(priorEstimate), "p1");
}

function assertBounded(estimate) {
  assert.ok(estimate, "scenario estimate should be produced");
  for (const key of ["value", "low", "high", "prior", "trust"]) {
    assert.ok(Number.isFinite(estimate[key]), `${key} must be finite, got ${estimate[key]}`);
  }
  assert.ok(estimate.value >= 5 && estimate.value <= 95, `value ${estimate.value} out of [5,95]`);
  assert.ok(estimate.low >= 0 && estimate.low <= estimate.value);
  assert.ok(estimate.high <= 100 && estimate.high >= estimate.value);
  assert.ok(estimate.prior >= 5 && estimate.prior <= 95, `prior ${estimate.prior} out of [5,95]`);
}

test("non-numeric priorEstimate falls back to a prior of 50 and stays bounded", () => {
  const scores = scoresFor("high");
  assertBounded(scores.scenarioEstimate);
  assert.equal(scores.scenarioEstimate.prior, 50);
  assert.deepEqual(scores.scenarioEstimate, scoresFor(50).scenarioEstimate);
});

test("a priorEstimate of 0 clamps to the floor instead of becoming 50", () => {
  const scores = scoresFor(0);
  assertBounded(scores.scenarioEstimate);
  assert.equal(scores.scenarioEstimate.prior, 5);
  assert.notEqual(scores.scenarioEstimate.prior, 50);
  assert.deepEqual(scores.scenarioEstimate, scoresFor(5).scenarioEstimate);
});

test("negative, NaN, Infinity and huge priors are clamped or defaulted", () => {
  const cases = [
    [-40, 5],
    [Number.NaN, 50],
    ["NaN", 50],
    [Number.POSITIVE_INFINITY, 50],
    [Number.NEGATIVE_INFINITY, 50],
    ["Infinity", 50],
    [1e9, 95],
    [99999, 95],
    [null, 50],
    [undefined, 50],
    ["", 50],
    ["   ", 50],
    ["62", 62],
    [true, 5]
  ];
  for (const [input, expectedPrior] of cases) {
    const scores = scoresFor(input);
    assertBounded(scores.scenarioEstimate);
    assert.equal(
      scores.scenarioEstimate.prior,
      expectedPrior,
      `prior for ${String(input)} should be ${expectedPrior}`
    );
  }
});

test("normalizeWorkspace coerces priorEstimate to a finite number in [5,95]", () => {
  const cases = [
    ["high", 50],
    [0, 5],
    [-1, 5],
    [Number.NaN, 50],
    [Number.POSITIVE_INFINITY, 50],
    [1e12, 95],
    [null, 50],
    [undefined, 50],
    ["", 50],
    ["42", 42],
    [42.5, 42.5],
    [95, 95],
    [5, 5]
  ];
  for (const [input, expected] of cases) {
    const workspace = normalizeWorkspace(scoredWorkspace(input), {});
    const prior = workspace.pursuits[0].priorEstimate;
    assert.equal(typeof prior, "number");
    assert.ok(Number.isFinite(prior));
    assert.equal(prior, expected, `normalized prior for ${String(input)} should be ${expected}`);
  }
});

test("normalizeWorkspace keeps pursuits that omit priorEstimate at the 50 default", () => {
  const source = scoredWorkspace(50);
  delete source.pursuits[0].priorEstimate;
  const workspace = normalizeWorkspace(source, {});
  assert.equal(workspace.pursuits[0].priorEstimate, 50);
});

test("object-valued priors from a hostile workspace file default instead of throwing", () => {
  // JSON can produce objects whose own toString/valueOf are not callable; coercing
  // those with Number()/String() throws, which must not take the import down.
  const hostile = [JSON.parse('{"toString":1}'), JSON.parse('{"valueOf":{}}'), {}, [7]];
  for (const input of hostile) {
    const workspace = normalizeWorkspace(scoredWorkspace(input), {});
    assert.equal(workspace.pursuits[0].priorEstimate, 50);
    const scores = scoresFor(input);
    assertBounded(scores.scenarioEstimate);
    assert.equal(scores.scenarioEstimate.prior, 50);
  }
});

test("report scenario line never contains NaN for bad priors", () => {
  const badPriors = ["high", Number.NaN, "NaN", Number.POSITIVE_INFINITY, -50, 1e9, 0, "", null];
  for (const prior of badPriors) {
    const report = buildCompetitiveReport(scoredWorkspace(prior), "p1", {
      facilitator: "Facilitator",
      participants: "Team"
    });
    assertBounded(report.scoreSummary.scenarioEstimate);
    assert.equal(typeof report.output, "string");
    assert.doesNotMatch(report.output, /NaN/, `report for prior ${String(prior)} contains NaN`);
    const line = report.output.match(/\*\*Scenario win estimate:\*\* (\d+)% \((\d+)-(\d+)% uncertainty range/);
    assert.ok(line, `report for prior ${String(prior)} should print a numeric scenario line`);
    const [, value, low, high] = line.map(Number);
    assert.ok(value >= 5 && value <= 95);
    assert.ok(low >= 0 && low <= value && high >= value && high <= 100);
  }
});

test("report scenario line survives a normalized workspace round trip", () => {
  const workspace = normalizeWorkspace(scoredWorkspace("high"), {});
  const report = buildCompetitiveReport(workspace, "p1", {});
  assertBounded(report.scoreSummary.scenarioEstimate);
  assert.doesNotMatch(report.output, /NaN/);
  assert.match(report.output, /\*\*Scenario win estimate:\*\* \d+% \(\d+-\d+% uncertainty range/);
});

test("the report keeps the scenario estimate off unless the pursuit enables it", () => {
  const workspace = scoredWorkspace(60);
  delete workspace.pursuits[0].showScenarioEstimate;
  const normalized = normalizeWorkspace(workspace, {});
  assert.equal(normalized.pursuits[0].showScenarioEstimate, false);
  const report = buildCompetitiveReport(normalized, "p1", {});
  assert.match(report.output, /\*\*Scenario win estimate:\*\* Off for this pursuit/);
  assert.doesNotMatch(report.output, /\d+% uncertainty range/);
  assert.equal(report.showScenarioEstimate, false);
  // The estimate is still calculated, so report-time visual snapshots stay consistent.
  assertBounded(report.scoreSummary.scenarioEstimate);
});
