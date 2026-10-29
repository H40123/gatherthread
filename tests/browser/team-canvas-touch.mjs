import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// An isolated fixture; reads actual source and all CSS affecting the Team canvas.
const root = resolve(process.argv[2] ?? fileURLToPath(new URL("../../", import.meta.url)));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const read = file => readFile(resolve(root, file), "utf8");
const graph = "data:text/javascript;base64," + Buffer.from(await read("apps/web/src/agent-team-graph.js")).toString("base64");
const source = (await read("apps/web/src/agent-team-canvas.js"))
  .replace('"./agent-team-graph.js"', JSON.stringify(graph))
  .replace("export function mountTeamCanvas", "window.mountTeamCanvas = function");
const css = await read("apps/web/src/agent-team-library.css") + "\n"
  + (await read("apps/web/src/styles.css")).replace(/^@import .*$/gm, "") + "\n"
  + await read("apps/web/src/interaction-design.css");
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div class="agent-team-dialog" style="width:360px;margin:10px"><div id="host" class="team-canvas"></div></div>`);
  await page.addScriptTag({ type: "module", content: source });
  await page.waitForFunction(() => window.mountTeamCanvas);
  await page.evaluate(() => {
    window.cancellations = 0; window.changes = 0;
    window.draft = { nodes: [{ id: "a", label: "Module", role: "Role", target: null, x: 40, y: 150 }], edges: [] };
    window.canvas = mountTeamCanvas({ document, host: document.querySelector("#host"), getDraft: () => draft,
      onChange: () => changes++, onSelection: () => {}, t: text => text, makeId: () => "unused" });
    canvas.render(); document.addEventListener("pointercancel", () => cancellations++);
  });
  const point = await page.locator(".team-node-drag").evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, touchAction: getComputedStyle(node).touchAction,
      portActions: [...document.querySelectorAll(".team-node-port")].map(port => getComputedStyle(port).touchAction) };
  });
  assert.equal(point.touchAction, "none"); assert.deepEqual(point.portActions, ["none", "none"]);
  const client = await context.newCDPSession(page);
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y, id: 1 }] });
  for (let step = 1; step <= 5; step++) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: point.x, y: point.y - step * 20, id: 1 }] });
    await page.waitForTimeout(30);
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(60);
  const result = await page.evaluate(() => ({ y: draft.nodes[0].y, changes, cancellations,
    scrollTop: document.querySelector(".team-canvas-viewport").scrollTop }));
  assert.deepEqual(result, { y: 50, changes: 1, cancellations: 0, scrollTop: 0 });
  console.log(JSON.stringify({ browser: browser.version(), root, touchAction: point.touchAction, portActions: point.portActions, ...result }));
} finally { await browser.close(); }
