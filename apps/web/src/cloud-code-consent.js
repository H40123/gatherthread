const preferenceKey = context => `gt-cloud-code-v1:${encodeURIComponent(context.userId)}:${encodeURIComponent(context.projectId)}`;
const optionalStorage = () => { try { return globalThis.localStorage; } catch { return null; } };
const scopeHelp = "Uses this project's GT Cloud files and saves edits to your own branch. Local and GitHub files are not included.";
const emptyHelp = "Code is off. This task will not read or save GT Cloud files.";

/** Non-secret account/project preference, separate from permission and storage
 * availability. Rendering, model changes and sending never change this choice. */
export function mountCloudCodeConsent({ checkbox, help, api, getContext, localizer, storage = optionalStorage(), onChange = () => {} }) {
  const memory = new Map();
  let scope = null, key = null, generation = 0, desired = true, availability = "loading", suspended = false;
  const contextNow = () => {
    if (suspended) return null;
    const context = getContext();
    return context?.userId && context.projectId ? context : null;
  };
  function render() {
    const context = contextNow();
    checkbox.checked = desired;
    checkbox.disabled = !context || context.scope !== scope || !context.writable || availability === "disabled" || context.source === "github";
    const text = !desired ? emptyHelp : availability === "disabled" ? "Enable GT Cloud in Project files to let the Cloud Agent use this project's code."
      : availability === "unavailable" ? "Could not check GT Cloud files. Reopen Project files to try again."
      : availability === "loading" ? "Checking GT Cloud files…" : scopeHelp;
    if (help) { help.textContent = localizer.t(text); help.hidden = context?.source === "github"; }
  }
  function synchronize() {
    const context = contextNow();
    if (!context) {
      if (scope !== null) generation++;
      scope = null; key = null; availability = "loading"; desired = true;
      return null;
    }
    const nextKey = preferenceKey(context);
    if (context.scope !== scope || nextKey !== key) {
      generation++; scope = context.scope; key = nextKey; availability = "loading";
      let stored = memory.get(key);
      try { stored = storage?.getItem(key) ?? stored; } catch { /* A blocked store leaves the page-local preference usable. */ }
      desired = stored !== "false";
    }
    return context;
  }
  async function refresh() {
    const context = synchronize();
    if (!context) { render(); return; }
    const run = ++generation; availability = "loading"; render(); onChange();
    const current = () => run === generation && contextNow()?.scope === context.scope && key === preferenceKey(context);
    try {
      // Metadata only; this never enables storage, uploads or retrieves files.
      const result = await api.getProjectCode(context.projectId);
      if (current()) availability = result?.repository?.enabled === true ? "enabled" : "disabled";
    } catch { if (current()) availability = "unavailable"; }
    finally { if (current()) { render(); onChange(); } }
  }
  function updateContext() {
    const previousScope = scope, previousKey = key;
    const context = synchronize(); render();
    if (context && (scope !== previousScope || key !== previousKey)) void refresh();
  }
  checkbox.addEventListener("change", () => {
    const context = contextNow();
    if (checkbox.disabled || !context || context.scope !== scope || key !== preferenceKey(context)) { render(); return; }
    desired = checkbox.checked === true;
    const value = String(desired); memory.set(key, value);
    try { storage?.setItem(key, value); } catch { /* No credential or content is stored. */ }
    render(); onChange();
  });
  function submission() {
    const context = contextNow();
    if (!context || !context.writable) return { allowed: false, includeCode: false, reason: "" };
    if (context.source === "github") return { allowed: true, includeCode: false, reason: "" };
    const current = context.scope === scope && key === preferenceKey(context);
    if (!current || desired && availability === "loading") {
      return { allowed: false, includeCode: false, reason: "Checking GT Cloud files…" };
    }
    if (desired && availability === "unavailable") {
      return { allowed: false, includeCode: false, reason: "Could not check GT Cloud files. Reopen Project files to try again." };
    }
    return { allowed: true, includeCode: desired && availability === "enabled", reason: "" };
  }
  return { updateContext, refresh, refreshLanguage: render, submission,
    suspend() { suspended = true; generation++; scope = null; key = null; availability = "loading"; render(); },
    resume() { suspended = false; },
    includeCode() {
      return submission().includeCode;
  } };
}
