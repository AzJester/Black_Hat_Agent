import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, "..");
const appSource = readFileSync(resolve(rootDir, "app.js"), "utf8");
const {
  SCHEMA_VERSION,
  normalizeWorkspace,
  validateWorkspace,
  validateWorkspaceImport,
  validateWorkspaceSnapshot
} = await import(pathToFileURL(resolve(rootDir, "engine.js")).href);

function functionSource(name) {
  const start = appSource.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name}() is defined in app.js`);
  const rest = appSource.slice(start);
  const end = rest.search(/\n(?:async )?function |\ndocument\.addEventListener|\nwindow\.addEventListener|\n\/\/ /);
  return end > 0 ? rest.slice(0, end) : rest;
}

// app.js is a browser module with DOM side effects, so the seed literal and the
// emptyWorkspace() factory are evaluated from source with the engine in scope.
function seedFromSource() {
  const start = appSource.indexOf("const seed = {");
  const end = appSource.indexOf("\n};", start) + 3;
  assert.ok(start >= 0 && end > start, "the seed literal is present");
  return new Function("SCHEMA_VERSION", `${appSource.slice(start, end)}\nreturn seed;`)(SCHEMA_VERSION);
}

function emptyWorkspaceFromSource() {
  const seed = seedFromSource();
  return new Function(
    "normalizeWorkspace",
    "seed",
    "SCHEMA_VERSION",
    `${functionSource("emptyWorkspace")}\nreturn emptyWorkspace();`
  )(normalizeWorkspace, seed, SCHEMA_VERSION);
}

test("the load fallback never opens the demonstration: nothing stored and an unreadable value both start empty", () => {
  const load = functionSource("loadWorkspace");
  assert.doesNotMatch(load, /normalizeWorkspace\(seed, seed\)/, "the seed is never the fallback");
  assert.match(load, /if \(!raw\) return emptyWorkspace\(\);/, "nothing stored starts empty");
  assert.match(load, /catch \(error\) \{[\s\S]*return emptyWorkspace\(\);\s*\}\s*\}\s*$/, "an unreadable value starts empty");
  assert.match(load, /preserveUnreadableCopy\(raw\)/, "the unreadable value is set aside");
  assert.match(load, /UNREADABLE_NOT_KEPT_MESSAGE/, "a failed preservation still warns");
  assert.doesNotMatch(load, /localStorage\.setItem/, "the load path writes nothing itself");
  assert.doesNotMatch(load, /localStorage\.removeItem/, "the load path removes nothing");
  assert.equal(
    (appSource.match(/normalizeWorkspace\(seed, seed\)/g) || []).length,
    1,
    "the only place the seed becomes the workspace is the on-demand demonstration load"
  );
  assert.match(appSource, /dataset\.action === "load-demo"\) \{[\s\S]*?data = normalizeWorkspace\(seed, seed\);/);
  assert.doesNotMatch(appSource, /reset-demo|Reset demo/);
  assert.match(functionSource("header"), /data-action="load-demo">Load demonstration workspace</);
});

test("emptyWorkspace() is schema-valid, holds only the built-in playbooks, and has no active pursuit", () => {
  const seed = seedFromSource();
  const workspace = emptyWorkspaceFromSource();
  assert.equal(workspace.schemaVersion, SCHEMA_VERSION);
  assert.equal(workspace.active, "");
  for (const collection of ["pursuits", "criteria", "evidence", "competitors", "actions", "runs", "snapshots"]) {
    assert.deepEqual(workspace[collection], [], `${collection} is empty`);
  }
  assert.deepEqual(
    workspace.playbooks.map(item => [item.id, item.name, item.builtIn]),
    seed.playbooks.map(item => [item.id, item.name, true])
  );
  assert.ok(Number.isFinite(Date.parse(workspace.createdAt)));
  assert.notEqual(workspace.createdAt, seed.createdAt, "the timestamp is the launch time, not the seed's");
  assert.deepEqual(validateWorkspace(workspace), { valid: true, errors: [] });
  assert.deepEqual(validateWorkspaceImport(workspace), { valid: true, errors: [] });
  const roundTrip = normalizeWorkspace(JSON.parse(JSON.stringify(workspace)), seed);
  assert.deepEqual(validateWorkspace(roundTrip), { valid: true, errors: [] });
  assert.deepEqual(roundTrip.pursuits, [], "normalizing the stored empty workspace does not refill it from the seed");
});

test("a snapshot of the empty workspace validates, so loading the demonstration over it round-trips", () => {
  const workspace = emptyWorkspaceFromSource();
  const snapshot = {
    id: "snap1",
    createdAt: new Date().toISOString(),
    label: "Before loading the demonstration workspace",
    active: "",
    workspace: Object.fromEntries(
      ["pursuits", "criteria", "evidence", "competitors", "actions", "playbooks", "runs"].map(name => [
        name,
        workspace[name]
      ])
    )
  };
  assert.deepEqual(validateWorkspaceSnapshot(snapshot), { valid: true, errors: [] });
  assert.equal(
    validateWorkspaceSnapshot({ ...snapshot, active: "<bad>" }).valid,
    false,
    "a non-empty active id is still checked"
  );
  const seeded = normalizeWorkspace(seedFromSource(), seedFromSource());
  seeded.snapshots = [snapshot];
  assert.deepEqual(validateWorkspace(seeded), { valid: true, errors: [] });
});

test("a candidate without a pursuits collection is still rejected", () => {
  assert.equal(validateWorkspaceImport({}).valid, false);
  assert.match(validateWorkspaceImport({}).errors.join("\n"), /pursuits must be an array/);
  assert.equal(validateWorkspaceImport({ schemaVersion: SCHEMA_VERSION }).valid, false);
});

test("the recovery key is read, written, and removed only through the guarded helpers", () => {
  assert.match(appSource, /^const UNREADABLE_KEY = `\$\{STORAGE_KEY\}_unreadable`;/m);
  const helpers = ["readUnreadableCopy", "preserveUnreadableCopy", "discardUnreadableCopy"];
  const helperSources = helpers.map(name => functionSource(name));
  for (const [name, source] of helpers.map((name, index) => [name, helperSources[index]])) {
    assert.match(source, /try\s*\{/, `${name}() guards its storage access`);
    assert.match(source, /catch \(error\) \{/, `${name}() catches storage failures`);
  }
  const declaration = appSource.indexOf("const UNREADABLE_KEY");
  const uses = [...appSource.matchAll(/UNREADABLE_KEY/g)]
    .map(match => match.index)
    .filter(index => index !== declaration + "const ".length);
  assert.ok(uses.length >= 3, "the key is used by the helpers");
  const helperStarts = helpers.map(name => appSource.indexOf(functionSource(name)));
  for (const index of uses) {
    const inHelper = helperStarts.some(
      (start, position) => index > start && index < start + helperSources[position].length
    );
    const inComment = appSource.lastIndexOf("//", index) > appSource.lastIndexOf("\n", index);
    assert.ok(inHelper || inComment, `UNREADABLE_KEY at offset ${index} is inside a guarded helper`);
  }
  for (const method of ["getItem", "setItem", "removeItem"]) {
    const direct = [...appSource.matchAll(new RegExp(`localStorage\\.${method}\\(\\s*UNREADABLE_KEY`, "g"))];
    assert.equal(direct.length, 1, `exactly one ${method} touches the recovery key`);
  }
  assert.doesNotMatch(appSource, /_unreadable[`"'][^;]*localStorage/, "no inline key string reaches storage");
  assert.match(functionSource("readUnreadableCopy"), /typeof parsed\.raw !== "string"/);
  assert.match(functionSource("preserveUnreadableCopy"), /readUnreadableCopy\(\)\?\.raw === raw\) return true;/);
});

