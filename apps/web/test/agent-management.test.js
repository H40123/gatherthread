import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { mountAgentManagement } from "../src/agent-management.js";

function fixture() {
  let context = { scope: "account-a:project-a", available: true };
  const nodes = new Map();
  const document = { activeElement: null, getElementById: id => nodes.get(id),
    querySelectorAll: () => [...nodes.values()].filter(node => node.id.endsWith("dialog") && node.open) };
  class Node {
    hidden = false; disabled = false; open = false; isConnected = true; parent = null;
    listeners = new Map(); attributes = new Map();
    constructor(id) { this.id = id; nodes.set(id, this); }
    addEventListener(type, listener) { const entries = this.listeners.get(type) ?? []; entries.push(listener); this.listeners.set(type, entries); }
    fire(type, event = {}) { for (const listener of this.listeners.get(type) ?? []) listener({ target: this, ...event }); }
    click() { if (!this.disabled) { this.focus(); this.fire("click"); } }
    focus() { if (this.isConnected && !this.hidden && !this.disabled) document.activeElement = this; }
    showModal() { this.open = true; }
    close() { if (this.open) { this.open = false; this.fire("close"); } }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    getClientRects() { return this.isConnected && !this.hidden ? [{}] : []; }
    contains(other) { for (let node = other; node; node = node.parent) if (node === this) return true; return false; }
    closest() { for (let node = this; node; node = node.parent)
      if (node.hidden || node.id.endsWith("dialog") && !node.open) return node;
      return null; }
  }
  for (const id of ["manage-agents-button", "agent-management-dialog", "agent-management-title", "agent-management-overview",
    "agent-management-connections", "agent-management-add", "agent-management-back", "agent-management-close",
    "connect-codex-button", "connect-dsh-button", "connect-claude-button", "add-agent-button", "agent-sharing-button", "agent-teams-button", "external-trigger",
    "connect-codex-dialog", "connect-dsh-dialog", "connect-claude-dialog", "settings-dialog", "agent-sharing-dialog", "agent-team-dialog"]) new Node(id);
  const el = id => document.getElementById(id);
  for (const id of ["agent-management-overview", "agent-management-connections", "agent-management-back", "agent-management-close"])
    el(id).parent = el("agent-management-dialog");
  for (const id of ["agent-management-add", "agent-sharing-button", "agent-teams-button"]) el(id).parent = el("agent-management-overview");
  for (const id of ["connect-codex-button", "connect-dsh-button", "connect-claude-button", "add-agent-button"]) el(id).parent = el("agent-management-connections");
  el("agent-management-connections").hidden = true; el("agent-management-back").hidden = true;
  const ui = mountAgentManagement({ document, getContext: () => context });
  ui.updateContext();
  return { ui, document, el, setContext(value) { context = value; }, context: () => context };
}

test("Agent management opens at its overview and provides keyboard focus for both navigation levels", () => {
  const f = fixture(), dialog = f.el("agent-management-dialog");
  f.el("manage-agents-button").click();
  assert.equal(dialog.open, true);
  assert.equal(f.el("agent-management-overview").hidden, false);
  assert.equal(f.el("agent-management-connections").hidden, true);
  assert.equal(f.el("agent-management-back").hidden, true);
  assert.equal(f.document.activeElement, f.el("agent-management-add"));
  f.el("agent-management-add").click();
  assert.equal(f.el("agent-management-overview").hidden, true);
  assert.equal(f.el("agent-management-connections").hidden, false);
  assert.equal(f.el("agent-management-back").hidden, false);
  assert.equal(f.document.activeElement, f.el("agent-management-back"));
  f.el("agent-management-back").click();
  assert.equal(dialog.open, true);
  assert.equal(f.el("agent-management-overview").hidden, false);
  assert.equal(f.el("agent-management-connections").hidden, true);
  assert.equal(f.document.activeElement, f.el("agent-management-add"));
});

