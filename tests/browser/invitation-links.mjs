// Isolated invitation presentation fixtures. No real account or capability is used.
// Server tests separately verify membership writes and invitation authorization.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWebServer } from "../../apps/web/scripts/serve.mjs";

const { chromium, webkit } = await import(process.env.PLAYWRIGHT_MODULE_PATH
  ? pathToFileURL(resolve(process.env.PLAYWRIGHT_MODULE_PATH)).href : "playwright");
const root = resolve("apps/web/dist");
const bootstrap = readFileSync(resolve(root, "app/src/bootstrap.js"), "utf8");
const mainName = bootstrap.match(/import\("\.\/([^\"]*main\.js[^\"]*)"\)/)[1];
const main = readFileSync(resolve(root, "app/src", mainName.split("?")[0]), "utf8");
const apiName = main.match(/from\s+["'](\.\/api\.js(?:\?[^"']*)?)["']/)[1];
const server = createWebServer({ root, host: "127.0.0.1", port: 0, upstream: new URL("http://127.0.0.1:1") });
await new Promise(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const token = `gti_${"fixture".repeat(6)}`;
const cases = [
  ["chromium-desktop", chromium, "en", 1440, 900, false],
  ["webkit-phone", webkit, "zh-CN", 390, 844, true],
  ["chromium-narrow", chromium, "en", 320, 740, true],
];
let passed = 0;

async function workspace(page) {
  // Mock mode deliberately forgets authentication on reload. Re-enter through
  // the normal form; production Cookie restoration is covered by server tests.
  await page.waitForFunction(() => !document.getElementById("auth-view").hidden
    || !document.getElementById("workspace").hidden || document.getElementById("code-notice-dialog").open);
  if (await page.locator("#auth-view").isVisible()) await signIn(page);
  await page.locator("#workspace:not([hidden]), #code-notice-dialog[open]").first().waitFor();
  if (await page.locator("#code-notice-dialog[open]").isVisible()) await page.locator("#code-notice-continue").click();
  await page.locator("#session-view:not([hidden])").waitFor();
}

async function signIn(page) {
  await page.locator("#auth-select-email-login").click();
  await page.locator("#email-login-email").fill("demo@example.invalid");
  await page.locator("#email-login-password").fill("isolated demo password");
  await page.locator("#email-login-form button[type=submit]").click();
}

try {
  for (const [name, engine, locale, width, height, mobile] of cases) {
    const browser = await engine.launch({ headless: true, ...(engine === chromium && process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    try {
      for (const scenario of ["join", "member", "decline", "expired", "switch"]) {
        const state = { signedIn: scenario !== "join", member: scenario === "member", accepts: 0, previews: 0 };
        const context = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile,
          reducedMotion: "reduce" });
        const page = await context.newPage(), errors = [];
        page.setDefaultTimeout(10_000);
        page.on("pageerror", error => errors.push(error.message));
        await page.exposeFunction("invitationFixture", async (action, capability) => {
          if (action === "session") return state.signedIn;
          if (action === "login") { state.signedIn = true; return true; }
          if (action === "logout") { state.signedIn = false; return true; }
          assert.equal(capability, token);
          if (action === "accept") { state.accepts++; state.member = true; return true; }
          state.previews++;
          return { expired: scenario === "expired", member: state.member };
        });
        await context.addInitScript(locale => {
          localStorage.setItem("gt-lang", locale === "zh-CN" ? "zh" : "en");
          const getItem = Storage.prototype.getItem;
          Storage.prototype.getItem = function (key) { return key.startsWith("gatherthread.onboarding.v1:") ? "skipped" : getItem.call(this, key); };
        }, locale);
        await context.route(/^https?:/, async route => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) return route.abort();
          if (!url.pathname.endsWith("/src/bootstrap.js")) return route.continue();
          const fixture = `import { MockCollaborationApi, ApiError } from ${JSON.stringify(apiName)};
            const proto = MockCollaborationApi.prototype, login = proto.loginWithEmail;
            proto.restoreSession = async function () { return await window.invitationFixture("session")
              ? { ...this.currentUser, device_id: "device-demo" } : null; };
            proto.loginWithEmail = async function (input) { const result = await login.call(this, input);
              await window.invitationFixture("login"); return result; };
            proto.logout = async function () { await window.invitationFixture("logout"); };
            proto.previewInvitation = async function (capability) {
              const result = await window.invitationFixture("preview", capability);
              if (result.expired) throw new ApiError("Unavailable", { status: 410, code: "invitation_unavailable" });
              return { project: { id: "project-orbit", title: "Fixture <project>" }, inviter_display_name: "Fixture inviter",
                role: "participant", created_at: "2026-10-12T00:00:00Z", expires_at: "2099-10-12T00:00:00Z", already_member: result.member };
            };
            proto.acceptInvitation = async function (capability) {
              await window.invitationFixture("accept", capability); return { invitation: { projectId: "project-orbit" } };
            };`;
          return route.fulfill({ status: 200, contentType: "text/javascript", body: fixture + "\n" + bootstrap });
        });
        try {
          await page.goto(`${origin}/app/?mock=1#invite=${token}`);
          await page.locator("#auth-view:not([hidden])").waitFor();
          if (scenario === "join") {
            await page.locator("#auth-view:not([hidden])").waitFor();
            assert.equal(state.previews, 0, "no preview before authentication");
            assert.equal(state.accepts, 0);
          }
          await signIn(page);
          await page.locator("#invitation-link-view:not([hidden])").waitFor();
          if (scenario === "expired") {
            await page.locator("#invitation-retry-button:not([hidden])").waitFor();
            assert.equal(await page.locator("#invitation-confirm-button").isDisabled(), true);
            await page.locator("#invitation-retry-button").click();
            await page.waitForFunction(() => document.querySelector("#invitation-link-view").getAttribute("aria-busy") === "false");
            assert.equal(state.accepts, 0);
            assert.ok(state.previews >= 2);
          } else {
            await page.locator("#invitation-details:not([hidden])").waitFor();
            assert.match(await page.locator("#invitation-link-title").textContent(), /Fixture <project>/);
            assert.equal(await page.locator("#invitation-link-title project").count(), 0, "title is text, not injected markup");
            assert.equal(state.accepts, 0, "preview does not join automatically");
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "no horizontal overflow");
            if (scenario === "decline") {
              await page.locator("#invitation-decline-button").click();
              await workspace(page);
              assert.doesNotMatch(page.url(), /invite=/);
              assert.equal(state.accepts, 0);
            } else if (scenario === "switch") {
              await page.locator("#invitation-switch-account-button").click();
              await page.locator("#auth-view:not([hidden])").waitFor();
              assert.equal(state.signedIn, false);
              assert.equal(state.accepts, 0);
              assert.match(page.url(), /invite=/, "switching account retains the pending capability");
            } else {
              await page.locator("#invitation-confirm-button").click();
              await page.waitForURL(/#project=project-orbit$/);
              await workspace(page);
              assert.equal(state.accepts, scenario === "member" ? 0 : 1);
              assert.ok(state.previews >= 2, "confirm revalidates preview");
              assert.doesNotMatch(page.url(), /invite=/);
            }
          }
          assert.deepEqual(errors, []);
          console.log(`PASS ${name}: ${scenario}`);
          passed++;
        } catch (error) {
          console.error(name, scenario, { state, errors, presentation: await page.evaluate(() => ({
            boot: document.documentElement.dataset.bootState,
            authHidden: document.getElementById("auth-view").hidden,
            workspaceHidden: document.getElementById("workspace").hidden,
            invitationHidden: document.getElementById("invitation-link-view").hidden,
            authError: document.getElementById("email-login-error")?.textContent,
          })) });
          throw error;
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  }
  console.log(`Invitation pointer checks passed: ${passed}`);
} finally { await new Promise(done => server.close(done)); }
