import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as settings from "../src/settings.js";
import { importPreferences } from "../src/configuration.js";

// Execute the actual form integration: helper-only roundtrips cannot detect
// project-profile setters overwriting imported browser defaults during Save.
const source = readFileSync(new URL("../src/main.js", import.meta.url), "utf8");
const parsed = ts.createSourceFile("main.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ["currentProjectProfile", "currentProjectHarness", "settingsEnabledHarnesses", "populateSettingsForm",
  "readSettingsForm", "cancelSettingsDialog", "resetSettingsPreview", "saveSettings", "captureWorkspaceScope"];
const selected = parsed.statements.filter(statement => ts.isFunctionDeclaration(statement) && functions.includes(statement.name?.text)
  || ts.isVariableStatement(statement) && statement.declarationList.declarations.some(declaration => declaration.name.getText(parsed) === "preferencesConfiguration")
  || ts.isExpressionStatement(statement) && statement.getText(parsed).startsWith('settingsDialog.addEventListener("close",'));
assert.equal(selected.length, functions.length + 2, "the tested form integration must be found in main.js");
const integrationSource = selected.map(statement => statement.getText(parsed)).join("\n");

function fixture() {
  const projectId = "project-config-review";
  const initial = settings.withProjectCodexProfile(settings.withProjectAgentHarness(settings.DEFAULT_SETTINGS, projectId, "codex"),
    projectId, { model: "exact-local-model", effort: "medium" });
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", checked: false, disabled: false, hidden: false,
      textContent: "", focus() {} });
    return elements.get(id);
  };
  const listeners = new Map();
  const dialog = { open: true, addEventListener(type, listener) { listeners.set(type, listener); },
    close() { this.open = false; listeners.get("close")?.(); } };
  const writes = [], modes = [], announcements = [], requests = [];
  let preference = "desktop", configuration;
  const noop = () => {};
  const context = vm.createContext({ ...settings, document: {}, structuredClone,
    state: { settings: initial, currentUser: { id: "actor-1", device_id: "device-1" }, project: { id: projectId },
      session: null, sync: { phase: "live" }, executionRuntimes: [], devices: [] },
    settingsPreview: initial, importedInterfaceMode: undefined, importedAgentDefaults: undefined,
    authenticationGeneration: 1, selectedSessionGeneration: 1, settingsDeviceLoadGeneration: 1,
    settingsHistoryPolicyGeneration: 1, settingsHistoryPolicy: null, settingsReturnFocus: null,
    accountDeletionGeneration: 1, accountDeletionPreview: null, currentDeviceName: "This browser",
    teamComposerActive: false, sharedComposerActive: false, exampleMode: false,
    DSH_HARNESS: "deepseek-harness", CLOUD_AGENT_ENTRY_ENABLED: true,
    CONTEXT_BUDGET_MIN_BYTES: 8192, CONTEXT_BUDGET_MAX_BYTES: 5 * 1024 * 1024,
    element, settingsDialog: dialog, localizer: { t: value => value },
    interfaceMode: { getPreference: () => preference, setPreference(value) { preference = value; modes.push(value); } },
    settingsStore: { get: () => initial, set(value) { writes.push(structuredClone(value)); return settings.normalizeSettings(value); } },
    mountPreferencesConfiguration(options) { configuration = options; return { close: noop }; },
    advertisedCodexModels: () => [], isAlternativeNative: harness => ["deepseek-harness", "claude-code"].includes(harness),
    renderCloudModelOptions: (select, value) => { select.value = value ?? ""; },
    renderModelOptions: (select, value) => { select.value = value; },
    updateEffortControl: (_model, effort, value) => { effort.value = value; },
    renderDshRuntimeOptions: noop, syncSettingsAgentControls: noop, syncAllNumericPresets: noop,
    renderContextDiagnostic: noop, applyVisualSettings: noop, renderProjectAgentButtons: noop,
    renderAgentProfileControls: noop, refreshInterfacePresentation: noop, hideAttentionNotice: noop,
    mobileSettings: { open: noop }, mobileWorkspace: { isActive: () => false },
    codeStorageSettings: { cancel: noop }, accountDevices: { clear: noop }, personalCloudApi: { clear: noop },
    notificationPermissionNeeded: () => false, INITIAL_CONNECTION_NOTICE_STATE: {}, connectionNoticeState: {},
    advanceConnectionNotice: () => ({ state: {} }), announce: message => announcements.push(message),
    contextBudgetInputBytes: (value, unit) => Number(value) * (unit === "MiB" ? 1024 * 1024 : 1024),
    api: { async renameDevice(id, name) { requests.push({ id, name }); return { name }; } },
  });
  vm.runInContext(integrationSource, context);
  context.populateSettingsForm(initial);
  element("settings-device-name").value = "This browser";
  element("settings-device-name").disabled = true;
  const stage = patch => configuration.onStage(importPreferences(JSON.stringify({ version: 1,
    kind: "gatherthread.preferences", ...patch }), configuration.getSettings()));
  const save = () => context.saveSettings({ preventDefault: noop, submitter: { disabled: false } });
  return { context, projectId, initial, stage, save, element, dialog, writes, modes, announcements, requests };
}

