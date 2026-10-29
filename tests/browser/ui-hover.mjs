// Hover regression for the built, isolated example and local mock login.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const origin = process.env.MOTION_ORIGIN ?? "http://127.0.0.1:18847";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
const engine = process.env.MOTION_BROWSER ?? "chrome";
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const results = [];

async function checkHover(page, selector, label) {
  const control = page.locator(selector).first();
  if (!await control.isVisible() || !await control.isEnabled()) return;
  await control.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await page.waitForTimeout(220);
  await control.evaluate(node => {
    const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
    canvas.width = canvas.height = 1;
    const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].map(x => x / 255); };
    const over = (a, b) => [...a.slice(0, 3).map((x, i) => x * a[3] + b[i] * (1 - a[3])), 1];
    const luminance = c => c.slice(0, 3).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [.2126, .7152, .0722][i], 0);
    const read = () => {
      const style = getComputedStyle(node), rect = node.getBoundingClientRect();
      const ancestors = []; for (let n = node; n; n = n.parentElement) ancestors.unshift(n);
      let background = [1, 1, 1, 1];
      for (const n of ancestors) background = over(rgb(getComputedStyle(n).backgroundColor), background);
      const text = node.querySelector("span:not([aria-hidden])") ?? node;
      const foreground = over(rgb(getComputedStyle(text).color), background);
      const a = luminance(foreground), b = luminance(background);
      return { x: rect.x, y: rect.y, opacity: Number(style.opacity), image: style.backgroundImage,
        color: style.color, background: style.backgroundColor, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
    };
    window.hoverProbe = { before: read(), frames: [], read };
  });
  // Move to the lower edge: the old upward hover transform made this point
  // leave the control, then re-enter when the control moved back.
  const box = await control.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height - .25);
  await page.evaluate(async () => {
    const end = performance.now() + 260;
    await new Promise(resolve => {
      const frame = () => { window.hoverProbe.frames.push(window.hoverProbe.read());
        if (performance.now() < end) requestAnimationFrame(frame); else resolve(); };
      requestAnimationFrame(frame);
    });
  });
  const probe = await page.evaluate(() => ({ before: window.hoverProbe.before, frames: window.hoverProbe.frames }));
  const failures = [];
  if (!probe.frames.every(f => Math.abs(f.x - probe.before.x) < .1 && Math.abs(f.y - probe.before.y) < .1)) failures.push("hover moved hit area");
  if (!probe.frames.every(f => f.opacity >= .99)) failures.push("label faded");
  if (!probe.frames.every(f => f.image === probe.before.image)) failures.push("background image snapped");
  const minContrast = Math.min(probe.before.contrast, ...probe.frames.map(f => f.contrast));
  if (minContrast < 4.5) failures.push(`text contrast ${minContrast.toFixed(2)}`);
  // Press feedback must not shrink the hit area away from an edge click.
  await page.mouse.down();
  await page.waitForTimeout(120);
  const pressed = await control.boundingBox();
  if (!pressed || ["x", "y", "width", "height"].some(key => Math.abs(pressed[key] - box[key]) > .1)) failures.push("press moved hit area");
  // Release outside the control so this generic probe cannot submit an action.
  await page.mouse.move(0, 0);
  await page.mouse.up();
  results.push({ label, selector, minContrast: Number(minContrast.toFixed(2)), failures });
}

async function checkEdgeActivation(page) {
  for (const motion of ["full", "reduce"]) {
    await page.evaluate(value => {
      document.documentElement.dataset.motion = value;
      document.documentElement.dataset.motionResolved = value;
    }, motion);
    const control = page.locator("#manage-agents-button");
    const box = await control.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - .25);
    await page.mouse.down();
    await page.waitForTimeout(120);
    if (motion === "reduce") {
      // The existing settings stylesheet uses a 0.01 ms near-zero duration.
      const duration = await control.evaluate(node => parseFloat(getComputedStyle(node).transitionDuration));
      assert.ok(duration <= .00001, `reduced-motion duration is ${duration}s`);
    }
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector("#agent-management-dialog").open);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  await page.evaluate(() => {
    document.documentElement.dataset.motion = "full";
    document.documentElement.dataset.motionResolved = "full";
  });
}

try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const page = await context.newPage();
    await page.goto(`${origin}/app/example.html?locale=zh-CN&layout=desktop&theme=${theme}`);
    await page.locator("#message-input").waitFor();
    for (const contrast of ["standard", "high"]) {
      await page.evaluate(value => { document.documentElement.dataset.contrast = value; }, contrast);
      for (const selector of ["#manage-agents-button", "#send-chat-button", "#mobile-agent-button", "#history-summary-menu-button", ".session-button", "#rename-project-button", "#example-files-open", ".example-browse-button"]) {
        await checkHover(page, selector, `${theme}/${contrast}/workspace`);
      }
    }
    // A draft enables the primary action without issuing an Agent request.
    await page.locator("#message-input").fill("Hover verification only");
    await checkHover(page, "#send-agent-button", `${theme}/primary`);
    await checkEdgeActivation(page);
    await page.locator("#manage-agents-button").click();
    await page.waitForTimeout(350);
    for (const selector of ["#agent-management-add", "#agent-sharing-button", "#agent-teams-button"]) await checkHover(page, selector, `${theme}/management`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.locator("#history-summary-menu-button").click();
    await page.waitForTimeout(250);
    for (const selector of ["#history-summary-select-button", "#history-summary-view-button", "#history-summary-versions-button"]) await checkHover(page, selector, `${theme}/summary`);
    await page.keyboard.press("Escape");
    await page.locator("#settings-button").click();
    await page.waitForTimeout(350);
    for (const selector of ["#reset-settings-button", "#cancel-settings-button", '#settings-dialog button[type="submit"]']) await checkHover(page, selector, `${theme}/settings`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.locator("#example-files-open").click();
    await page.locator(".fw-tree-row").filter({ hasText: "README.md" }).first().click();
    await page.waitForTimeout(350);
    for (const selector of [".fw-file-tools .fw-button", ".fw-tab"]) await checkHover(page, selector, `${theme}/files`);
    await context.close();
  }
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(`${origin}/app/?mock=1`);
  for (const theme of ["light", "dark"]) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    for (const selector of ["#auth-select-register", "#auth-select-email-login"]) await checkHover(page, selector, `${theme}/auth`);
    await page.locator("#auth-select-email-login").click();
    await page.locator("#email-login-email").fill("demo@example.invalid");
    await page.locator("#email-login-password").fill("isolated demo password");
    for (const selector of ['[data-auth-entry-heading="email-login"] .auth-entry-back', '#email-login-form button[type="submit"]']) await checkHover(page, selector, `${theme}/auth-form`);
    await page.locator('.auth-form-heading:not([hidden]) .auth-entry-back').click();
  }
  console.log(JSON.stringify({ engine, checks: results.length, results }, null, 2));
  assert.deepEqual(results.filter(r => r.failures.length), [], "Hover states must remain legible and stable");
} finally { await browser.close(); }
