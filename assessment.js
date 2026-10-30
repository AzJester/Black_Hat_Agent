// Deterministic Black Hat facilitation logic: work areas, participant inputs,
// disagreement and roll-up, structured registers, and input-quality checks. Every
// function here reads workspace records and returns plain data or Markdown lines; none
// of them change the workspace except relinkParticipantInputs(), which only fills
// empty competitor links.

export const SEGMENT_LABELS = Object.freeze([
  "Heavyweight / volume threat",
  "Incumbent / legacy threat",
  "Wildcard / niche or agile threat"
]);

export const EVIDENCE_BASES = Object.freeze([
  "Documented fact",
  "Summary-stated",
  "Claimed",
  "Inference",
  "Personal experience",
  "Unknown"
]);

// Bases that cannot carry a Confirmed judgment on their own: a competitor's own claim,
// one person's experience, or a recorded absence of evidence.
export const WEAK_BASES = Object.freeze(["Claimed", "Personal experience", "Unknown"]);

export const CONFIDENCE_LEVELS = Object.freeze(["High", "Medium", "Low"]);

export const TEAM_LIKELIHOODS = Object.freeze(["Confirmed", "Likely", "Speculative", "Unknown"]);

const BASIS_TO_CLASSIFICATION = Object.freeze({
  "Documented fact": "Confirmed",
  "Summary-stated": "Inference",
  Claimed: "Hypothesis",
  Inference: "Inference",
  "Personal experience": "Hypothesis",
  Unknown: "Hypothesis"
});

const CLASSIFICATION_TO_BASIS = Object.freeze({
  Confirmed: "Documented fact",
  Inference: "Inference",
  Hypothesis: "Inference",
  Conflicting: "Inference",
  Missing: "Unknown"
});

export const REGISTER_KINDS = Object.freeze({
  ghost: Object.freeze({
    label: "Ghosting bank",
    singular: "ghost",
    title: "Ghost or competitor claim",
    detail: "Evidence to demand",
    response: "Our counter"
  }),
  question: Object.freeze({
    label: "Questions for the room",
    singular: "question",
    title: "Question",
    detail: "Who can answer",
    response: "Answer or current view"
  }),
  risk: Object.freeze({
    label: "Risk register",
    singular: "risk",
    title: "Risk",
    detail: "Category",
    response: "Mitigation"
  }),
  price: Object.freeze({
    label: "Price posture",
    singular: "price posture",
    title: "Cost drivers",
    detail: "Cost or price risk hypothesis",
    response: "Our price response"
  })
});

export const REGISTER_STATUSES = Object.freeze(["Open", "Answered", "Closed"]);
export const RISK_LEVELS = Object.freeze(["High", "Medium", "Low"]);

const CORPORATE_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "lp"
]);

export function classificationForBasis(basis) {
  return BASIS_TO_CLASSIFICATION[basis] || "Hypothesis";
}

export function basisForClassification(classification) {
  return CLASSIFICATION_TO_BASIS[classification] || "Inference";
}

export function normalizeName(value) {
  const tokens = String(value ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1])) tokens.pop();
  return tokens.join(" ");
}