test("JSON preferences stage first; Save retains browser defaults and the current exact project Agent", async () => {
  const f = fixture();
  const originalProject = structuredClone(f.initial.agents.projectProfiles[f.projectId]);
  f.stage({ interface_mode: "mobile", settings: { appearance: { theme: "dark" },
    agents: { activeHarness: "cloud", enabledHarnesses: ["cloud"] } } });
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.modes, []);
  assert.equal(f.context.state.settings.agents.activeHarness, "codex");
  assert.equal(f.element("settings-agent-harness").value, "codex");
  assert.equal(f.element("settings-interface-mode").value, "mobile");
  const reread = f.context.readSettingsForm();
  assert.equal(reread.agents.activeHarness, "cloud");
  assert.deepEqual([...reread.agents.enabledHarnesses], ["cloud"]);
  await f.save();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].agents.activeHarness, "cloud");
  assert.deepEqual(f.writes[0].agents.enabledHarnesses, ["cloud"]);
  assert.deepEqual(f.writes[0].agents.projectProfiles[f.projectId], originalProject);
  assert.equal(f.writes[0].appearance.theme, "dark");
  assert.deepEqual(f.modes, ["mobile"]);
  assert.equal(f.dialog.open, false);
});

test("Cancel discards imported defaults and interface mode without changing persisted preferences", () => {
  const f = fixture();
  f.stage({ interface_mode: "mobile", settings: { appearance: { theme: "dark" },
    agents: { activeHarness: "cloud", enabledHarnesses: ["cloud"] } } });
  f.context.cancelSettingsDialog();
  assert.equal(f.dialog.open, false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.modes, []);
  assert.equal(f.context.importedInterfaceMode, undefined);
  assert.equal(f.context.importedAgentDefaults, undefined);
  assert.deepEqual(f.context.settingsPreview, f.initial);
});

test("Reset followed by Save cannot reapply the previously imported hidden interface mode", async () => {
  const f = fixture();
  f.stage({ interface_mode: "mobile", settings: { appearance: { theme: "dark" },
    agents: { activeHarness: "cloud", enabledHarnesses: ["cloud"] } } });
  f.context.resetSettingsPreview();
  assert.equal(f.element("settings-interface-mode").value, "desktop");
  await f.save();
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].agents.activeHarness, settings.DEFAULT_SETTINGS.agents.activeHarness);
  assert.equal(f.writes[0].appearance.theme, settings.DEFAULT_SETTINGS.appearance.theme);
  assert.deepEqual(f.modes, []);
});

test("a delayed device save cannot apply staged JSON after closing settings or changing account", async () => {
  for (const action of ["cancel", "account"]) {
    const f = fixture();
    f.stage({ interface_mode: "mobile", settings: { appearance: { theme: "dark" } } });
    f.element("settings-device-name").disabled = false;
    f.element("settings-device-name").value = "Renamed browser";
    let finish;
    f.context.api.renameDevice = () => new Promise(resolve => { finish = resolve; });
    const pending = f.save();
    assert.equal(typeof finish, "function");
    if (action === "cancel") f.context.cancelSettingsDialog();
    else {
      f.context.authenticationGeneration++;
      f.context.state.currentUser = { id: "actor-2", device_id: "device-2" };
    }
    finish({ name: "Renamed browser" });
    await pending;
    assert.deepEqual(f.writes, [], action);
    assert.deepEqual(f.modes, [], action);
    assert.equal(f.context.currentDeviceName, "This browser", action);
  }
});

test("an in-flight Save applies one preference snapshot, not a later unsubmitted JSON interface mode", async () => {
  const f = fixture();
  f.stage({ interface_mode: "mobile", settings: { appearance: { theme: "dark" } } });
  f.element("settings-device-name").disabled = false;
  f.element("settings-device-name").value = "Renamed browser";
  let finish;
  f.context.api.renameDevice = () => new Promise(resolve => { finish = resolve; });
  const pending = f.save();
  assert.equal(typeof finish, "function");
  f.stage({ interface_mode: "desktop", settings: { appearance: { theme: "light" } } });
  finish({ name: "Renamed browser" });
  await pending;
  assert.equal(f.writes[0].appearance.theme, "dark");
  assert.deepEqual(f.modes, ["mobile"]);
});
