import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createMessageArrivalTracker, motionIsReduced } from "../src/motion-policy.js";

const event = (sequence, type = "human_chat") => ({ id: `event-${sequence}`, sequence, type });

test("message arrivals do not replay initial history, pagination or session switches", () => {
  const tracker = createMessageArrivalTracker();
  assert.deepEqual(tracker.update("a", [event(10)], true), []);
  assert.deepEqual(tracker.update("a", [event(1), event(10)], true), []);
  assert.deepEqual(tracker.update("a", [event(10), event(11)], true), ["event-11"]);
  assert.deepEqual(tracker.update("a", [event(11)], true), []);
  assert.deepEqual(tracker.update("b", [event(12)], true), []);
  assert.deepEqual(tracker.update("a", [event(11)], true), []);
});

test("background arrivals and streamed work never restart message entrances", () => {
  const tracker = createMessageArrivalTracker();
  tracker.update("a", [], false);
  assert.deepEqual(tracker.update("a", [event(1)], true), ["event-1"]);
  assert.deepEqual(tracker.update("a", [event(1), event(2, "agent_progress")], true), []);
  assert.deepEqual(tracker.update("a", [event(3, "agent_response")], false), []);
  assert.deepEqual(tracker.update("a", [event(3, "agent_response")], true), []);
  assert.deepEqual(tracker.update("a", [event(3), event(4, "agent_request")], true), ["event-4"]);
});

test("a reconnect batch caps entrances and never lowers the sequence watermark", () => {
  const tracker = createMessageArrivalTracker();
  tracker.update("a", [event(1)], false);
  const batch = Array.from({ length: 20 }, (_, i) => event(i + 1));
  assert.deepEqual(tracker.update("a", batch, true), batch.slice(-6).map(e => e.id));
  tracker.update("a", [event(2)], false);
  assert.deepEqual(tracker.update("a", batch, true), []);
});

test("explicit motion settings override the OS while system follows it", () => {
  assert.equal(motionIsReduced("reduce", false), true);
  assert.equal(motionIsReduced("full", true), false);
  assert.equal(motionIsReduced("system", true), true);
  assert.equal(motionIsReduced("system", false), false);
  assert.equal(motionIsReduced(undefined, true), true);
});

test("bubble body, secondary text and action labels retain AA contrast in both themes", async () => {
  const css = await readFile(new URL("../src/interaction-design.css", import.meta.url), "utf8");
  const blocks = css.split("}").filter(block => block.includes("--bubble-self-bg:"));
  function luminance(hex) {
    const full = hex.length === 3 ? [...hex].map(x => x + x).join("") : hex;
    const rgb = full.match(/../g).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
    return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  }
  function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
  assert.equal(blocks.length, 3);
  for (const block of blocks) {
    const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*#([\da-f]+)/gi)].map(m => [m[1], m[2]]));
    for (const background of ["bubble-self-bg", "bubble-agent-bg"]) for (const foreground of ["bubble-ink", "bubble-soft"]) {
      assert.ok(contrast(tokens[background], tokens[foreground]) >= 4.5, `${background}/${foreground} contrast`);
    }
    for (const background of ["action-fill", "action-fill-deep"]) assert.ok(contrast(tokens[background], tokens["action-ink"]) >= 4.5, `${background} contrast`);
  }
});
