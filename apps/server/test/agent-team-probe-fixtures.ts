import assert from "node:assert/strict";

/** Echo the supplied reply verbatim; decoding JSON here would hide prompt/validator mismatches. */
export function probeReplyFromPrompt(prompt: string): string {
  const reply = /Respond exactly with these lines:\n([\s\S]+?)\nRoute lines carry/u.exec(prompt)?.[1];
  assert.ok(reply, "The executor must receive an explicit, bounded probe reply");
  return reply;
}