test("closing from the connection page returns focus and reopening starts from the overview", () => {
  const f = fixture();
  f.el("manage-agents-button").click(); f.el("agent-management-add").click();
  f.el("agent-management-close").click();
  assert.equal(f.el("agent-management-dialog").open, false);
  assert.equal(f.document.activeElement, f.el("manage-agents-button"));
  f.el("manage-agents-button").click();
  assert.equal(f.el("agent-management-overview").hidden, false);
  assert.equal(f.el("agent-management-connections").hidden, true);
  assert.equal(f.el("agent-management-back").hidden, true);
});

test("native dialog close and programmatic close restore the original visible trigger", () => {
  const f = fixture();
  f.el("external-trigger").focus(); f.ui.open();
  f.el("agent-management-dialog").close();
  assert.equal(f.document.activeElement, f.el("external-trigger"));
  f.el("external-trigger").focus(); f.ui.open(); f.ui.close();
  assert.equal(f.document.activeElement, f.el("external-trigger"));
});

test("a hidden or removed original trigger does not trap focus in a closed management dialog", () => {
  for (const change of [node => { node.hidden = true; }, node => { node.isConnected = false; }]) {
    const f = fixture(); f.el("external-trigger").focus(); f.ui.open();
    change(f.el("external-trigger")); f.ui.close();
    assert.equal(f.document.activeElement, f.el("manage-agents-button"));
  }
});

test("changing account/project scope closes the stale view without initiating any Agent operation", () => {
  const f = fixture(), calls = [];
  for (const id of ["connect-codex-button", "connect-dsh-button", "connect-claude-button", "add-agent-button", "agent-sharing-button", "agent-teams-button"])
    f.el(id).addEventListener("click", () => calls.push(id));
  f.el("manage-agents-button").click(); f.el("agent-management-add").click();
  f.setContext({ scope: "account-a:project-b", available: true }); f.ui.updateContext();
  assert.equal(f.el("agent-management-dialog").open, false);
  assert.equal(f.el("manage-agents-button").disabled, false);
  assert.deepEqual(calls, []);
  f.ui.open(); assert.equal(f.el("agent-management-overview").hidden, false);
  f.setContext({ scope: "account-b:project-b", available: true }); f.ui.updateContext();
  assert.equal(f.el("agent-management-dialog").open, false);
});

test("unavailable context closes the panel and cannot be bypassed by calling open directly", () => {
  const f = fixture(); f.ui.open();
  f.setContext({ scope: "account-a:project-a", available: false }); f.ui.updateContext();
  assert.equal(f.el("agent-management-dialog").open, false);
  assert.equal(f.el("manage-agents-button").disabled, true);
  f.ui.open(); assert.equal(f.el("agent-management-dialog").open, false);
  f.setContext({ scope: "account-a:project-a", available: true }); f.ui.updateContext();
  f.el("manage-agents-button").click(); assert.equal(f.el("agent-management-dialog").open, true);
});

test("opening rechecks current availability even before the rest of the shell rerenders", () => {
  const f = fixture();
  f.setContext({ scope: "account-a:project-a", available: false });
  assert.equal(f.el("manage-agents-button").disabled, false, "the old rendered state is still available");
  f.el("manage-agents-button").click();
  assert.equal(f.el("manage-agents-button").disabled, true);
  assert.equal(f.el("agent-management-dialog").open, false);
});

test("navigation preserves existing connection, sharing and Team handlers and disabled state", () => {
  const f = fixture(), calls = [];
  const ids = ["connect-codex-button", "connect-dsh-button", "connect-claude-button", "add-agent-button", "agent-sharing-button", "agent-teams-button"];
  const originals = ids.map(id => f.el(id));
  for (const id of ids) f.el(id).addEventListener("click", () => calls.push(id));
  f.el("agent-sharing-button").disabled = true;
  f.el("manage-agents-button").click(); f.el("agent-management-add").click();
  f.el("connect-codex-button").click(); f.el("connect-dsh-button").click(); f.el("connect-claude-button").click(); f.el("add-agent-button").click();
  f.el("agent-management-back").click(); f.el("agent-sharing-button").click(); f.el("agent-teams-button").click();
  assert.deepEqual(calls, ["connect-codex-button", "connect-dsh-button", "connect-claude-button", "add-agent-button", "agent-teams-button"]);
  assert.equal(f.el("agent-sharing-button").disabled, true);
  assert.deepEqual(ids.map(id => f.el(id)), originals);
});

