import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Read-only fixture for the checked-out Team canvas source. No app server or accounts.
const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../../", import.meta.url)));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const read = path => readFile(resolve(root, path), "utf8");
const graph = "data:text/javascript;base64," + Buffer.from(await read("apps/web/src/agent-team-graph.js")).toString("base64");
const source = (await read("apps/web/src/agent-team-canvas.js"))
  .replace('"./agent-team-graph.js"', JSON.stringify(graph))
  .replace("export function mountTeamCanvas", "window.mountTeamCanvas = function");
// Match the main stylesheet's order: imported Team rules, then common rules.
const css = await read("apps/web/src/agent-team-library.css") + "\n"
  + (await read("apps/web/src/styles.css")).replace(/^@import .*$/gm, "");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  await page.setContent(`<style>${css}</style><div class="agent-team-dialog" style="width:700px;margin:30px"><button id="add">Add module</button><div id="host" class="team-canvas"></div></div>`);
  await page.addScriptTag({ type: "module", content: source });
  await page.waitForFunction(() => typeof window.mountTeamCanvas === "function");
  await page.evaluate(() => {
    window.draft = { nodes: [], edges: [] }; window.changes = 0; window.edgeCount = 0;
    window.canvas = mountTeamCanvas({ document, host: document.querySelector("#host"), getDraft: () => draft,
      onChange: () => changes++, onSelection: () => {}, t: text => text, makeId: () => `edge-${++edgeCount}` });
    canvas.render();
    for (const id of ["old", "new"]) {
      draft.nodes.push({ id, label: id === "old" ? "Old module" : "New module", role: "Role", target: null, ...canvas.insertionPosition() });
      canvas.select({ kind: "node", id }); canvas.render();
    }
  });
  async function focusedVisible(expectedNode, expectedPort = null) {
    const value = await page.evaluate(() => {
      const active = document.activeElement, card = active.closest("[data-node-id]"), rect = active.getBoundingClientRect();
      const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("[data-node-id]");
      return { active: card?.dataset.nodeId ?? null, port: active.dataset.port ?? null,
        top: top?.dataset.nodeId ?? null, focusVisible: active.matches(":focus-visible"),
        z: card ? getComputedStyle(card).zIndex : null, hudZ: getComputedStyle(document.querySelector(".team-canvas-tools")).zIndex };
    });
    assert.equal(value.active, expectedNode, "unexpected keyboard target");
    assert.equal(value.port, expectedPort, "unexpected keyboard control");
    assert.equal(value.top, expectedNode, "focused module is covered by another module");
    assert.equal(value.focusVisible, true, "keyboard focus is not visible");
    assert.equal(value.z, "3"); assert.equal(value.hudZ, "4");
    results.push(value);
  }
  await page.locator(".team-canvas-viewport").focus();
  await page.keyboard.press("Tab"); await focusedVisible("old");
  await page.keyboard.press("Tab"); await focusedVisible("old", "in");
  await page.keyboard.press("Tab"); await focusedVisible("old", "out");
  assert.equal(await page.evaluate(() => canvas.pinned().id), "new", "focus must not silently change selection");

  await page.locator('[data-node-id="old"] .team-node-drag').focus();
  const before = await page.evaluate(() => structuredClone(draft.nodes));
  await page.keyboard.press("ArrowRight"); await page.keyboard.press("Shift+ArrowDown");
  await focusedVisible("old");
  const after = await page.evaluate(() => structuredClone(draft.nodes));
  assert.equal(after[0].x, before[0].x + 10); assert.equal(after[0].y, before[0].y + 40);
  assert.deepEqual(after[1], before[1]);
  await page.evaluate(() => canvas.render()); await focusedVisible("old");

  // Restore overlap, then connect old output to new input entirely by keyboard.
  await page.evaluate(() => {
    draft.nodes[0].x = draft.nodes[1].x; draft.nodes[0].y = draft.nodes[1].y;
    canvas.select({ kind: "node", id: "new" }); canvas.render(); document.querySelector(".team-canvas-viewport").focus();
  });
  await page.keyboard.press("Tab"); await page.keyboard.press("Tab"); await page.keyboard.press("Tab");
  await focusedVisible("old", "out"); await page.keyboard.press("Enter");
  assert.equal(await page.locator(".team-canvas-viewport").getAttribute("data-linking"), "true");
  await page.keyboard.press("Tab"); await focusedVisible("new");
  await page.keyboard.press("Tab"); await focusedVisible("new", "in"); await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => draft.edges.map(({ source, target }) => ({ source, target }))), [{ source: "old", target: "new" }]);
  assert.equal(await page.locator(".team-canvas-viewport").getAttribute("data-linking"), "false");

  // Separate the nodes to exercise actual SVG hit testing and pointer linking.
  await page.evaluate(() => {
    Object.assign(draft.nodes[0], { x: 40, y: 80 }); Object.assign(draft.nodes[1], { x: 460, y: 80 }); canvas.select(null); canvas.render();
  });
  const point = await page.locator(".team-edge-hit").evaluate(path => {
    const point = path.getPointAtLength(path.getTotalLength() / 2), matrix = path.getScreenCTM();
    return { x: matrix.a * point.x + matrix.c * point.y + matrix.e, y: matrix.b * point.x + matrix.d * point.y + matrix.f + 6 };
  });
  await page.mouse.click(point.x, point.y);
  assert.equal(await page.evaluate(() => canvas.pinned().id), "edge-1");
  await page.locator(".team-edge").focus(); await page.keyboard.press("Enter"); await page.evaluate(() => canvas.render());
  assert.equal(await page.evaluate(() => document.activeElement.dataset.edgeId), "edge-1");
  await page.locator('[data-node-id="new"] [data-port="out"]').click();
  await page.locator('[data-node-id="old"] [data-port="in"]').click();
  assert.deepEqual(await page.evaluate(() => draft.edges.map(({ source, target }) => ({ source, target }))),
    [{ source: "old", target: "new" }, { source: "new", target: "old" }]);
  console.log(JSON.stringify({ browser: browser.version(), root, passed: ["overlapped title/input/output focus", "focus does not change selection",
    "arrow movement and redraw focus", "keyboard link while overlapped", "SVG 6px-offset hit", "edge keyboard/redraw focus", "pointer reverse link"], focusSamples: results }, null, 2));
} finally { await browser.close(); }
