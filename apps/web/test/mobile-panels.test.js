import assert from "node:assert/strict";
import test from "node:test";
import { mountMobilePanels, sessionMatchesQuery, sessionNavigationLeavesPanel } from "../src/mobile-panels.js";

function fixture() {
  class Node {
    children = []; parentNode = null; attributes = new Map(); listeners = {}; hidden = false; value = ""; className = ""; _text = "";
    constructor(tag = "div", id = "") { this.tagName = tag.toUpperCase(); this.id = id; }
    get classList() { return { contains: value => this.className.split(" ").includes(value) }; }
    get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
    set textContent(value) { this._text = value; this.children = []; }
    append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } }
    remove() { if (this.parentNode) { this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; } }
    before(node) {
      node.remove(); const parent = this.parentNode;
      parent.children.splice(parent.children.indexOf(this), 0, node); node.parentNode = parent;
    }
    after(node) {
      node.remove(); const parent = this.parentNode;
      parent.children.splice(parent.children.indexOf(this) + 1, 0, node); node.parentNode = parent;
    }
    matches(selector) { return selector.startsWith(".") ? this.classList.contains(selector.slice(1)) : selector.startsWith("#") ? this.id === selector.slice(1) : this.tagName.toLowerCase() === selector; }
    querySelector(selector) { for (const child of this.children) { if (child.matches(selector)) return child; const found = child.querySelector(selector); if (found) return found; } return null; }
    closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name); }
    addEventListener(name, listener) { (this.listeners[name] ??= []).push(listener); }
    fire(name, event = {}) { for (const listener of this.listeners[name] ?? []) listener({ target: this, ...event }); }
    focus() { document.activeElement = this; }
  }
  const body = new Node("body");
  const document = { body, activeElement: body, createElement: tag => new Node(tag), createComment: () => new Node("#comment"),
    getElementById: id => body.id === id ? body : body.querySelector(`#${id}`) };
  const add = (id, parent = body, tag = "div", className = "") => { const node = new Node(tag, id); node.className = className; parent.append(node); return node; };
  const sessionsHost = add("mobile-sessions-content"), membersHost = add("mobile-members-content"), tools = add("mobile-tools-content");
  const rail = add("session-rail"); const heading = add("", rail); const select = add("project-select", heading, "select");
  const projectCreate = add("new-project-button", heading, "button"); const sessionCreate = add("new-session-button", rail, "button");
  const list = add("session-list", rail, "ul");
  for (const name of ["Plan the launch", "Build the UI", "会议记录"]) { const row = add("", list, "li"); const button = add("", row, "button", "session-button"); button.textContent = name; }
  const projectActions = add("", rail, "div", "project-action-row"); add("rename-project-button", projectActions, "button");
  const memberPanel = add("member-panel"); const memberHeading = add("", memberPanel, "div", "member-heading");
  const memberList = add("member-list", memberPanel, "ul"); const owner = add("owner-invitations", memberPanel, "section", "invitation-card"); owner.hidden = true;
  add("create-invitation-form", owner, "form"); const joinSection = add("", memberPanel, "section", "invitation-card");
  const join = add("accept-invitation-form", joinSection, "form");
  const originalTools = new Map();
  for (const id of ["mentions-button", "history-summary-select-button", "history-summary-view-button", "history-summary-versions-button", "project-code-button", "mobile-members-button", "settings-button", "rename-session-button", "delete-session-button", "session-context-details", "logout-button"]) {
    const button = add(id, tools, "button", "icon-button"); button.setAttribute("aria-label", id); originalTools.set(id, button);
  }
  let notify;
  const window = { MutationObserver: class { constructor(callback) { notify = callback; } observe() {} } };
  const panels = mountMobilePanels({ document, window });
  return { document, panels, rail, list, select, projectCreate, sessionCreate, projectActions, memberPanel, memberHeading, memberList, owner, join, joinSection,
    sessionsHost, membersHost, tools, originalTools, notify: () => notify(), el: document.getElementById };
}

test("session search is literal, case-insensitive and works with full-width input", () => {
  assert.equal(sessionMatchesQuery("Build the UI", " ui "), true);
  assert.equal(sessionMatchesQuery("BUILD", "ｂｕｉｌｄ"), true);
  assert.equal(sessionMatchesQuery("会议记录", "会议"), true);
  assert.equal(sessionMatchesQuery("<script>", "<script>"), true);
  assert.equal(sessionMatchesQuery("Plan", "nomatch"), false);
});

