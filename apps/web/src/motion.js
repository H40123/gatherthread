import { animate } from "animejs";
import { MOTION, motionIsReduced, createMessageArrivalTracker } from "./motion-policy.js";

// Presentation only. Never defer an action, change dialog lifetime, copy a form,
// or keep a hidden surface focusable while its animation finishes.
export function mountMotion({ document: doc, window: win, driver = animate }) {
  const root = doc.documentElement;
  const preference = win.matchMedia("(prefers-reduced-motion: reduce)");
  const running = new Map();
  const arrivals = createMessageArrivalTracker();
  const arrivingCards = new Map();
  let arrivalScope;
  let destroyed = false;
  const reduced = () => motionIsReduced(root.dataset.motion, preference.matches);
  const visible = node => Boolean(node?.isConnected && !node.closest("[hidden]")
    && (!node.closest("dialog") || node.closest("dialog").open) && node.getClientRects().length);
  function stop(node) {
    const animation = running.get(node);
    if (!animation) return;
    running.delete(node);
    animation.revert();
    delete node.dataset.motionActive;
  }
  function play(node, values, duration = MOTION.enter, delay = 0) {
    stop(node);
    if (destroyed || reduced() || !visible(node)) return;
    node.dataset.motionActive = "true";
    const animation = driver(node, { ...values, duration, delay, ease: MOTION.ease,
      onComplete: () => {
        if (running.get(node) !== animation) return;
        running.delete(node);
        // Remove only our styles; preserve the authored transforms/opacity.
        animation.revert();
        delete node.dataset.motionActive;
      },
    });
    running.set(node, animation);
  }
  function enter(node, { direction = "up", distance = MOTION.distance, duration = MOTION.content, delay = 0 } = {}) {
    stop(node);
    const opacity = Number(win.getComputedStyle(node).opacity) || 1;
    const movement = direction === "forward" ? { translateX: [distance, 0] }
      : direction === "back" ? { translateX: [-distance, 0] }
      : { translateY: [distance, 0] };
    play(node, { opacity: [0, opacity], ...movement }, duration, delay);
  }

  // Existing modules use native hidden/open state. Observe only surface changes,
  // never streamed text or editor mutations. Dedupe a batch before measuring.
  const surfaces = [
    ".auth-entry-panel", ".auth-entry-chooser", ".settings-section", ".mobile-settings-home",
    ".mobile-panel-page", ".agent-management-view", ".github-step", ".code-view",
    ".fw-files-pane", ".fw-members-pane", ".fw-file-pane",
    ".fw-new-tab-view", "#registration-code-step", "#password-reset-code-step",
    "#workspace", "#auth-view", "#invitation-link-view", ".composer-quote",
    ".attention-notice", ".history-summary-selection-bar",
    ".auth-form-heading", ".auth-identity", ".history-summary-toolbar", ".mention-picker",
    ".agent-profile-fields", ".settings-agent-fields", ".cloud-code-consent", ".personal-api-editor",
    "#agent-management-overview", "#agent-management-connections", "#session-view", "#empty-state",
    "#code-confirmation", "#code-github-panel", "#code-gt-cloud-panel", "#code-enabled-content",
    "#code-device-view", "#code-branches-view", "#code-review-preview", "#github-code-form",
    "#github-code-device", "#github-local-home", "#github-cloud-home", "#github-cloud-detail",
    "#cloud-github-controls", "#code-storage-manage", "#code-storage-confirmation",
  ].join(",");
  const nativeDialogs = Boolean(win.CSS?.supports?.("transition-behavior", "allow-discrete"));
  const observer = new win.MutationObserver(records => {
    const reveals = new Set();
    for (const record of records) {
      const node = record.target;
      if (record.type === "attributes") {
        if (record.attributeName === "hidden" && record.oldValue !== null && !node.hidden
          && (node.matches(surfaces) || (!nativeDialogs && node.matches(".session-toolbar-panel")))) reveals.add(node);
        if (record.attributeName === "open" && node.tagName === "DIALOG") {
          if (node.open && record.oldValue === null && !nativeDialogs) reveals.add(node);
          if (!node.open) stop(node);
        }
        if (node.hidden) stop(node);
      } else {
        for (const added of record.addedNodes) {
          if (added.nodeType !== 1) continue;
          // File previews load asynchronously, but their editor's later updates
          // must not replay an entrance or interrupt text selection.
          if (added.matches(".fw-content, .fw-tab-menu, .onboarding-popover")) reveals.add(added);
        }
      }
    }
    for (const node of reveals) {
      if ([...reveals].some(parent => parent !== node && parent.contains(node))) continue;
      if (visible(node)) enter(node);
    }
    for (const node of running.keys()) if (!node.isConnected) stop(node);
  });
  observer.observe(doc.body, { subtree: true, attributes: true, attributeOldValue: true,
    attributeFilter: ["hidden", "open"], childList: true });

  // A keyboard press has the same quiet tactile feedback as a pointer press.
  // CSS owns pointer feedback so a release still responds during JS/network work.
  let keyboardButton = null;
  const keydown = event => {
    if (![" ", "Enter"].includes(event.key) || event.repeat) return;
    const button = event.target.closest?.("button, summary, [role='button']");
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return;
    keyboardButton = button; button.dataset.keyPressed = "true";
  };
  const keyup = () => { if (keyboardButton) delete keyboardButton.dataset.keyPressed; keyboardButton = null; };
  const refreshPreference = () => {
    root.dataset.motionResolved = reduced() ? "reduce" : "full";
    if (reduced()) {
      for (const node of [...running.keys()]) stop(node);
      arrivingCards.clear();
    }
  };
  const settingsObserver = new win.MutationObserver(refreshPreference);
  settingsObserver.observe(root, { attributes: true, attributeFilter: ["data-motion"] });
  preference.addEventListener("change", refreshPreference);
  doc.addEventListener("keydown", keydown);
  doc.addEventListener("keyup", keyup);
  win.addEventListener("blur", keyup);
  refreshPreference();
  return {
    enter,
    timeline({ container, scope, events, follow }) {
      const ids = arrivals.update(scope, events, follow);
      if (scope !== arrivalScope) { arrivingCards.clear(); arrivalScope = scope; }
      if (reduced()) return;
      const now = win.performance.now();
      ids.forEach((id, index) => arrivingCards.set(id, { start: now + index * MOTION.stagger, node: null }));
      for (const [id, arrival] of arrivingCards) {
        const card = doc.getElementById(`message-${id}`);
        const elapsed = Math.max(0, now - arrival.start);
        if (!card || elapsed >= MOTION.message || !visible(card) || !container.contains(card)) {
          arrivingCards.delete(id); continue;
        }
        if (card === arrival.node) continue;
        // The timeline reconciler may replace all nodes again in the same frame
        // (receipt/stream/status). Continue the original entrance at its elapsed
        // position instead of dropping it or flashing back to opacity zero.
        if (arrival.node) stop(arrival.node);
        const remaining = (1 - elapsed / MOTION.message) ** 4; // out(4)
        play(card, { opacity: [1 - remaining, 1], translateY: [18 * remaining, 0] },
          MOTION.message - elapsed, Math.max(0, arrival.start - now));
        arrival.node = card;
      }
    },
    destroy() {
      destroyed = true; arrivingCards.clear(); observer.disconnect(); settingsObserver.disconnect(); keyup();
      for (const node of [...running.keys()]) stop(node);
      preference.removeEventListener("change", refreshPreference);
      doc.removeEventListener("keydown", keydown); doc.removeEventListener("keyup", keyup);
      win.removeEventListener("blur", keyup);
    },
  };
}