export function workAreaKey(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function splitList(value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item ?? "").trim()).filter(Boolean);
  }
  return String(value ?? "")
    .split(/[\n;,]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

// Work areas are entered one per line; commas are allowed inside a name.
export function parseWorkAreas(value) {
  const lines = Array.isArray(value) ? value : String(value ?? "").split(/\n+/);
  const seen = new Set();
  const areas = [];
  for (const line of lines) {
    const name = String(line ?? "").trim().slice(0, 200);
    const key = workAreaKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    areas.push(name);
  }
  return areas.slice(0, 30);
}

// Returns the pursuit's spelling of a work area when the text names one of them, and
// the trimmed text otherwise so an unlisted value stays visible to the quality checks.
export function resolveWorkArea(value, workAreas = []) {
  const text = String(value ?? "").trim();
  const key = workAreaKey(text);
  if (!key) return "";
  return workAreas.find(area => workAreaKey(area) === key) || text;
}

export function normalizeSegment(value) {
  const text = String(value ?? "").toLowerCase();
  if (!text.trim()) return "";
  if (/heavy|volume/.test(text)) return SEGMENT_LABELS[0];
  if (/incumb|legacy/.test(text)) return SEGMENT_LABELS[1];
  if (/wild|niche|agile/.test(text)) return SEGMENT_LABELS[2];
  return "";
}

export function normalizeBasis(value) {
  const text = String(value ?? "").toLowerCase();
  if (!text.trim()) return "";
  if (/summary/.test(text)) return "Summary-stated";
  if (/claim/.test(text)) return "Claimed";
  if (/personal|experience/.test(text)) return "Personal experience";
  if (/infer|assess|judg/.test(text)) return "Inference";
  if (/document|known|fact|verified|confirmed/.test(text)) return "Documented fact";
  if (/unknown|not found|none/.test(text)) return "Unknown";
  return "";
}

export function normalizeConfidence(value) {
  const text = String(value ?? "").toLowerCase();
  if (/high/.test(text)) return "High";
  if (/med/.test(text)) return "Medium";
  if (/low/.test(text)) return "Low";
  return "";
}

// Matches a free-text company name to one competitor: exact name, then a recorded
// alias, then a unique whole-word prefix ("Anduril" and "Anduril Industries"). A
// misspelling such as "Booze" only matches once it is recorded as an alias.
export function matchCompetitor(name, competitors) {
  const key = normalizeName(name);
  if (!key) return { competitor: null, method: "", ambiguous: false };
  const pick = (matches, method) =>
    matches.length === 1
      ? { competitor: matches[0], method, ambiguous: false }
      : matches.length > 1
        ? { competitor: null, method: "", ambiguous: true }
        : null;
  const byName = pick(
    competitors.filter(item => normalizeName(item.name) === key),
    "name"
  );
  if (byName) return byName;
  const byAlias = pick(
    competitors.filter(item => splitList(item.aliases).some(alias => normalizeName(alias) === key)),
    "alias"
  );
  if (byAlias) return byAlias;
  const byPrefix = pick(
    competitors.filter(item => {
      const candidate = normalizeName(item.name);
      return candidate && (candidate.startsWith(`${key} `) || key.startsWith(`${candidate} `));
    }),
    "prefix"
  );
  return byPrefix || { competitor: null, method: "", ambiguous: false };
}

// Links participant inputs whose competitor name now matches a competitor record, for
// example after an alias is added. Existing links are never changed.
export function relinkParticipantInputs(workspace, pursuitId) {
  const competitors = workspace.competitors.filter(item => item.pursuitId === pursuitId);
  let linked = 0;
  for (const input of workspace.participantInputs || []) {
    if (input.pursuitId !== pursuitId || input.competitorId) continue;
    const match = matchCompetitor(input.competitorName, competitors);
    if (match.competitor) {
      input.competitorId = match.competitor.id;
      linked += 1;
    }
  }
  return linked;
}

export function competitorLabel(input, competitorById) {
  return competitorById.get(input.competitorId)?.name || input.competitorName || "Unnamed competitor";
}

function rankValue(value) {
  const number = Number(value);
  return value !== "" && value !== null && Number.isInteger(number) && number > 0 ? number : null;
}

function workAreaOrder(pursuit, extraNames) {
  const areas = [...(pursuit?.workAreas || [])];
  const keys = new Set(areas.map(workAreaKey));
  for (const name of extraNames) {
    const key = workAreaKey(name);
    if (key && !keys.has(key)) {
      keys.add(key);
      areas.push(name);
    }
  }
  return areas;
}

// Groups participant inputs by work area and competitor, ranks the field with
// reciprocal-rank points (#1 = 1, #2 = 0.5, #3 = 0.33), and lists every disagreement
// between participants so the session can test it rather than average it away.
export function summarizeParticipantInputs(workspace, pursuitId) {
  const pursuit = workspace.pursuits.find(item => item.id === pursuitId);
  const inputs = (workspace.participantInputs || []).filter(item => item.pursuitId === pursuitId);
  const competitors = workspace.competitors.filter(item => item.pursuitId === pursuitId);
  const competitorById = new Map(competitors.map(item => [item.id, item]));
  const actions = workspace.actions.filter(item => item.pursuitId === pursuitId);
  const areaNames = workAreaOrder(
    pursuit,
    inputs.map(item => item.workArea).filter(Boolean)
  );
  if (inputs.some(item => !workAreaKey(item.workArea))) areaNames.push("");

  const areas = areaNames
    .map(workArea => {
      const key = workAreaKey(workArea);
      const rows = inputs
        .filter(item => workAreaKey(item.workArea) === key)
        .slice()
        .sort(
          (a, b) =>
            String(a.participant).localeCompare(String(b.participant)) ||
            (rankValue(a.rank) ?? 99) - (rankValue(b.rank) ?? 99)
        );
      const statsByKey = new Map();
      for (const row of rows) {
        const competitorKey = competitorById.has(row.competitorId)
          ? row.competitorId
          : `name:${normalizeName(row.competitorName)}`;
        if (!statsByKey.has(competitorKey)) {
          statsByKey.set(competitorKey, {
            key: competitorKey,
            competitorId: competitorById.has(row.competitorId) ? row.competitorId : "",
            name: competitorLabel(row, competitorById),
            linked: competitorById.has(row.competitorId),
            mentions: 0,
            firstPicks: 0,
            points: 0,
            picks: []
          });
        }
        const stats = statsByKey.get(competitorKey);
        const rank = rankValue(row.rank);
        stats.mentions += 1;
        if (rank === 1) stats.firstPicks += 1;
        if (rank) stats.points += 1 / rank;
        stats.picks.push({
          inputId: row.id,
          participant: row.participant,
          rank,
          confidence: row.confidence || "",
          segment: row.segment || "",
          basis: row.basis || ""
        });
      }
      const ranked = [...statsByKey.values()]
        .map(item => ({ ...item, points: Math.round(item.points * 100) / 100 }))
        .sort(
          (a, b) =>
            b.firstPicks - a.firstPicks ||
            b.points - a.points ||
            b.mentions - a.mentions ||
            a.name.localeCompare(b.name)
        );
      return {
        workArea,
        rows,
        competitors: ranked,
        top: ranked.slice(0, 2),
        participants: [...new Set(rows.map(item => item.participant).filter(Boolean))],
        disagreements: findDisagreements(workArea, ranked),
        gaps: rows
          .filter(item => String(item.gap || "").trim())
          .map(item => ({
            participant: item.participant,
            competitor: competitorLabel(item, competitorById),
            text: item.gap
          })),
        actions: actions.filter(item => key && workAreaKey(item.workArea) === key)
      };
    })
    .filter(area => area.rows.length || area.workArea);

  return {
    areas,
    totalInputs: inputs.length,
    participants: [...new Set(inputs.map(item => item.participant).filter(Boolean))].sort(),
    unmatched: inputs.filter(item => !competitorById.has(item.competitorId))
  };
}

function findDisagreements(workArea, ranked) {
  const label = workArea || "Unassigned work area";
  const disagreements = [];
  const firstPicks = ranked.filter(item => item.firstPicks > 0);
  if (firstPicks.length > 1) {
    disagreements.push({
      type: "first-pick",
      workArea,
      message: `${label}: participants named different #1 competitors: ${firstPicks
        .map(
          item =>
            `${item.name} (${item.picks
              .filter(pick => pick.rank === 1)
              .map(pick => pick.participant)
              .join(", ")})`
        )
        .join("; ")}.`
    });
  }
  for (const item of ranked) {
    const ranks = item.picks.filter(pick => pick.rank);
    const best = ranks.filter(pick => pick.rank === 1);
    const low = ranks.filter(pick => pick.rank >= 3);
    if (best.length && low.length) {
      disagreements.push({
        type: "rank-spread",
        workArea,
        competitor: item.name,
        message: `${label}: ${item.name} is ranked #1 by ${best
          .map(pick => pick.participant)
          .join(", ")} and ${low.map(pick => `#${pick.rank} by ${pick.participant}`).join(", ")}.`
      });
    }
    const highs = item.picks.filter(pick => pick.confidence === "High");
    const lows = item.picks.filter(pick => pick.confidence === "Low");
    if (highs.length && lows.length) {
      disagreements.push({
        type: "confidence-split",
        workArea,
        competitor: item.name,
        message: `${label}: confidence in ${item.name} is High for ${highs
          .map(pick => pick.participant)
          .join(", ")} and Low for ${lows.map(pick => pick.participant).join(", ")}.`
      });
    }
    const segments = [...new Set(item.picks.map(pick => pick.segment).filter(Boolean))];
    if (segments.length > 1) {
      disagreements.push({
        type: "label-split",
        workArea,
        competitor: item.name,
        message: `${label}: ${item.name} carries different labels: ${segments
          .map(
            segment =>
              `${segment} (${item.picks
                .filter(pick => pick.segment === segment)
                .map(pick => pick.participant)
                .join(", ")})`
          )
          .join("; ")}.`
      });
    }
  }
  return disagreements;
}

function shingles(text, size = 3) {
  const words = String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
  const set = new Set();
  for (let index = 0; index + size <= words.length; index += 1) {
    set.add(words.slice(index, index + size).join(" "));
  }
  return set;
}

// Share of the text's three-word phrases that also appear in the reference text.
export function textContainment(text, reference) {
  const source = shingles(text);
  if (source.size < 5) return 0;
  const target = shingles(reference);
  let shared = 0;
  for (const item of source) if (target.has(item)) shared += 1;
  return shared / source.size;
}

function sameParticipant(a, b) {
  const left = normalizeName(a).split(" ").filter(Boolean);
  const right = normalizeName(b).split(" ").filter(Boolean);
  if (!left.length || !right.length) return false;
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  // "Chris" matches "Christopher Leslie"; a nickname that is not a prefix ("Dave" for
  // "David") does not, so the check errs toward reporting a missing input.
  return shorter.every(token =>
    longer.some(other => other === token || (token.length >= 3 && other.startsWith(token)))
  );
}

// Deterministic checks on the inputs a Black Hat depends on. Findings are warnings
// (the judgment may be wrong or unsupported as recorded) or info (a gap worth closing).
// `participants` is the session's participant list; anyone on it without an input is
// reported.
export function assessInputQuality(workspace, pursuitId, { participants = "" } = {}) {
  const findings = [];
  const add = (severity, code, area, message, recordType = "", recordId = "") =>
    findings.push({ severity, code, area, message, recordType, recordId });
  const pursuit = workspace.pursuits.find(item => item.id === pursuitId);
  const workAreas = pursuit?.workAreas || [];
  const workAreaKeys = new Set(workAreas.map(workAreaKey));
  const competitors = workspace.competitors.filter(item => item.pursuitId === pursuitId);
  const competitorById = new Map(competitors.map(item => [item.id, item]));
  const inputs = (workspace.participantInputs || []).filter(item => item.pursuitId === pursuitId);
  const evidence = workspace.evidence.filter(item => item.pursuitId === pursuitId);
  const evidenceById = new Map(evidence.map(item => [item.id, item]));
  const exampleText = String(pursuit?.exampleText || "");

  for (const input of inputs) {
    const who = input.participant || "Unnamed participant";
    const name = competitorLabel(input, competitorById);
    const where = input.workArea || "no work area";
    if (!competitorById.has(input.competitorId)) {
      add(
        "warning",
        "unmatched-competitor",
        "Participant inputs",
        `"${input.competitorName || "(blank)"}" from ${who} does not match a competitor record. Add it as an alias on the right competitor, or add the competitor.`,
        "participantInputs",
        input.id
      );
    }
    if (workAreaKeys.size && !workAreaKeys.has(workAreaKey(input.workArea))) {
      add(
        "warning",
        "unlisted-work-area",
        "Participant inputs",
        `${who} assessed ${name} under "${input.workArea || "(blank)"}", which is not one of this pursuit's work areas.`,
        "participantInputs",
        input.id
      );
    }
    const source = String(input.source || "").trim();
    if (
      input.confidence === "High" &&
      ["Personal experience", "Unknown", ""].includes(input.basis || "") &&
      !source
    ) {
      add(
        "warning",
        "high-confidence-unsourced",
        "Participant inputs",
        `${who} rates ${name} (${where}) High confidence on ${
          input.basis ? input.basis.toLowerCase() : "an unstated basis"
        } with no cited source. Treat it as a hypothesis until someone can point to a record.`,
        "participantInputs",
        input.id
      );
    } else if (["Documented fact", "Summary-stated"].includes(input.basis) && !source) {
      add(
        "warning",
        "missing-source",
        "Participant inputs",
        `${who} labels the ${name} assessment (${where}) ${input.basis.toLowerCase()} but cites no file and locator.`,
        "participantInputs",
        input.id
      );
    }
    if (!input.basis) {
      add(
        "info",
        "missing-basis",
        "Participant inputs",
        `${who}'s ${name} assessment (${where}) does not say whether it rests on documented fact, a summary, inference, or personal experience.`,
        "participantInputs",
        input.id
      );
    }
    const competitor = competitorById.get(input.competitorId);
    if (input.segment === SEGMENT_LABELS[1] && competitor && !competitor.incumbent) {
      add(
        "warning",
        "incumbent-label",
        "Participant inputs",
        `${who} labels ${competitor.name} "${SEGMENT_LABELS[1]}" (${where}), but the competitor record is not marked as an incumbent. The label needs direct performance on the predecessor order, or a predecessor-vehicle seat with meaningful order activity.`,
        "participantInputs",
        input.id
      );
    }
    if (exampleText && textContainment(input.rationale, exampleText) >= 0.6) {
      add(
        "warning",
        "template-text",
        "Participant inputs",
        `${who}'s ${name} assessment (${where}) repeats the worksheet's example response. Confirm it is the participant's own judgment.`,
        "participantInputs",
        input.id
      );
    }
    if (!String(input.gap || "").trim()) {
      add(
        "info",
        "missing-gap",
        "Participant inputs",
        `${who}'s ${name} assessment (${where}) does not say what evidence would change it.`,
        "participantInputs",
        input.id
      );
    }
  }

  // The same rationale from two different people.
  const byText = new Map();
  for (const input of inputs) {
    const text = String(input.rationale || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
    if (text.split(" ").length < 12) continue;
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text).push(input);
  }
  for (const group of byText.values()) {
    const people = [...new Set(group.map(item => item.participant))];
    if (people.length > 1) {
      add(
        "warning",
        "duplicate-text",
        "Participant inputs",
        `${people.join(", ")} submitted identical rationale text. Check whether one copied the other or a shared source.`,
        "participantInputs",
        group[0].id
      );
    }
  }

  // One participant contradicting themselves.
  const byPick = new Map();
  for (const input of inputs) {
    const key = [
      normalizeName(input.participant),
      workAreaKey(input.workArea),
      competitorById.has(input.competitorId)
        ? input.competitorId
        : normalizeName(input.competitorName)
    ].join("\u0000");
    if (!byPick.has(key)) byPick.set(key, []);
    byPick.get(key).push(input);
  }
  for (const group of byPick.values()) {
    const confidences = [...new Set(group.map(item => item.confidence).filter(Boolean))];
    if (group.length > 1 && confidences.length > 1) {
      add(
        "warning",
        "inconsistent-confidence",
        "Participant inputs",
        `${group[0].participant} recorded ${competitorLabel(group[0], competitorById)} (${
          group[0].workArea || "no work area"
        }) more than once with different confidence: ${confidences.join(" and ")}.`,
        "participantInputs",
        group[0].id
      );
    }
  }
  const byRank = new Map();
  for (const input of inputs) {
    const rank = rankValue(input.rank);
    if (!rank) continue;
    const key = `${normalizeName(input.participant)}\u0000${workAreaKey(input.workArea)}\u0000${rank}`;
    if (!byRank.has(key)) byRank.set(key, []);
    byRank.get(key).push(input);
  }
  for (const group of byRank.values()) {
    if (group.length > 1) {
      add(
        "warning",
        "duplicate-rank",
        "Participant inputs",
        `${group[0].participant} ranked ${group
          .map(item => competitorLabel(item, competitorById))
          .join(" and ")} both #${group[0].rank} in ${group[0].workArea || "no work area"}.`,
        "participantInputs",
        group[0].id
      );
    }
  }

  for (const name of splitList(participants)) {
    if (!inputs.some(input => sameParticipant(input.participant, name))) {
      add(
        "warning",
        "no-input",
        "Participant inputs",
        `No assessment is recorded from ${name}.`
      );
    }
  }

  for (const item of evidence) {
    if (item.basis === "Documented fact" && !String(item.locator || "").trim() && !item.url) {
      add(
        "info",
        "evidence-locator",
        "Evidence",
        `[${item.citation}] ${item.title} is labeled documented fact but has no locator or URL.`,
        "evidence",
        item.id
      );
    }
  }

  for (const criterion of workspace.criteria.filter(item => item.pursuitId === pursuitId)) {
    const linked = (criterion.evidenceIds || []).map(id => evidenceById.get(id)).filter(Boolean);
    if (
      criterion.classification === "Confirmed" &&
      linked.length &&
      linked.every(item => WEAK_BASES.includes(item.basis))
    ) {
      add(
        "warning",
        "weak-confirmation",
        "Criteria",
        `${criterion.name} is classified Confirmed, but every linked source is a claim, personal experience, or unknown. Scoring treats it as Inference.`,
        "criteria",
        criterion.id
      );
    }
  }

  for (const action of workspace.actions.filter(item => item.pursuitId === pursuitId)) {
    if (action.status === "Complete") continue;
    const missing = [
      !String(action.owner || "").trim() && "owner",
      !String(action.due || "").trim() && "due date",
      !String(action.evidencePath || "").trim() && "evidence path"
    ].filter(Boolean);
    if (missing.length) {
      add(
        "warning",
        "action-incomplete",
        "Actions",
        `Open action "${action.title}" has no ${missing.join(", ")}. Close the session only when each material issue has an owner, a due date, and an evidence path.`,
        "actions",
        action.id
      );
    }
  }

  for (const item of (workspace.registerItems || []).filter(
    record => record.pursuitId === pursuitId
  )) {
    if (item.kind === "risk" && !String(item.response || "").trim()) {
      add("info", "risk-mitigation", "Registers", `Risk "${item.title}" has no mitigation.`, "registerItems", item.id);
    }
    if (item.kind === "ghost" && !String(item.detail || "").trim()) {
      add(
        "info",
        "ghost-evidence",
        "Registers",
        `Ghost "${item.title}" does not say what evidence to demand.`,
        "registerItems",
        item.id
      );
    }
    if (item.kind === "question" && item.status !== "Closed" && !String(item.detail || "").trim()) {
      add(
        "info",
        "question-owner",
        "Registers",
        `Question "${item.title}" does not say who can answer it.`,
        "registerItems",
        item.id
      );
    }
  }

  const order = { warning: 0, info: 1 };
  return groupRepeatedNotes(findings).sort((a, b) => order[a.severity] - order[b.severity]);
}

// A worksheet without a basis or gap column would otherwise produce one note per row.
const GROUPED_NOTES = Object.freeze({
  "missing-basis": count =>
    `${count} participant inputs do not say whether they rest on documented fact, a summary, inference, or personal experience`,
  "missing-gap": count => `${count} participant inputs do not say what evidence would change them`
});

function groupRepeatedNotes(findings) {
  const output = [];
  for (const finding of findings) {
    const describe = GROUPED_NOTES[finding.code];
    const group = describe ? findings.filter(item => item.code === finding.code) : [];
    if (group.length <= 3) {
      output.push(finding);
      continue;
    }
    if (group[0] !== finding) continue;
    output.push({
      ...finding,
      recordId: "",
      count: group.length,
      message: `${describe(group.length)}.`
    });
  }
  return output;
}

export function registerItemsFor(workspace, pursuitId, kind) {
  return (workspace.registerItems || []).filter(
    item => item.pursuitId === pursuitId && item.kind === kind
  );
}

// Markdown table cells cannot contain a pipe or a line break.
export function tableCell(value, fallback = "") {
  const text = String(value ?? "")
    .replace(/\|/g, "/")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
  return text || fallback;
}

export function markdownTable(headers, rows) {
  return [
    `| ${headers.map(item => tableCell(item)).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map(row => `| ${row.map(item => tableCell(item, "-")).join(" | ")} |`)
  ].join("\n");
}

function pickSummary(item) {
  return item.picks
    .map(
      pick =>
        `${pick.participant}${pick.rank ? ` #${pick.rank}` : ""}${
          pick.confidence ? ` (${pick.confidence})` : ""
        }`
    )
    .join(", ");
}

export function participantReportLines(summary) {
  if (!summary.totalInputs) {
    return [
      "No participant inputs have been recorded. Add each participant's top competitors per work area, or import the session workbook, so the report can show where the team agrees and where it does not."
    ];
  }
  const lines = [
    `${summary.totalInputs} input${summary.totalInputs === 1 ? "" : "s"} from ${
      summary.participants.length
    } participant${summary.participants.length === 1 ? "" : "s"}: ${summary.participants.join(", ")}.`,
    ""
  ];
  for (const area of summary.areas.filter(item => item.rows.length)) {
    lines.push(`### ${area.workArea || "Unassigned work area"}`);
    lines.push(
      markdownTable(
        ["Participant", "Rank", "Competitor", "Label", "Confidence", "Basis", "Why", "Source", "What changes the view"],
        area.rows.map(row => [
          row.participant,
          rankValue(row.rank) ? `#${row.rank}` : "Unranked",
          row.competitorId
            ? area.competitors.find(item => item.competitorId === row.competitorId)?.name ||
              row.competitorName
            : `${row.competitorName} (unmatched)`,
          row.segment || "None",
          row.confidence || "Not stated",
          row.basis || "Not stated",
          row.rationale,
          row.source,
          row.gap
        ])
      )
    );
    lines.push("");
    lines.push("**Where participants disagree**");
    lines.push(
      ...(area.disagreements.length
        ? area.disagreements.map(item => `- ${item.message}`)
        : ["- No disagreement detected among the recorded inputs."])
    );
    lines.push("");
  }
  return lines;
}

export function rollUpReportLines(summary) {
  const areas = summary.areas.filter(item => item.rows.length || item.workArea);
  if (!areas.length) return ["No work areas or participant inputs are recorded."];
  return [
    "Top two per work area by #1 picks, then reciprocal-rank points (#1 = 1, #2 = 0.5, #3 = 0.33), then mentions. This orders the team's inputs; it is not an award prediction.",
    "",
    markdownTable(
      ["Work area", "Top 2 competitors", "Summary evidence", "Uncertainty and gaps", "Follow-up actions / owner"],
      areas.map(area => [
        area.workArea || "Unassigned",
        area.top.length
          ? area.top
              .map(
                item =>
                  `${item.name}${item.linked ? "" : " (unmatched)"}: ${item.firstPicks} first pick${
                    item.firstPicks === 1 ? "" : "s"
                  }, ${item.points} pts`
              )
              .join("; ")
          : "No inputs",
        area.top.map(item => `${item.name}: ${pickSummary(item)}`).join("; ") || "None",
        [
          ...area.disagreements.map(item => item.message),
          ...area.gaps.map(item => `${item.participant} on ${item.competitor}: ${item.text}`)
        ].join(" ") || "None recorded",
        area.actions.length
          ? area.actions
              .map(item => `${item.title} (${item.owner || "unassigned"}, ${item.due || "no date"})`)
              .join("; ")
          : "None assigned"
      ])
    )
  ];
}

export function registerReportLines(workspace, pursuitId, kind) {
  const meta = REGISTER_KINDS[kind];
  const items = registerItemsFor(workspace, pursuitId, kind);
  const competitorById = new Map(
    workspace.competitors.filter(item => item.pursuitId === pursuitId).map(item => [item.id, item])
  );
  const competitorName = item => competitorById.get(item.competitorId)?.name || "Any";
  if (!items.length) return [`No ${meta.label.toLowerCase()} entries are recorded.`];
  if (kind === "ghost") {
    return [
      markdownTable(
        ["Competitor", meta.title, meta.detail, meta.response],
        items.map(item => [competitorName(item), item.title, item.detail, item.response])
      )
    ];
  }
  if (kind === "question") {
    return [
      markdownTable(
        ["#", "Competitor", meta.title, meta.detail, "Status", meta.response],
        items.map((item, index) => [
          String(index + 1).padStart(2, "0"),
          competitorName(item),
          item.title,
          item.detail,
          item.status || "Open",
          item.response
        ])
      )
    ];
  }
  if (kind === "risk") {
    const rank = { High: 0, Medium: 1, Low: 2 };
    return [
      markdownTable(
        ["Risk", "Level", meta.detail, meta.response, "Owner"],
        items
          .slice()
          .sort((a, b) => (rank[a.level] ?? 3) - (rank[b.level] ?? 3))
          .map(item => [item.title, item.level || "Not rated", item.detail, item.response, item.owner])
      )
    ];
  }
  return [
    markdownTable(
      ["Work area", meta.title, meta.detail, meta.response],
      items.map(item => [item.workArea || "All work areas", item.title, item.detail, item.response])
    )
  ];
}

export function qualityReportLines(findings) {
  if (!findings.length) return ["- No input-quality issues were detected."];
  const warnings = findings.filter(item => item.severity === "warning");
  const info = findings.filter(item => item.severity === "info");
  return [
    `${warnings.length} warning${warnings.length === 1 ? "" : "s"} and ${info.length} note${
      info.length === 1 ? "" : "s"
    }.`,
    "",
    ...warnings.map(item => `- **Warning (${item.area}):** ${item.message}`),
    ...info.map(item => `- Note (${item.area}): ${item.message}`)
  ];
}
