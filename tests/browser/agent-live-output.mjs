// Synthetic MockCollaborationApi streams on a fresh loopback browser context.
// No native conversation, production account, provider, or private tool data is read.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWebServer } from "../../apps/web/scripts/serve.mjs";

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href : "playwright");
const server = createWebServer({ root: resolve("apps/web/dist"), host: "127.0.0.1", port: 0,
  upstream: new URL("http://127.0.0.1:1") });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const artifacts = mkdtempSync(join(tmpdir(), "gatherthread-live-output-ui-"));
const cases = [
  ["chromium-desktop", chromium, "en", 1440, 900, false],
  ["webkit-desktop", webkit, "zh-CN", 1440, 900, false],
  ["webkit-phone", webkit, "zh-CN", 390, 844, true],
  ["chromium-tablet", chromium, "en", 1024, 900, true],
];
const longAnswer = `## Growing fixture\n\nThe beginning stays readable.\n\n${"Public answer paragraph. ".repeat(45)}\n\nNewest words.`;
let passed = 0;

async function initialize(page, locale) {
  await page.goto(`${origin}/app/?mock=1`);
  await page.locator("#auth-view").waitFor({ state: "visible" });
  await page.evaluate(async () => {
    const entryUrl = document.querySelector('script[type="module"]').src;
    const entry = await (await fetch(entryUrl)).text();
    const mainUrl = new URL(entry.match(/import\("([^\"]*main\.js[^\"]*)"\)/)[1], entryUrl).href;
    const main = await (await fetch(mainUrl)).text();
    const specifier = main.match(/from\s+["'](\.\/api\.js(?:\?[^"']*)?)["']/)[1];
    const { MockCollaborationApi } = await import(new URL(specifier, mainUrl).href);
    const getSession = MockCollaborationApi.prototype.getSession;
    MockCollaborationApi.prototype.getSession = async function (...args) {
      window.liveFixtureApi = this;
      if (!this.liveFixtureReady) {
        this.liveFixtureReady = true; this.latency = 0;
        const history = Array.from({ length: 14 }, (_, index) => ({
          id: `fixture-history-${index}`, type: "human_chat", sessionId: "session-orbit", sequence: index + 1,
          createdAt: new Date().toISOString(), visibility: "session", actor: this.currentUser, replyTo: null,
          payload: { content: `Older fixture message ${index + 1}. ${"Readable history. ".repeat(20)}` },
        }));
        this.events.set("session-orbit", history);
      }
      return getSession.apply(this, args);
    };
    window.emitLiveFixture = (type, payload, replyTo = null, id) => {
      const api = window.liveFixtureApi, sessionId = "session-orbit", events = api.events.get(sessionId);
      const event = { id: id ?? `fixture-event-${events.length + 1}`, sessionId,
        sequence: (events.at(-1)?.sequence ?? 0) + 1, type, payload, replyTo, visibility: "session",
        createdAt: new Date().toISOString(), actor: structuredClone(api.currentUser) };
      events.push(event);
      for (const listener of api.listeners.get(sessionId) ?? []) if (!listener.closed) listener.onEvent(structuredClone(event));
      return event.id;
    };
  });
  await page.locator("#auth-select-email-login").click();
  await page.locator("#email-login-email").fill("demo@example.invalid");
  await page.locator("#email-login-password").fill("isolated demo password");
  await page.locator("#email-login-form button[type=submit]").click();
  await page.locator("#code-notice-dialog[open], #session-view:not([hidden])").first().waitFor();
  if (await page.locator("#code-notice-dialog[open]").isVisible()) await page.locator("#code-notice-continue").click();
  await page.locator("#session-view:not([hidden])").waitFor();
  await page.waitForFunction(() => window.liveFixtureApi?.listeners.get("session-orbit")?.size > 0);
}

async function emit(page, type, payload, request, id) {
  return page.evaluate(({ type, payload, request, id }) => window.emitLiveFixture(type, payload, request, id), { type, payload, request, id });
}
const stream = (id, kind, revision, content, extra = {}) => ({ phase: "stream", stream_id: id,
  stream_mode: "snapshot", stream_kind: kind, stream_revision: revision, stream_state: "running", content, ...extra });

