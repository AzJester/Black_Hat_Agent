import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, "..");
const appSource = readFileSync(resolve(rootDir, "app.js"), "utf8");
const indexHtml = readFileSync(resolve(rootDir, "index.html"), "utf8");
const { markdownToWordHtml } = await import(pathToFileURL(resolve(rootDir, "engine.js")).href);

function functionSource(name) {
  const start = appSource.search(new RegExp(`^(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name}() is defined in app.js`);
  const rest = appSource.slice(start);
  const end = rest.search(/\n(?:async )?function |\ndocument\.addEventListener|\nwindow\.addEventListener/);
  return end > 0 ? rest.slice(0, end) : rest;
}

test("F1: evidence attachments are fully read before any reciprocal link is written", () => {
  const handler = functionSource("handleRecordSubmit");
  const firstAwait = handler.indexOf("await ");
  const lastAwait = handler.lastIndexOf("await ");
  const reciprocal = Math.min(
    ...["criterion.evidenceIds.push(record.id)", "evidence.criterionIds.push(record.id)"]
      .map(needle => handler.indexOf(needle))
      .filter(index => index >= 0)
  );
  assert.ok(firstAwait >= 0, "the handler awaits the attachment read");
  assert.ok(Number.isFinite(reciprocal), "the handler writes reciprocal links");
  assert.ok(firstAwait < reciprocal, "the first await happens before the first reciprocal mutation");
  assert.ok(lastAwait < reciprocal, "no await remains after a reciprocal collection is mutated");
  assert.match(
    handler,
    /try\s*\{\s*attachment = await readEvidenceAttachment\(file\);\s*\}\s*catch \(error\) \{\s*data = previous;/,
    "a rejected read restores the previous workspace"
  );
  assert.match(functionSource("readEvidenceAttachment"), /await readDataUrl\(file\)/);
  assert.match(functionSource("readEvidenceAttachment"), /await file\.text\(\)/);
});

test("F1: the record submit dispatcher is guarded against an unexpected throw", () => {
  assert.match(
    appSource,
    /try\s*\{\s*await handleRecordSubmit\(form\);\s*\}\s*catch \(error\) \{(?:\s*\/\/[^\n]*)*\s*data = structuredClone\(lastPersistedData\);\s*render\(\);\s*toast\(/
  );
  assert.doesNotMatch(appSource, /if \(type === "record"\) await handleRecordSubmit\(form\);/);
});

test("F6: a frame-buster runs at module init and refuses to render when trapped", () => {
  const buster = functionSource("bustHostileFrame");
  assert.match(buster, /if \(window\.top === window\.self\) return false;/);
  assert.match(buster, /try\s*\{\s*window\.top\.location = window\.self\.location;\s*\}\s*catch \(error\) \{/);
  assert.match(
    buster,
    /\}\s*return true;\s*\}\s*const frameBlocked = bustHostileFrame\(\);/,
    "a framed document is never rendered, whether the break-out throws or is silently refused"
  );
  assert.match(appSource, /const frameBlocked = bustHostileFrame\(\);/);
  assert.match(
    appSource,
    /if \(frameBlocked\) \{\s*document\.querySelector\("#app"\)\.textContent = FRAMED_MESSAGE;\s*\} else \{\s*history\.replaceState[\s\S]*?render\(\);/
  );
  assert.ok(
    appSource.indexOf("const frameBlocked = bustHostileFrame();") < appSource.indexOf("let data = loadWorkspace();"),
    "the frame check precedes workspace loading"
  );
});

test("F6: print and export windows never load app.js, so the buster cannot recurse", () => {
  assert.doesNotMatch(functionSource("exportPDF"), /app\.js|<script/);
  assert.doesNotMatch(functionSource("exportWord"), /app\.js|<script/);
  const printable = markdownToWordHtml("# Title\n\nBody <script>alert(1)</script>", "Sample");
  assert.doesNotMatch(printable, /<script/i);
  assert.equal((indexHtml.match(/app\.js/g) || []).length, 1, "index.html is the only app.js entry point");
});

test("F7: search and list-filter re-renders preserve the real caret instead of forcing it to the end", () => {
  assert.doesNotMatch(appSource, /setSelectionRange\(query\.length, query\.length\)/);
  assert.doesNotMatch(appSource, /setSelectionRange\(state\.query\.length, state\.query\.length\)/);
  const capture = functionSource("captureInputState");
  assert.match(capture, /selectionStart/);
  assert.match(capture, /selectionEnd/);
  assert.match(capture, /scrollLeft/);
  const restore = functionSource("restoreInputState");
  assert.match(restore, /setSelectionRange\(/);
  assert.match(restore, /input\.scrollLeft = state\.scrollLeft/);
  const inputHandler = appSource.slice(appSource.indexOf('document.addEventListener("input"'));
  assert.match(inputHandler, /const caret = captureInputState\(event\.target\);[\s\S]*?render\(\);[\s\S]*?restoreInputState\(document\.querySelector\(`\[data-list-filter="\$\{collection\}"\]`\), caret\)/);
  assert.match(inputHandler, /const caret = captureInputState\(event\.target\);[\s\S]*?render\(\);[\s\S]*?restoreInputState\(document\.querySelector\("#search"\), caret\)/);
});

test("F8: a storage event reloads a clean tab and freezes a dirty one behind a persistent banner", () => {
  const listener = appSource.slice(appSource.indexOf('window.addEventListener("storage"'));
  assert.match(listener, /if \(!dirtyForm && !staleWorkspace\) \{\s*adoptExternalWorkspace\(\);\s*return;/);
  assert.match(listener, /staleWorkspace = true;[\s\S]*?showStaleBanner\(\);/);
  assert.doesNotMatch(
    listener.slice(0, listener.indexOf("});")),
    /toast\("This workspace changed in another tab\. Reload before making more edits\."\)/
  );
  const adopt = functionSource("adoptExternalWorkspace");
  assert.match(adopt, /const next = loadWorkspace\(\);/);
  assert.match(adopt, /lastPersistedData = structuredClone\(next\);/);
  assert.match(adopt, /render\(\);/);
  const banner = functionSource("staleBanner");
  assert.match(banner, /role="alert"/);
  assert.match(banner, /data-action="reload-workspace"/);
  assert.doesNotMatch(banner, /on[a-z]+=|<script/i);
  assert.match(appSource, /dataset\.action === "reload-workspace"\) \{[\s\S]*?location\.reload\(\);/);
});

test("F8: save() refuses to overwrite a fresher workspace from a stale tab", () => {
  const save = functionSource("save");
  const guard = save.indexOf("if (staleWorkspace) {");
  const write = save.indexOf("localStorage.setItem(STORAGE_KEY");
  assert.ok(guard >= 0 && write > guard, "the stale guard runs before the storage write");
  assert.match(save, /if \(staleWorkspace\) \{\s*[\s\S]*?data = previous;\s*saveError = STALE_WORKSPACE_MESSAGE;\s*toast\(saveError, "error"\);\s*return false;/);
  assert.match(functionSource("saveStateText"), /if \(staleWorkspace\) return STALE_WORKSPACE_MESSAGE;/);
});

test("F9: the persistent save-state indicator is an atomic live region", () => {
  const indicator = functionSource("saveStateIndicator");
  assert.match(indicator, /class="save-state \$\{saveStateClass\(\)\}" role="status" aria-live="\$\{saveStateLive\(\)\}" aria-atomic="true"/);
  assert.match(functionSource("saveStateLive"), /saveError \|\| staleWorkspace \? "assertive" : "polite"/);
  assert.match(functionSource("refreshSaveState"), /setAttribute\("aria-live", saveStateLive\(\)\)/);
  assert.match(functionSource("header"), /\$\{saveStateIndicator\(\)\}/);
  assert.doesNotMatch(appSource, /<span class="save-state \$\{dirtyForm \? "dirty"/);
});