test("the cross-tab refresh inspects an unreadable copy without preserving it", () => {
  assert.match(functionSource("adoptExternalWorkspace"), /loadWorkspace\(\{ preserveUnreadable: false \}\)/);
  assert.match(functionSource("loadWorkspace"), /^function loadWorkspace\(\{ preserveUnreadable = true \} = \{\}\)/);
});

test("the Recovery view offers the unreadable copy as data only, through delegated actions", () => {
  const panel = functionSource("unreadableCopyPanel");
  assert.match(panel, /data-action="download-unreadable"/);
  assert.match(panel, /data-action="discard-unreadable"/);
  assert.match(panel, /new TextEncoder\(\)\.encode\(copy\.raw\)\.length/);
  assert.doesNotMatch(panel, /\$\{esc\(copy\.raw\)\}|\$\{copy\.raw\}/, "the raw value is never rendered");
  assert.doesNotMatch(panel, /on[a-z]+=|<script/i);
  assert.match(functionSource("recoveryView"), /\$\{unreadableCopyPanel\(\)\}/);
  assert.match(
    appSource,
    /dataset\.action === "download-unreadable"\) \{[\s\S]*?download\(\s*`black-hat-agent-unreadable-workspace-\$\{localDate\(\)\}\.json`,\s*copy\.raw,\s*"application\/json;charset=utf-8"\s*\);/
  );
  assert.match(
    appSource,
    /dataset\.action === "discard-unreadable"\) \{\s*if \(confirm\([\s\S]*?discardUnreadableCopy\(\)/
  );
});

test("every pursuit-scoped view guards against a missing pursuit and the portfolio offers both starts", () => {
  for (const name of ["command", "opportunity", "sessionView"]) {
    assert.match(functionSource(name), /const active = pursuit\(\);\s*if \(!active\) \{\s*return noPursuitPanel\(/, `${name}() guards`);
  }
  for (const name of ["criteriaView", "evidenceView", "competitorsView", "importsView", "historyView", "outputsView", "actionsView"]) {
    assert.match(functionSource(name), /if \(!pursuit\(\)\) \{(?:\s*\/\/[^\n]*)*\s*return noPursuitPanel\(/, `${name}() guards`);
  }
  const panel = functionSource("noPursuitPanel");
  assert.match(panel, /No pursuit selected/);
  assert.match(panel, /data-view="portfolio"/);
  const portfolio = functionSource("portfolio");
  assert.match(portfolio, /!data\.pursuits\.length\s*\?[\s\S]*?data-action="new-pursuit">Create pursuit<[\s\S]*?data-action="load-demo">Load demonstration workspace</);
  assert.match(functionSource("playbooksView"), /active\s*\?\s*`<button class="btn small" data-use-playbook/);
  assert.match(appSource, /dataset\.usePlaybook\) \{\s*const active = pursuit\(\);\s*if \(!active\) \{/);
  assert.match(functionSource("guideView"), /The workspace starts empty\. Create a pursuit/);
  assert.match(functionSource("startupBanner"), /role="alert"/);
  assert.match(functionSource("render"), /\$\{staleBanner\(\)\}\$\{startupBanner\(\)\}\$\{header\(\)\}/);
});