test("closing an original child dialog can recover focus to its corresponding visible menu entry", () => {
  for (const [dialogId, entryId, connectionPage] of [["connect-codex-dialog", "connect-codex-button", true],
    ["connect-dsh-dialog", "connect-dsh-button", true], ["connect-claude-dialog", "connect-claude-button", true], ["settings-dialog", "add-agent-button", true],
    ["agent-sharing-dialog", "agent-sharing-button", false], ["agent-team-dialog", "agent-teams-button", false]]) {
    const f = fixture(); f.ui.open();
    if (connectionPage) f.el("agent-management-add").click();
    f.el(dialogId).showModal(); f.el("external-trigger").focus(); f.el(dialogId).close();
    assert.equal(f.document.activeElement, f.el(entryId), dialogId);
    assert.equal(f.el("agent-management-dialog").open, true);
  }
});

test("child-dialog focus recovery does not override native focus or another open modal", () => {
  const f = fixture(); f.ui.open(); f.el("agent-management-add").click();
  f.el("connect-codex-dialog").showModal(); f.el("agent-management-back").focus(); f.el("connect-codex-dialog").close();
  assert.equal(f.document.activeElement, f.el("agent-management-back"));
  f.el("connect-codex-dialog").showModal(); f.el("settings-dialog").showModal(); f.el("external-trigger").focus();
  f.el("connect-codex-dialog").close();
  assert.equal(f.document.activeElement, f.el("external-trigger"));
  f.ui.close(); f.el("external-trigger").focus(); f.el("settings-dialog").close();
  assert.equal(f.document.activeElement, f.el("external-trigger"), "closed management menu cannot reclaim focus");
});

function elementMarkup(html, id) {
  const opening = new RegExp(`<([a-z][\\w-]*)\\b[^>]*\\bid="${id}"[^>]*>`, "iu").exec(html);
  assert.ok(opening, id);
  const tag = opening[1], tokens = new RegExp(`</?${tag}\\b[^>]*>`, "giu");
  tokens.lastIndex = opening.index + opening[0].length;
  let depth = 1, token;
  while ((token = tokens.exec(html))) {
    depth += token[0].startsWith("</") ? -1 : 1;
    if (!depth) return html.slice(opening.index, tokens.lastIndex);
  }
  assert.fail(`Unclosed ${id}`);
}

test("the composer exposes one management entry beside model selection and retains the original dialog controls", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const rail = elementMarkup(html, "session-rail"), dialog = elementMarkup(html, "agent-management-dialog");
  const overview = elementMarkup(dialog, "agent-management-overview"), connections = elementMarkup(dialog, "agent-management-connections");
  const controls = elementMarkup(html, "composer-agent-controls");
  assert.doesNotMatch(rail, /id="manage-agents-button"/u);
  assert.equal([...html.matchAll(/\bid="manage-agents-button"/gu)].length, 1);
  assert.match(controls, /id="mobile-agent-button"[\s\S]*?id="manage-agents-button"/u);
  assert.match(elementMarkup(controls, "manage-agents-button"), /aria-controls="agent-management-dialog"/u);
  assert.match(elementMarkup(controls, "manage-agents-button"), /class="[^"]*\bbutton-primary\b/u);
  for (const id of ["connect-codex-button", "connect-dsh-button", "connect-claude-button", "add-agent-button", "agent-sharing-button", "agent-teams-button"]) {
    assert.equal([...html.matchAll(new RegExp(`\\bid="${id}"`, "gu"))].length, 1, id);
    assert.doesNotMatch(rail, new RegExp(`\\bid="${id}"`, "u"));
    assert.match(id.startsWith("agent-") ? overview : connections, new RegExp(`\\bid="${id}"`, "u"));
    assert.match(elementMarkup(dialog, id), /type="button"/u);
  }
  assert.match(elementMarkup(connections, "add-agent-button"), /aria-controls="settings-dialog"/u);
  assert.match(elementMarkup(overview, "agent-sharing-button"), /aria-controls="agent-sharing-dialog"/u);
  assert.match(elementMarkup(overview, "agent-teams-button"), /aria-controls="agent-team-dialog"/u);
});