try {
  for (const [name, engine, locale, width, height, mobile] of cases) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile,
      reducedMotion: "reduce", ...(mobile ? { userAgent: width < 760
        ? "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1"
        : "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" } : {}) });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(8000);
    page.on("pageerror", error => errors.push(error.message));
    await context.route(/^https?:/, route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    await context.addInitScript(locale => {
      localStorage.setItem("gt-lang", locale === "zh-CN" ? "zh" : "en");
      const getItem = Storage.prototype.getItem;
      Storage.prototype.getItem = function (key) { return key.startsWith("gatherthread.onboarding.v1:") ? "skipped" : getItem.call(this, key); };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async text => { window.fixtureCopied = text; } } });
    }, locale);
    try {
      await initialize(page, locale);
      for (const harness of ["codex", "deepseek-harness", "opencode"]) {
        const request = await emit(page, "agent_request", { content: `${harness} synthetic request`,
          execution_profile: { harness, provider: "fixture", model: "fixture" } });
        const answerId = `${harness}-answer`, toolId = `${harness}-tool`, thinkingId = `${harness}-thinking`, planId = `${harness}-plan`;
        await emit(page, "agent_progress", stream(answerId, "answer", 1, "The beginning stays readable."), request);
        await emit(page, "agent_progress", stream(toolId, "tool", 1, "Safe public tool fixture.", { title: "Work log" }), request);
        await emit(page, "agent_progress", stream(thinkingId, "reasoning", 1, "Provider-exposed thinking fixture."), request);
        await emit(page, "agent_progress", stream(planId, "plan", 1, "", { plan: [
          { step: "Working", status: "in_progress" }, { step: "Verify result", status: "pending" },
        ] }), request);
        const latest = await emit(page, "agent_progress", stream(answerId, "answer", 2, longAnswer), request);
        const worklog = page.locator(`.agent-worklog[data-request-id="${request}"]`);
        const answer = worklog.locator(`[data-stream-id="${answerId}"]`);
        const tool = worklog.locator(`[data-stream-id="${toolId}"]`);
        await answer.locator(".markdown-body").getByText("The beginning stays readable.", { exact: true }).waitFor();
        assert.equal(await worklog.locator(`[data-stream-id="${answerId}"]`).count(), 1, "interleaved updates render one growing answer");
        assert.equal(await worklog.getAttribute("aria-live"), "off", "growing content is not repeatedly announced");
        assert.equal(await worklog.locator(".agent-plan-step").count(), 2, "empty-content structured plans remain visible");
        assert.equal(await worklog.locator('.agent-plan-step[data-status="in_progress"] > span:last-child').textContent(), "Working",
          "provider-authored plan text is preserved in both UI languages");
        assert.equal(await tool.locator(".agent-worklog-title").textContent(), "Work log",
          "provider-authored titles are preserved in both UI languages");
        assert.equal(await worklog.getByRole("img", { name: locale === "zh-CN" ? "待处理" : "Pending", exact: true }).count(), 1,
          "plan status symbols have readable accessible names");
        if (harness === "codex") {
          await worklog.locator(":scope > summary").scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(artifacts, `${name}.png`) });
        }
        await tool.locator("summary").click();
        assert.equal(await tool.evaluate(node => node.open), false);
        await emit(page, "agent_progress", stream(toolId, "tool", 2, "Updated public tool fixture."), request);
        await page.waitForFunction(id => document.querySelector(`[data-stream-id="${id}"] .markdown-body`)?.textContent.includes("Updated"), toolId);
        assert.equal(await tool.evaluate(node => node.open), false, "ordinary pointer collapse survives a streamed revision");
        assert.equal(await tool.locator("summary").evaluate(node => node === document.activeElement), true, "stream refresh preserves focused disclosure");
        await page.keyboard.press("Space");
        assert.equal(await tool.evaluate(node => node.open), true, "Space activates the native summary");
        await page.keyboard.press("Enter");
        assert.equal(await tool.evaluate(node => node.open), false, "Enter activates the native summary");
        assert.equal(await answer.locator(".markdown-body").evaluate(node => getComputedStyle(node, "::after").animationName), "none",
          "the streaming caret respects reduced motion");
        await emit(page, "agent_progress", stream(answerId, "answer", 1, "STALE SNAPSHOT"), request);
        assert.doesNotMatch(await answer.textContent(), /STALE SNAPSHOT/);
        await answer.getByRole("button", { name: locale === "zh-CN" ? "复制正文" : "Copy message", exact: true }).click();
        assert.equal(await page.evaluate(() => window.fixtureCopied), longAnswer);
        await answer.getByRole("button", { name: locale === "zh-CN" ? "引用消息" : "Quote message", exact: true }).click();
        await page.locator("#message-input").fill(`Quoted ${harness} fixture`);
        await page.locator("#send-chat-button").click();
        await page.waitForFunction(latest => window.liveFixtureApi.events.get("session-orbit").some(event =>
          event.type === "human_chat" && event.replyTo === latest), latest);
        await emit(page, "agent_progress", stream(planId, "plan", 2, "", { stream_state: "completed", plan: [
          { step: "Working", status: "completed" }, { step: "Verify result", status: "completed" },
        ] }), request);
        assert.equal(await worklog.locator('.agent-plan-step[data-status="completed"]').count(), 2);
        await worklog.locator(":scope > summary").click();
        assert.equal(await worklog.evaluate(node => node.open), false);
        await emit(page, "agent_progress", stream(answerId, "answer", 3, `${longAnswer}\n\nDone.`), request);
        await emit(page, "agent_response", { content: `${harness} completed fixture answer.` }, request);
        const finished = page.locator(`.agent-worklog[data-request-id="${request}"]`);
        await page.getByText(`${harness} completed fixture answer.`, { exact: true }).waitFor();
        assert.equal(await finished.evaluate(node => node.open), false, "manual worklog collapse survives final completion");
        await finished.locator(":scope > summary").click();
        assert.equal(await finished.locator(`[data-stream-id="${toolId}"]`).evaluate(node => node.open), false,
          "manual section collapse remains after opening the completed worklog");
        const quotedChat = await page.evaluate(latest => window.liveFixtureApi.events.get("session-orbit").find(event => event.type === "human_chat" && event.replyTo === latest).id, latest);
        await page.locator(`#message-${quotedChat} .quoted-message`).click();
        assert.doesNotMatch(await page.locator(`#message-${latest} .markdown-body`).textContent(), /Done\./,
          "a quote made before the last revision still reveals its exact stored snapshot");
      }
      const legacyRequest = await emit(page, "agent_request", { content: "Legacy synthetic request" });
      const legacyFirst = await emit(page, "agent_progress", { phase: "stream", stream_id: "legacy-fixture", content: "Legacy " }, legacyRequest);
      const legacy = page.locator('[data-stream-id="legacy-fixture"]');
      await legacy.getByRole("button", { name: locale === "zh-CN" ? "引用消息" : "Quote message", exact: true }).click();
      await page.locator("#message-input").fill("A quote of the first legacy fragment");
      await page.locator("#send-chat-button").click();
      await page.waitForFunction(id => window.liveFixtureApi.events.get("session-orbit").some(event => event.type === "human_chat" && event.replyTo === id), legacyFirst);
      await emit(page, "agent_progress", { phase: "stream", stream_id: "legacy-fixture", content: "combined answer" }, legacyRequest);
      await legacy.getByText("Legacy combined answer", { exact: true }).waitFor();
      assert.equal(await legacy.getByRole("button", { name: locale === "zh-CN" ? "引用消息" : "Quote message", exact: true }).count(), 0);
      await legacy.getByRole("button", { name: locale === "zh-CN" ? "复制正文" : "Copy message", exact: true }).click();
      assert.equal(await page.evaluate(() => window.fixtureCopied), "Legacy combined answer");
      const legacyChat = await page.evaluate(id => window.liveFixtureApi.events.get("session-orbit").find(event => event.type === "human_chat" && event.replyTo === id).id, legacyFirst);
      await page.locator(`#message-${legacyChat} .quoted-message`).click();
      assert.equal((await page.locator(`#message-${legacyFirst} .markdown-body`).textContent()).trim(), "Legacy",
        "a canonical legacy fragment quote never reveals the synthetic aggregate instead");
      const pausedRequest = await emit(page, "agent_request", { content: "Paused synthetic request", execution_profile: { harness: "opencode" } });
      await emit(page, "agent_progress", stream("paused-answer", "answer", 1, "An unfinished public answer."), pausedRequest);
      await emit(page, "agent_progress", { phase: "lifecycle", status: "paused", content: "The author paused this Agent request." }, pausedRequest);
      const paused = page.locator(`.agent-worklog[data-request-id="${pausedRequest}"]`);
      await paused.locator(":scope > summary").click();
      assert.equal(await paused.locator('[data-stream-id="paused-answer"]').getAttribute("data-stream-state"), "paused",
        "pausing keeps partial output readable without marking unfinished work done");
      assert.equal(await paused.locator(".agent-worklog-state").textContent(), locale === "zh-CN" ? "已暂停" : "Paused");
      for (const [outcome, payload] of [
        ["failed", { status: "failed", error: { code: "model_unavailable" } }],
        ["cancelled", { status: "failed", error: { code: "codex_turn_cancelled" } }],
      ]) {
        const request = await emit(page, "agent_request", { content: `${outcome} synthetic request` });
        const answerId = `${outcome}-partial-answer`, toolId = `${outcome}-completed-tool`;
        await emit(page, "agent_progress", stream(answerId, "answer", 1, "The partial public answer remains readable."), request);
        await emit(page, "agent_progress", stream(toolId, "tool", 1, "Earlier tool finished.", { stream_state: "completed" }), request);
        const worklog = page.locator(`.agent-worklog[data-request-id="${request}"]`);
        await worklog.locator(`[data-stream-id="${answerId}"] summary`).click();
        assert.equal(await worklog.locator(`[data-stream-id="${answerId}"]`).evaluate(node => node.open), false);
        await emit(page, "agent_response", { ...payload, content: `${outcome} terminal fixture.` }, request);
        const finished = page.locator(`.agent-worklog[data-request-id="${request}"]`);
        await page.getByText(`${outcome} terminal fixture.`, { exact: true }).waitFor();
        await finished.locator(":scope > summary").click();
        const answer = finished.locator(`[data-stream-id="${answerId}"]`);
        assert.equal(await answer.getAttribute("data-stream-state"), "failed",
          "a failed or cancelled turn must not label its unfinished partial answer Done");
        assert.equal(await answer.locator(".agent-worklog-state").textContent(), locale === "zh-CN" ? "失败" : "Failed");
        assert.equal(await answer.evaluate(node => node.open), false, "section collapse survives terminal failure");
        await answer.locator("summary").click();
        await answer.getByText("The partial public answer remains readable.", { exact: true }).waitFor();
        const tool = finished.locator(`[data-stream-id="${toolId}"]`);
        assert.equal(await tool.getAttribute("data-stream-state"), "completed", "earlier completed tools stay Done");
        assert.equal(await tool.locator(".agent-worklog-state").textContent(), locale === "zh-CN" ? "完成" : "Done");
      }
      await page.locator(".timeline-region").evaluate(node => { node.scrollTop = 0; });
      const anchorTop = await page.locator('[data-history-anchor="fixture-history-0"]').evaluate(node => node.getBoundingClientRect().top);
      await emit(page, "agent_progress", { phase: "stream", stream_id: "legacy-fixture", content: " continues" }, legacyRequest);
      assert.ok(Math.abs(await page.locator('[data-history-anchor="fixture-history-0"]').evaluate(node => node.getBoundingClientRect().top) - anchorTop) < 2,
        "stream growth preserves the older history reading position");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "layout fits the viewport");
      assert.deepEqual(errors, []); passed++;
      console.log(`${name}: all three harnesses, plan, revision replacement, collapse, copy/quote, history anchor passed`);
    } finally { await context.close(); await browser.close(); }
  }
  console.log(`${passed} isolated live-output browser scenarios passed with ordinary pointer clicks.`);
  console.log(`Synthetic workspace screenshots: ${artifacts}`);
} finally { await new Promise(resolve => server.close(resolve)); }
