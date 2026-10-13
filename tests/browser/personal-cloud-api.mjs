// Cookie-authenticated API settings + ordinary pointer checks. Synthetic keys,
// isolated in-memory accounts and a controlled executor; no real provider calls.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { startCollaborationServer } from "../../apps/server/dist/src/server.js";
import { CodeRepository } from "../../apps/server/dist/src/code-repository.js";
const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH ?? "playwright");
const directory = mkdtempSync(join(tmpdir(), "gt-personal-api-browser-"));
const reserve = createServer(); await new Promise(done => reserve.listen(0, "127.0.0.1", done));
const port = reserve.address().port; await new Promise(done => reserve.close(done));
const origin = `http://127.0.0.1:${port}`, mails = [];
let failNextCloudRun = false;
const registration = { enabled: true, origin, siteKey: "fixture", challenge: { async verify() { return true; } },
  mailer: { async send(mail) { mails.push(mail); } } };
const server = await startCollaborationServer({ databasePath: ":memory:", codeRepositoryDirectory: join(directory, "code"),
  authTokenPepper: randomBytes(32).toString("hex"), registration, staticDirectory: resolve("apps/web/dist"),
  publicBaseUrl: origin, allowedOrigins: [origin], hostedAgent: {
    personalApiEncryptionKey: randomBytes(32).toString("base64"), endpoints: [{ id: "fixture", profileId: "fixture-service",
      label: "Service fixture", provider: "deepseek", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1",
      apiToken: "fixture-k", quotaGroup: "fixture", dailyRuns: 4, maxConcurrent: 1 }],
    image: `fixture/cloud@sha256:${"a".repeat(64)}`, userMinIntervalSeconds: 1,
    userDailyRuns: 4, globalDailyRuns: 20, maxConcurrent: 1,
    fetch: async () => { throw Error("Live providers are forbidden in this fixture"); },
    runContainer: async () => {
      if (failNextCloudRun) { failNextCloudRun = false; throw Error("fixture_run_failed"); }
      return JSON.stringify({ answer: "Selected personal model answered.", files: [] });
    },
  } }, port);
