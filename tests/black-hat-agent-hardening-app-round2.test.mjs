import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, "..");
const appSource = readFileSync(resolve(rootDir, "app.js"), "utf8");

function functionSource(name) {
  const start = appSource.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name}() is defined in app.js`);
  const rest = appSource.slice(start);
  const end = rest.search(/\n(?:async )?function |\ndocument\.addEventListener|\nwindow\.addEventListener/);
  return end > 0 ? rest.slice(0, end) : rest;
}

function listenerSource(target, type) {
  const start = appSource.indexOf(`${target}.addEventListener("${type}"`);
  assert.ok(start >= 0, `${target} has a ${type} listener`);
  const rest = appSource.slice(start);
  return rest.slice(0, rest.indexOf("\n});") + 4);
}

test("F6: a fragment navigation pushed into a trapped frame never renders the app", () => {
  const popstate = listenerSource("window", "popstate");
  assert.match(
    popstate,
    /addEventListener\("popstate", \(\) => \{(?:\s*\/\/[^\n]*)*\s*if \(frameBlocked\) return;/,
    "the popstate listener bails out before reading the hash when framed"
  );
  assert.ok(
    popstate.indexOf("if (frameBlocked) return;") < popstate.indexOf("render()"),
    "the frame guard precedes the render call"
  );
});

test("F6: render() itself refuses to build the app inside a frame", () => {
  const render = functionSource("render");
  assert.match(
    render,
    /^function render\(\) \{(?:\s*\/\/[^\n]*)*\s*if \(frameBlocked\) \{\s*document\.querySelector\("#app"\)\.textContent = FRAMED_MESSAGE;\s*return;\s*\}/,
    "the guard is the first statement of render()"
  );
  assert.ok(
    render.indexOf("if (frameBlocked) {") < render.indexOf('document.querySelector("#app").innerHTML'),
    "no innerHTML write can precede the frame guard"
  );
});

test("F8: the import wizard records the workspace its plan was built from", () => {
  assert.match(appSource, /^let importPlanBaseline = null;/m);
  const wizardCall = appSource.slice(appSource.indexOf("openLocalImportWizard({"));
  assert.match(
    wizardCall.slice(0, wizardCall.indexOf("});")),
    /getWorkspace: \(\) => \{\s*importPlanBaseline = data;\s*return data;\s*\}/
  );
});

test("F8: applySpreadsheetImport refuses a plan built before a cross-tab refresh or in a frozen tab", () => {
  const apply = functionSource("applySpreadsheetImport");
  const staleGuard = apply.indexOf("if (staleWorkspace) throw new Error(STALE_WORKSPACE_MESSAGE);");
  const baselineGuard = apply.indexOf("if (importPlanBaseline !== data) throw new Error(IMPORT_PLAN_STALE_MESSAGE);");
  const snapshot = apply.indexOf("makeSnapshot(");
  const write = apply.indexOf("data = normalized;");
  assert.ok(staleGuard >= 0, "the frozen-tab guard exists");
  assert.ok(baselineGuard >= 0, "the plan-baseline guard exists");
  assert.ok(staleGuard < snapshot && baselineGuard < snapshot, "both guards run before a snapshot is taken");
  assert.ok(baselineGuard < write, "the baseline guard runs before the workspace is replaced");
  assert.match(appSource, /^const IMPORT_PLAN_STALE_MESSAGE =\s*"[^"]*changed in another tab[^"]*Validate and review[^"]*";/m);
});

test("F8: a cross-tab refresh tells an open wizard to validate again", () => {
  const adopt = functionSource("adoptExternalWorkspace");
  assert.match(adopt, /document\.querySelector\("#localImportWizard"\)\s*\?\s*"Workspace updated from another tab\. Validate the import again before applying it\."/);
  assert.ok(adopt.indexOf("render();") < adopt.indexOf("#localImportWizard"), "the refresh happens before the notice");
});
