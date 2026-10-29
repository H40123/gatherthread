import { PreferencesConfigurationSchema, PREFERENCES_SCHEMA_URL, readConfigurationJson } from "@gatherthread/protocol";
import { normalizeSettings } from "./settings.js?v=20261030-config-1";

export function exportPreferences(settings, interfaceMode = "auto") {
  const normalized = normalizeSettings(settings);
  const { projectProfiles: _bindings, ...agents } = normalized.agents;
  const { version: _version, ...portable } = normalized;
  return PreferencesConfigurationSchema.parse({ $schema: PREFERENCES_SCHEMA_URL, version: 1,
    kind: "gatherthread.preferences", interface_mode: interfaceMode, settings: { ...portable, agents } });
}

export function importPreferences(text, current) {
  const configuration = PreferencesConfigurationSchema.parse(readConfigurationJson(text));
  const next = normalizeSettings(current);
  for (const [section, values] of Object.entries(configuration.settings)) {
    next[section] = { ...next[section], ...values };
  }
  // Validate the merged selection as well as the partial document. Imports must
  // never silently pick another harness because the current one was disabled.
  exportPreferences(next, configuration.interface_mode ?? "auto");
  if (!next.agents.enabledHarnesses.includes(next.agents.activeHarness)) {
    throw new Error("Active harness must be enabled.");
  }
  return { settings: normalizeSettings(next), interfaceMode: configuration.interface_mode };
}

export function configurationError(error) {
  if (error?.issues) return error.issues.slice(0, 4).map(issue => `${issue.path.join(".") || "$"}: ${issue.message}`).join("\n");
  return error?.message ?? "Invalid JSON configuration.";
}

/** A bounded editor that stages preferences in the existing settings form. */
export function mountPreferencesConfiguration({ document: doc, button, getSettings, getInterfaceMode, onStage, t = x => x }) {
  const dialog = doc.createElement("dialog");
  dialog.className = "configuration-dialog";
  dialog.id = "preferences-json-dialog";
  dialog.setAttribute("aria-labelledby", "preferences-json-title");
  const title = doc.createElement("h2"); title.id = "preferences-json-title";
  const help = doc.createElement("p");
  const input = doc.createElement("textarea"); input.id = "preferences-json-input"; input.spellcheck = false;
  input.maxLength = 128 * 1024; input.setAttribute("aria-labelledby", title.id);
  const status = doc.createElement("p"); status.className = "form-error"; status.setAttribute("role", "status");
  const file = doc.createElement("input"); file.type = "file"; file.accept = ".json,application/json"; file.hidden = true;
  const actions = doc.createElement("div"); actions.className = "configuration-actions";
  const makeButton = (label, action, primary = false) => {
    const node = doc.createElement("button"); node.type = "button";
    node.className = `button ${primary ? "button-primary" : "button-secondary"}`;
    node.dataset.label = label; node.addEventListener("click", action); actions.append(node); return node;
  };
  let generation = 0, importRevision = 0;
  input.addEventListener("input", () => { importRevision++; });
  makeButton("Import JSON", () => file.click());
  makeButton("Download JSON", () => {
    try {
      const parsed = importPreferences(input.value, getSettings());
      const json = JSON.stringify(exportPreferences(parsed.settings, parsed.interfaceMode ?? getInterfaceMode()), null, 2);
      const url = URL.createObjectURL(new Blob([`${json}\n`], { type: "application/json" }));
      const link = doc.createElement("a"); link.href = url; link.download = "gatherthread.preferences.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) { status.textContent = configurationError(error); }
  });
  const docs = makeButton("Configuration guide", () => doc.defaultView.open("https://github.com/TH060419/gatherthread/blob/main/docs/CONFIGURATION.md", "_blank", "noopener,noreferrer"));
  docs.classList.add("button-quiet");
  makeButton("Cancel", () => dialog.close());
  makeButton("Use in settings", () => {
    try { onStage(importPreferences(input.value, getSettings())); dialog.close(); }
    catch (error) { status.textContent = configurationError(error); }
  }, true);
  file.addEventListener("change", async () => {
    const selected = file.files?.[0]; file.value = "";
    const captured = generation, revision = ++importRevision, original = input.value;
    const current = () => dialog.open && captured === generation && revision === importRevision && input.value === original;
    if (!selected || !dialog.open) return;
    if (selected.size > 128 * 1024) { status.textContent = t("Configuration must be at most 128 KiB."); return; }
    try {
      const text = await selected.text();
      if (!current()) return;
      importPreferences(text, getSettings()); input.value = text; status.textContent = "";
    } catch (error) { if (current()) status.textContent = configurationError(error); }
  });
  dialog.addEventListener("close", () => { generation++; button.focus(); });
  button.addEventListener("click", () => {
    generation++; title.textContent = t("JSON configuration");
    help.textContent = t("Edit browser preferences here or import a JSON file. Review them in Settings, then Save. Agent Teams have their own JSON editor.");
    for (const node of actions.querySelectorAll("button")) node.textContent = t(node.dataset.label);
    input.value = JSON.stringify(exportPreferences(getSettings(), getInterfaceMode()), null, 2);
    status.textContent = ""; dialog.showModal(); input.focus();
  });
  dialog.append(title, help, input, status, file, actions); doc.body.append(dialog);
  return { close: () => { generation++; if (dialog.open) dialog.close(); } };
}