async function seed(context, locale) {
  const marker = randomUUID();
  const sent = await server.database.registration.send({ email: `${randomUUID()}@example.invalid`, locale: "en",
    challenge_token: randomUUID(), idempotency_key: randomUUID() }, marker, randomUUID(), registration);
  const identity = await server.database.verifyPublicRegistration({ registration_id: sent.registration_id, code: mails.at(-1).code,
    display_name: "API tester", device_name: "Browser fixture", remember_device: false,
    password: randomBytes(24).toString("hex"), privacy_acknowledged: true }, marker, randomUUID(), registration);
  const actor = identity.actor, project = server.service.createProject(actor, { title: "API fixture", idempotency_key: randomUUID() });
  const session = server.service.createSession(actor, { project_id: project.id, title: "Personal model", mode: "multi", idempotency_key: randomUUID() }).session;
  const cookie = server.database.createBrowserSession(actor);
  await context.addCookies([{ name: "gatherthread_session", value: cookie.token, url: origin, httpOnly: true, sameSite: "Strict" }]);
  await context.addInitScript(locale => {
    localStorage.setItem("gt-lang", locale === "zh" ? "zh" : "en");
    const read = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key) { return key.startsWith("gatherthread.onboarding.v1:") ? "skipped" : read.call(this, key); };
  }, locale);
  return { actor, project, session };
}
try {
  for (const [name, engine, locale, viewport, mobile] of [
    ["chrome-desktop", chromium, "zh", { width: 1440, height: 800 }, false],
    ["webkit-phone", webkit, "en", { width: 390, height: 844 }, true],
    ["chrome-tablet", chromium, "en", { width: 1024, height: 768 }, true],
  ]) {
    if (process.env.PERSONAL_API_BROWSER_CASE && process.env.PERSONAL_API_BROWSER_CASE !== name) continue;
    const browser = await engine.launch({ headless: true, ...(engine === chromium && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, reducedMotion: "reduce",
      ...(mobile ? { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1" } : {}) });
    const page = await context.newPage(), errors = [], hostedPosts = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (request.method() === "POST" && request.url().endsWith("/hosted-agent-requests")) hostedPosts.push(request.url());
    });
    let releaseHeldMetadata = () => {};
    page.on("dialog", dialog => dialog.accept());
    await context.route(/^https?:/, route => route.request().url().startsWith(origin + "/") ? route.continue() : route.abort());
    const f = await seed(context, locale);
    const openSettings = async () => { if (mobile) await page.locator("#mobile-tools-button").click(); await page.locator("#settings-button").click(); };
    try {
      await page.goto(`${origin}/app/#project=${f.project.id}&session=${f.session.id}`);
      await page.locator("#code-notice-dialog[open]").waitFor(); await page.locator("#code-notice-continue").click();
      await page.locator("#session-view:not([hidden])").waitFor(); await openSettings();
      await page.locator('.settings-navigation a[href="#settings-personal-api"]').click();
      await page.locator("#cloud-api-new").click();
      for (const [provider, suggested] of [["qwen", "qwen-plus"], ["glm", "glm-5.3"], ["doubao", "doubao-seed-2-1-pro-260915"]]) {
        await page.locator("#cloud-api-provider").selectOption(provider);
        assert.equal(await page.locator("#cloud-api-model").inputValue(), suggested);
      }
      await page.locator("#cloud-api-model").fill("custom-account-model");
      await page.locator("#cloud-api-provider").selectOption("qwen");
      assert.equal(await page.locator("#cloud-api-model").inputValue(), "custom-account-model");
      await page.locator("#cloud-api-provider").selectOption("deepseek");
      await page.locator("#cloud-api-label").fill("Fixture personal model");
      await page.locator("#cloud-api-model").fill("deepseek-chat");
      await page.locator("#cloud-api-key").fill("fixture-k");
      const saved = page.waitForResponse(r => r.request().method() === "PUT" && r.url().includes("/v1/cloud-api/"));
      await page.locator("#cloud-api-save").click(); assert.equal((await saved).status(), 200);
      await page.locator("#cloud-api-editor").waitFor({ state: "hidden" });
      assert.equal(await page.locator("#cloud-api-key").inputValue(), "");
      assert.doesNotMatch(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })), /fixture-k/);
      const stored = await context.request.get(`${origin}/v1/cloud-api`), metadata = (await stored.json()).data;
      assert.doesNotMatch(JSON.stringify(metadata), /fixture-k|api_key|ciphertext/);
      const config = metadata.configurations[0]; assert.equal(config.label, "Fixture personal model");
      await page.locator("#cloud-api-list button").click(); assert.equal(await page.locator("#cloud-api-key").inputValue(), "");
      await page.locator("#cloud-api-provider").selectOption("openai"); await page.locator("#cloud-api-save").click();
      assert.match(await page.locator("#cloud-api-status").textContent(), /新密钥|new API key/);
      await page.locator("#cloud-api-provider").selectOption("deepseek"); await page.locator("#cloud-api-cancel").click();
      await page.locator('.settings-navigation a[href="#settings-agents"]').click();
      await page.locator("#settings-enabled-cloud").check(); await page.locator("#settings-form button[type=submit]").click();
      await page.locator("#settings-dialog").waitFor({ state: "hidden" });
      await page.locator("#mobile-agent-button").click(); await page.locator("#agent-harness-select").selectOption("cloud");
      await page.locator("#agent-cloud-model-select").selectOption(config.profile_id);
      assert.equal(await page.locator("#cloud-agent-include-code").isChecked(), true);
      assert.equal(await page.locator("#cloud-agent-include-code").isDisabled(), true, "no code storage never turns an ordinary question into a file task");
      await page.locator("#mobile-agent-dialog [data-mobile-close]").click();
      await page.locator("#message-input").fill("Answer this small question.");
      const requested = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/hosted-agent-requests"));
      await page.locator("#send-agent-button").click(); const accepted = await requested;
      assert.equal(accepted.status(), 202); assert.equal(accepted.request().postDataJSON().api_config_revision, config.revision);
      assert.equal(accepted.request().postDataJSON().include_code, false);
      await page.getByText("Selected personal model answered.", { exact: true }).waitFor();
      if (mobile) await page.locator("#mobile-tools-button").click();
      await page.locator("#project-code-button").click(); await page.locator("#code-provider-gt-cloud").click();
      await page.locator("#code-enable-button:not([disabled])").waitFor(); await page.locator("#code-enable-button").click();
      const enabledCode = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/code/enable"));
      await page.locator("#code-confirm-accept").click(); assert.equal((await enabledCode).status(), 200);
      // Isolated fixture only: create a usable shared main version, then remove
      // the fixture author's merged personal copy via the normal CAS methods.
      const codeFixture = new CodeRepository(server.database, join(directory, "code"));
      const empty = codeFixture.status(f.actor, f.project.id);
      codeFixture.checkpoint(f.actor, f.project.id, { base_commit: empty.repository.main_commit,
        files: [{ path: "README.md", content_base64: Buffer.from("Shared main fixture\n").toString("base64"), executable: false }],
        message: "Seed shared main", idempotency_key: randomUUID() });
      const own = codeFixture.status(f.actor, f.project.id), branch = own.branches.find(item => item.id === own.own_branch_id);
      codeFixture.review(f.actor, f.project.id, { head_commit: branch.head_commit, idempotency_key: randomUUID() });
      codeFixture.merge(f.actor, f.project.id, { branch_id: branch.id, expected_main_commit: empty.repository.main_commit,
        expected_head_commit: branch.head_commit, idempotency_key: randomUUID() });
      codeFixture.clearBranch(f.actor, f.project.id, { expected_head_commit: branch.head_commit, idempotency_key: randomUUID() });
      const sharedReply = await context.request.get(`${origin}/v1/projects/${f.project.id}/code`);
      assert.equal(sharedReply.status(), 200);
      const shared = (await sharedReply.json()).data;
      assert.equal(shared.repository.enabled, true); assert.equal(shared.own_branch_id, null);
      assert.equal(codeFixture.snapshot(f.actor, f.project.id, "main").snapshot.files[0].path, "README.md");
      await cloudReady();
      const codeUrl = `${origin}/v1/projects/${f.project.id}/code`;
      const enteredMetadata = Promise.withResolvers(), releaseMetadata = Promise.withResolvers();
      releaseHeldMetadata = releaseMetadata.resolve;
      await page.route(codeUrl, async route => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch(); assert.equal(response.status(), 200);
        enteredMetadata.resolve(); await releaseMetadata.promise;
        await route.fulfill({ response });
      });
      await page.locator("#close-project-code-button").click();
      await enteredMetadata.promise;
      await page.waitForFunction(() => document.getElementById("send-agent-button").disabled
        && /Checking GT Cloud|正在检查 GT Cloud/.test(document.getElementById("cloud-agent-code-scope").textContent));
      assert.equal(await page.locator("#cloud-agent-include-code").isChecked(), true, "loading does not silently clear selected code");
      await page.locator("#message-input").fill("Use the available shared main version.");
      const beforeDelayedPosts = hostedPosts.length;
      await clickDisabledAgent();
      assert.equal(hostedPosts.length, beforeDelayedPosts, "a normal click cannot send an empty-directory task while code metadata is delayed");
      assert.equal(await page.locator("#message-input").inputValue(), "Use the available shared main version.");
      const codeRestored = page.waitForResponse(response => response.url() === codeUrl && response.request().method() === "GET");
      releaseMetadata.resolve(); assert.equal((await codeRestored).status(), 200);
      await page.unroute(codeUrl);
      await page.waitForFunction(() => !document.getElementById("send-agent-button").disabled);
      assert.equal(await page.locator("#cloud-agent-include-code").isChecked(), true, "successful metadata restores the same code choice");
      assert.equal(await page.locator("#message-input").inputValue(), "Use the available shared main version.");
      const mainRequested = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/hosted-agent-requests"));
      await page.locator("#send-agent-button").click(); const mainAccepted = await mainRequested;
      assert.equal(mainAccepted.status(), 202); assert.equal(mainAccepted.request().postDataJSON().include_code, true,
        "default-on reads the shared main version when no personal branch exists");
      await page.getByText("Selected personal model answered.", { exact: true }).last().waitFor();
      await cloudReady();
      await page.route(codeUrl, async route => route.request().method() === "GET"
        ? route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: {
          code: "fixture_metadata_unavailable", message: "Isolated metadata failure" } }) }) : route.continue());
      await page.reload(); await page.locator("#session-view:not([hidden])").waitFor();
      await page.waitForFunction(() => document.getElementById("send-agent-button").disabled
        && /Could not check GT Cloud|无法检查 GT Cloud/.test(document.getElementById("cloud-agent-code-scope").textContent));
      await page.locator("#message-input").fill("Keep this draft until I explicitly choose no code.");
      const beforeFailedPosts = hostedPosts.length;
      await clickDisabledAgent();
      assert.equal(hostedPosts.length, beforeFailedPosts, "a failed metadata read cannot silently dispatch a no-code request");
      assert.equal(await page.locator("#message-input").inputValue(), "Keep this draft until I explicitly choose no code.");
      await page.locator("#mobile-agent-button").click();
      assert.equal(await page.locator("#cloud-agent-include-code").isChecked(), true, "failure preserves the desired code selection");
      assert.equal(await page.locator("#cloud-agent-include-code").isDisabled(), false, "the user can explicitly choose an empty workspace after metadata failure");
      await page.locator("#cloud-agent-include-code").uncheck();
      assert.match(await page.locator("#cloud-agent-code-scope").innerText(), /Code is off|代码选项已关闭/);
      await page.locator("#mobile-agent-dialog [data-mobile-close]").click();
      await page.waitForFunction(() => !document.getElementById("send-agent-button").disabled);
      const priorAnswers = await page.getByText("Selected personal model answered.", { exact: true }).count();
      const noCodeRequested = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/hosted-agent-requests"));
      await page.locator("#send-agent-button").click(); const noCodeAccepted = await noCodeRequested;
      assert.equal(noCodeAccepted.status(), 202); assert.equal(noCodeAccepted.request().postDataJSON().include_code, false,
        "only the explicit opt-out allows a no-code request despite failed metadata");
      assert.equal(noCodeAccepted.request().postDataJSON().api_config_revision, config.revision);
      await page.getByText("Selected personal model answered.", { exact: true }).nth(priorAnswers).waitFor();
      await page.unroute(codeUrl);
      await page.reload(); await page.locator("#session-view:not([hidden])").waitFor();
      await page.locator("#mobile-agent-button").click(); await page.locator("#cloud-agent-include-code:not([disabled])").waitFor();
      assert.equal(await page.locator("#cloud-agent-include-code").isChecked(), false, "the user's opt-out survives refresh");
      await page.locator("#agent-cloud-model-select").selectOption("fixture-service");
      assert.equal(await page.locator("#cloud-agent-include-code").isChecked(), false, "model selection cannot opt the user back in");
      await page.locator("#agent-cloud-model-select").selectOption(config.profile_id);
      await page.locator("#cloud-agent-include-code").check(); await page.locator("#mobile-agent-dialog [data-mobile-close]").click();
      // Sensors wrap the real HTTP methods, not UI handlers or network results.
      await page.evaluate(async () => {
        const bootstrapUrl = document.querySelector('script[type="module"]').src;
        const bootstrap = await (await fetch(bootstrapUrl)).text();
        const mainUrl = new URL(bootstrap.match(/import\("([^\"]*main\.js[^\"]*)"\)/)[1], bootstrapUrl).href;
        const main = await (await fetch(mainUrl)).text();
        const apiUrl = new URL(main.match(/from\s+["'](\.\/api\.js(?:\?[^"']*)?)["']/)[1], mainUrl).href;
        const { HttpCollaborationApi } = await import(apiUrl);
        const selection = HttpCollaborationApi.prototype.getHostedAgentSelection;
        const append = HttpCollaborationApi.prototype.appendHostedAgentRequest;
        window.fixtureSelectionSettled = 0; window.fixtureHostedWrites = [];
        HttpCollaborationApi.prototype.getHostedAgentSelection = async function (...args) {
          try { return await selection.apply(this, args); }
          finally { window.fixtureSelectionSettled++; }
        };
        HttpCollaborationApi.prototype.appendHostedAgentRequest = function (...args) {
          window.fixtureHostedWrites.push(structuredClone(args[1]));
          return append.apply(this, args);
        };
      });
      async function cloudReady() {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const response = await context.request.get(`${origin}/v1/hosted-agent`, { headers: { "Cache-Control": "no-store" } });
          assert.equal(response.status(), 200);
          const status = (await response.json()).data;
          if (status.profiles?.find(profile => profile.id === config.profile_id)?.available) return;
          if (status.rate_limits.retry_after_seconds > 0) {
            // Honor the real server's rate-limit deadline, not an arbitrary UI delay.
            await new Promise(done => setTimeout(done, status.rate_limits.retry_after_seconds * 1000));
          } else await page.evaluate(() => new Promise(requestAnimationFrame));
        }
        throw Error("Actual Cloud Agent availability did not settle within 10 seconds");
      }
      async function clickDisabledAgent() {
        const button = page.locator("#send-agent-button"); assert.equal(await button.isDisabled(), true);
        await button.scrollIntoViewIfNeeded();
        const box = await button.boundingBox(); assert.ok(box, "disabled Agent control remains visible and reachable");
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        assert.equal(await button.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), point), true,
          "ordinary pointer hit-tests the disabled button, not a modal or another element");
        if (mobile) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
        await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      }
      const failedCloudRequest = async content => {
        await cloudReady();
        failNextCloudRun = true;
        await page.locator("#message-input").fill(content);
        const reply = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/hosted-agent-requests"));
        await page.locator("#send-agent-button").click();
        const response = await reply; assert.equal(response.status(), 202);
        assert.equal(response.request().postDataJSON().include_code, true, "enabled GT Cloud code is included without rechecking it every turn");
        const request = (await response.json()).data.request_event;
        await page.locator(`.agent-retry-button[data-request-id="${request.id}"]`).waitFor();
        return request;
      };
      const erased = await failedCloudRequest("ERASED_RETRY_INSTRUCTIONS fixture");
      const selectionUrl = `${origin}/v1/sessions/${f.session.id}/hosted-agent-requests/${erased.id}/selection`;
      let release, entered;
      const held = new Promise(done => { release = done; }), captured = new Promise(done => { entered = done; });
      await page.route(selectionUrl, async route => {
        const response = await route.fetch(); assert.equal(response.status(), 200);
        entered(); await held; await route.fulfill({ response });
      });
      await page.locator("#message-input").fill("Keep this unfinished retry draft");
      await page.evaluate(() => { window.fixtureHostedWrites = []; });
      await cloudReady();
      await page.locator(`.agent-retry-button[data-request-id="${erased.id}"]`).click();
      await captured;
      await page.locator(`#message-${erased.id} .message-delete-action`).click();
      await page.locator(`#message-${erased.id} .event-content`).getByText(/消息已删除|Message deleted/, { exact: true }).waitFor();
      release();
      await page.waitForFunction(() => window.fixtureSelectionSettled === 1);
      assert.deepEqual(await page.evaluate(() => window.fixtureHostedWrites), [], "a held selection cannot resubmit erased instructions");
      assert.equal(await page.locator("#message-input").inputValue(), "Keep this unfinished retry draft");
      await page.unroute(selectionUrl);

      // A fresh retry after deletion remains usable and pins the current history.
      const valid = await failedCloudRequest("A fresh, independent retry after deletion");
      await page.locator("#message-input").fill("Keep this new retry draft");
      await page.evaluate(() => { window.fixtureHostedWrites = []; });
      await cloudReady();
      assert.equal(server.database.hostedAgentRateUsage(f.actor, 1).retry_after_seconds, 0, "actual ledger is ready before the retry click");
      const retried = page.waitForResponse(r => r.request().method() === "POST" && r.url().endsWith("/hosted-agent-requests"));
      await page.locator(`.agent-retry-button[data-request-id="${valid.id}"]`).click();
      const retryResponse = await retried; assert.equal(retryResponse.status(), 202,
        retryResponse.ok() ? "Accepted retry" : JSON.stringify({ response: await retryResponse.json(),
          writes: await page.evaluate(() => window.fixtureHostedWrites.map(input => ({ idempotencyKey: input.idempotencyKey, contentRevision: input.contentRevision }))),
          ledger: server.database.hostedAgentRateUsage(f.actor, 1) }));
      assert.equal(retryResponse.request().postDataJSON().content_revision, 1);
      assert.equal(retryResponse.request().postDataJSON().api_config_revision, config.revision);
      await page.getByText("Selected personal model answered.", { exact: true }).last().waitFor();
      assert.equal(await page.locator("#message-input").inputValue(), "Keep this new retry draft");
      await openSettings(); await page.locator('.settings-navigation a[href="#settings-personal-api"]').click();
      await page.locator("#cloud-api-list button").click(); await page.locator("#cloud-api-enabled").uncheck();
      const paused = page.waitForResponse(r => r.request().method() === "PUT" && r.url().includes("/v1/cloud-api/"));
      await page.locator("#cloud-api-save").click(); assert.equal((await paused).status(), 200);
      await page.locator("#cloud-api-editor").waitFor({ state: "hidden" }); await page.locator("#cloud-api-list button").click();
      const deleted = page.waitForResponse(r => r.request().method() === "DELETE" && r.url().includes("/v1/cloud-api/"));
      await page.locator("#cloud-api-delete").click(); assert.equal((await deleted).status(), 204);
      await page.locator("#cloud-api-editor").waitFor({ state: "hidden" }); assert.equal(await page.locator("#cloud-api-list li").count(), 0);
      assert.equal(await page.locator("#settings-dialog").evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
      assert.deepEqual(errors, []); console.log(`${name}: domestic presets/custom IDs, GT Cloud delayed/failed metadata blocks dispatch until confirmation or explicit opt-out, preference persistence, private API, deletion fence, retry drafts, pause/delete; ordinary clicks passed`);
    } finally { releaseHeldMetadata(); await context.close(); await browser.close(); }
  }
} finally { await server.close(); rmSync(directory, { recursive: true, force: true }); }
