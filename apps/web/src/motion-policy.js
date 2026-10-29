// One vocabulary for the workspace. Values are milliseconds and CSS pixels.
export const MOTION = Object.freeze({
  press: 90, release: 220, enter: 280, exit: 180, content: 220,
  message: 340, stagger: 36, distance: 12,
  ease: "out(4)",
});

export function motionIsReduced(preference, systemReduced = false) {
  return preference === "reduce" || (preference !== "full" && systemReduced);
}

// Only animate genuinely appended conversation cards, never replay, pagination,
// a language change, a stream snapshot or a switch to another conversation.
export function createMessageArrivalTracker() {
  let scope;
  let highWater = null;
  return {
    update(nextScope, events, follow) {
      const maximum = events.reduce((value, event) => Math.max(value, Number(event.sequence) || 0), 0);
      const fresh = nextScope === scope && highWater !== null && follow
        ? events.filter(event => event.sequence > highWater && ["human_chat", "agent_request", "agent_response"].includes(event.type)).map(event => event.id)
        : [];
      highWater = nextScope === scope ? Math.max(highWater ?? 0, maximum) : maximum;
      scope = nextScope;
      return fresh.slice(-6);
    },
  };
}
