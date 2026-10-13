const preferenceKey = context => `gt-cloud-code-v1:${encodeURIComponent(context.userId)}:${encodeURIComponent(context.projectId)}`;
const optionalStorage = () => { try { return globalThis.localStorage; } catch { return null; } };
const scopeHelp = "Uses this project's GT Cloud files and saves edits to your own branch. Local and GitHub files are not included.";

/** Non-secret account/project preference, separate from permission and storage
 * availability. Rendering, model changes and sending never change this choice. */
export function mountCloudCodeConsent({ checkbox, help, api, getContext, localizer, storage = optionalStorage() }) {
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
    checkbox.disabled = !context || context.scope !== scope || !context.writable || availability !== "enabled" || context.source === "github";
    const text = availability === "disabled" ? "Enable GT Cloud in Project files to let the Cloud Agent use this project's code."
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
    const run = ++generation; availability = "loading"; render();
    const current = () => run === generation && contextNow()?.scope === context.scope && key === preferenceKey(context);
    try {
      // Metadata only; this never enables storage, uploads or retrieves files.
      const result = await api.getProjectCode(context.projectId);
      if (current()) availability = result?.repository?.enabled === true ? "enabled" : "disabled";
    } catch { if (current()) availability = "unavailable"; }
    finally { if (current()) render(); }
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
    render();
  });
  return { updateContext, refresh, refreshLanguage: render,
    suspend() { suspended = true; generation++; scope = null; key = null; availability = "loading"; render(); },
    resume() { suspended = false; },
    includeCode() {
    const context = contextNow();
    return Boolean(desired && availability === "enabled" && context?.writable && context.scope === scope
      && key === preferenceKey(context) && context.source !== "github");
  } };
}