test("only actual selections and native dialog actions close conversation navigation", () => {
  const button = (id, session = false, disabled = false) => ({ id, disabled, classList: { contains: value => session && value === "session-button" } });
  for (const id of ["new-session-button", "new-project-button", "rename-project-button", "delete-project-button", "leave-project-button"]) assert.equal(sessionNavigationLeavesPanel(button(id)), true);
  assert.equal(sessionNavigationLeavesPanel(button("", true)), true);
  for (const id of ["mobile-project-options", "mobile-project-management-back", "mobile-session-search", "random-button"]) assert.equal(sessionNavigationLeavesPanel(button(id)), false);
  assert.equal(sessionNavigationLeavesPanel(button("new-project-button", false, true)), false);
  assert.equal(sessionNavigationLeavesPanel(null), false);
});

test("mobile panels move the original controls and restore their precise desktop parents", () => {
  const f = fixture(); const originalSelectParent = f.select.parentNode, originalCreateParent = f.projectCreate.parentNode;
  assert.equal(f.select.parentNode, originalSelectParent);
  f.panels.setActive(true);
  assert.equal(f.el("mobile-project-options").textContent, "•••");
  assert.equal(f.el("mobile-project-options").getAttribute("aria-label"), "Project options");
  assert.equal(f.select.parentNode.className, "mobile-project-field");
  assert.equal(f.sessionCreate.parentNode.className, "mobile-new-conversation");
  assert.equal(f.list.parentNode.className, "mobile-conversation-list");
  assert.equal(f.memberList.parentNode.className, "mobile-members-list");
  assert.equal(f.owner.parentNode.id, "mobile-invitations-page");
  f.panels.setActive(false);
  assert.equal(f.select.parentNode, originalSelectParent);
  assert.equal(f.projectCreate.parentNode, originalCreateParent);
  assert.equal(f.sessionCreate.parentNode, f.rail);
  assert.equal(f.list.parentNode, f.rail);
  assert.equal(f.owner.parentNode, f.memberPanel);
  assert.equal(f.joinSection.parentNode, f.memberPanel);
  for (const button of f.originalTools.values()) assert.equal(button.parentNode, f.tools);
  assert.equal(f.owner.hidden, true, "presentation never grants owner permissions");
});

test("search filters newly rendered conversations and clears before desktop restoration", () => {
  const f = fixture(); f.panels.setActive(true);
  const search = f.el("mobile-session-search"); search.value = "UI"; search.fire("input");
  assert.deepEqual(f.list.children.map(row => row.hidden), [true, false, true]);
  search.value = "nothing"; search.fire("input"); assert.equal(f.el("mobile-session-search-empty").hidden, false);
  f.panels.setActive(false); assert.ok(f.list.children.every(row => !row.hidden));
  f.panels.setActive(true); assert.equal(search.value, ""); assert.ok(f.list.children.every(row => !row.hidden));
});

test("project options and member invitation forms are separate reachable pages", () => {
  const f = fixture(); f.panels.setActive(true);
  f.el("mobile-project-options").fire("click");
  assert.equal(f.el("mobile-session-home").hidden, true); assert.equal(f.el("mobile-project-management").hidden, false);
  f.el("mobile-project-management-back").fire("click"); assert.equal(f.el("mobile-session-home").hidden, false);
  assert.equal(f.el("mobile-open-invitations").hidden, true);
  f.el("mobile-open-join").fire("click"); assert.equal(f.el("mobile-join-page").hidden, false); assert.equal(f.el("mobile-members-home").hidden, true);
  f.panels.open("mobile-members-dialog"); assert.equal(f.el("mobile-members-home").hidden, false);
  f.owner.hidden = false; f.notify(); assert.equal(f.el("mobile-open-invitations").hidden, false);
  f.el("mobile-open-invitations").fire("click"); assert.equal(f.el("mobile-invitations-page").hidden, false);
  f.owner.hidden = true; f.notify(); assert.equal(f.el("mobile-members-home").hidden, false);
});

test("presentation retains existing action handlers instead of duplicating request paths", () => {
  const f = fixture(); let calls = 0; f.sessionCreate.addEventListener("click", () => calls++);
  f.panels.setActive(true); f.sessionCreate.fire("click");
  f.panels.setActive(false); f.sessionCreate.fire("click"); assert.equal(calls, 2);
  assert.equal(f.originalTools.get("project-code-button").parentNode, f.tools);
});
