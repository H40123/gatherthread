// Local fixture only. No accounts, provider calls, or deployment credentials.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE)).href : "playwright");
const origin = process.env.MOTION_ORIGIN ?? "http://127.0.0.1:18847";
assert.ok(["127.0.0.1", "localhost"].includes(new URL(origin).hostname));
const artifacts = process.env.MOTION_ARTIFACTS ?? "/tmp/gatherthread-motion-review";
await mkdir(artifacts, { recursive: true });
const engine = process.env.MOTION_BROWSER ?? "chrome";
const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
const results = [];
try {
  for (const [name, width, height, mobile, theme] of [
    ["desktop-light", 1440, 960, false, "light"],
    ["desktop-dark", 1440, 960, false, "dark"],
    ["phone", 390, 844, true, "light"],
    ["short-phone", 320, 568, true, "dark"],
    ["tablet", 820, 1180, true, "light"],
  ]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${origin}/app/example.html?locale=zh-CN&layout=${mobile ? "mobile" : "desktop"}&theme=${theme}`);
    await page.locator("#workspace:not([hidden])").waitFor();
    await page.locator("#message-input").waitFor();
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.motionResolved), "full");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`);
    // The two explicit sending intents must remain on screen even on a short phone.
    for (const id of ["send-chat-button", "send-agent-button"]) {
      const box = await page.locator(`#${id}`).boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= height + 1, `${name}: ${id} off screen`);
    }
    await page.locator("#mobile-agent-button").click();
    await page.locator("#mobile-agent-dialog[open]").waitFor();
    const opening = await page.locator("#mobile-agent-dialog").evaluate(n => ({
      opacity: getComputedStyle(n).opacity, running: n.getAnimations().length,
      display: getComputedStyle(n).display,
    }));
    assert.notEqual(opening.display, "none");
    await page.waitForTimeout(350);
    await page.locator("#mobile-agent-dialog [data-mobile-close]").click();
    await page.waitForTimeout(350);
    assert.equal(await page.locator("#mobile-agent-button").evaluate(n => n === document.activeElement), true);
    // Reopening/closing during the exit must leave no invisible modal blocking clicks.
    for (let i = 0; i < 3; i++) {
      await page.locator("#mobile-agent-button").click();
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(350);
    assert.equal(await page.locator("dialog[open]").count(), 0);
    const worklog = page.locator(".agent-worklog").first();
    if (await worklog.count()) {
      if (!await worklog.evaluate(n => n.open)) await worklog.locator(":scope > summary").click();
      await page.waitForTimeout(350);
    }
    await page.locator("#message-input").fill(`动效核验 ${name}`);
    await page.evaluate(() => {
      const region = document.querySelector(".timeline-region");
      if (region) region.scrollTop = region.scrollHeight;
      window.arrivalFrames = [];
      let until = performance.now() + 1200;
      const frame = () => {
        const cards = [...document.querySelectorAll(".event-card")];
        const n = cards.find(n => n.textContent.includes("动效核验"));
        if (n) window.arrivalFrames.push({ opacity: Number(getComputedStyle(n).opacity), y: getComputedStyle(n).transform === 'none' ? 0 : new DOMMatrix(getComputedStyle(n).transform).m42,
          historyOpacity: [...document.querySelectorAll('.agent-worklog[open]')].map(node => Number(getComputedStyle(node, '::details-content').opacity)) });
        if (performance.now() < until) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    await page.locator("#send-chat-button").click();
    await page.locator(".event-card").filter({ hasText: `动效核验 ${name}` }).waitFor();
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${artifacts}/${engine}-${name}.png` });
    const motion = await page.evaluate(() => ({ frames: window.arrivalFrames.length,
      intermediate: window.arrivalFrames.some(f => f.opacity > 0 && f.opacity < .99),
      slidesUp: window.arrivalFrames.some(f => f.y > 1) && window.arrivalFrames.every((f, i, frames) => !i || f.y <= frames[i - 1].y + .2),
      historySteady: window.arrivalFrames.every(f => f.historyOpacity.every(opacity => opacity === 1)),
      clean: [...document.querySelectorAll(".event-card")].every(n => !n.style.transform && !n.style.opacity) }));
    assert.ok(motion.intermediate, `${name}: new message did not animate`);
    assert.ok(motion.slidesUp, `${name}: CSS fought the message's upward animation`);
    assert.ok(motion.historySteady, `${name}: older worklog faded on a new message`);
    assert.ok(motion.clean, `${name}: stale inline motion styles`);
    if (!mobile) {
      await page.locator("#open-files-button").click();
      await page.waitForTimeout(350);
      await page.locator("#open-files-button").click();
      await page.waitForTimeout(350);
      await page.locator("#history-summary-menu-button").click();
      await page.locator("#history-summary-menu-panel:not([hidden])").waitFor();
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#history-summary-menu-button").evaluate(n => n === document.activeElement), true);
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#mobile-agent-button").click();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.motionResolved), "reduce");
    assert.equal(await page.locator("#mobile-agent-dialog").evaluate(n => n.getAnimations().length), 0);
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, []);
    results.push({ name, opening, motion });
    await context.close();
  }
  // Real login/registration markup, with the repository's explicit local mock.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${origin}/app/?mock=1`);
  await page.locator("#auth-select-register").click();
  const heading = page.locator('[data-auth-entry-heading="register"]');
  await heading.waitFor();
  assert.ok((await heading.boundingBox()).y < (await page.locator("#auth-identity").boundingBox()).y);
  await heading.locator(".auth-entry-back").click();
  await page.locator("#auth-entry-chooser").waitFor();
  await page.locator("#auth-select-email-login").click();
  await page.locator("#email-login-email").fill("demo@example.invalid");
  await page.locator("#email-login-password").fill("isolated demo password");
  await page.locator('#email-login-form button[type="submit"]').click();
  await page.locator("#workspace:not([hidden])").waitFor();
  results.push({ name: "auth-back-and-login", passed: true });
  await context.close();
  console.log(JSON.stringify({ engine, passed: results.length, results, artifacts }, null, 2));
} finally { await browser.close(); }
