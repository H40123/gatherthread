import assert from "node:assert/strict";
import test from "node:test";
import { redactText, redactValue } from "../src/redaction.js";

const privateValue = ["SYNTHETIC", "PRIVATE", "VALUE"].join("_");

test("structured cookies and textual sensitive keys share the recursive policy", () => {
  const structured = { headers: { Cookie: privateValue, "Set-Cookie": privateValue }, public: "kept" };
  assert.deepEqual(redactValue(structured), { headers: { Cookie: "[REDACTED]", "Set-Cookie": "[REDACTED]" }, public: "kept" });
  for (const key of ["refresh_token", "provider_api_key", "private_key", "developer_prompt", "system_prompt", "Cookie", "Set-Cookie"]) {
    const text = JSON.stringify({ [key]: { inner: [privateValue, { second: privateValue }] }, public: "kept" });
    const output = redactText(text);
    assert.doesNotMatch(output, /SYNTHETIC_PRIVATE_VALUE/, key);
    assert.deepEqual(JSON.parse(output), { [key]: "[REDACTED]", public: "kept" });
    assert.doesNotMatch(redactText(text.slice(0, text.indexOf("VALUE") + 2)), /SYNTHETIC_PRIVATE/, key);
  }
});

test("headers, escaped keys, interrupted strings and private PEM blocks are masked", () => {
  for (const header of ["Authorization", "Cookie", "Set-Cookie"]) {
    const output = redactText(`${header}: opaque ${privateValue}; second=${privateValue}\npublic: kept`);
    assert.doesNotMatch(output, /SYNTHETIC_PRIVATE_VALUE/, header);
    assert.match(output, /public: kept/, header);
  }
  const escaped = `{"refresh\\u005ftoken":"${privateValue}","public":"kept"}`;
  assert.deepEqual(JSON.parse(redactText(escaped)), { refresh_token: "[REDACTED]", public: "kept" });
  assert.doesNotMatch(redactText(`{"private_key":"${privateValue}`), /SYNTHETIC_PRIVATE_VALUE/);
  const pem = ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + `\n${privateValue}`;
  assert.equal(redactText(pem), "[REDACTED]");
});

test("ordinary text, public serialized fields and custom replacements remain usable", () => {
  const text = 'English and 中文。\n{"public":"text: still visible","count":3}';
  assert.equal(redactText(text), text);
  const textWithPrivate = JSON.stringify({ refresh_token: privateValue, public: "kept" });
  assert.deepEqual(JSON.parse(redactText(textWithPrivate, { replacement: 'masked "value"' })),
    { refresh_token: 'masked "value"', public: "kept" });
  assert.equal(redactText(`password=${privateValue} visible failure`), "password=[REDACTED] visible failure");
  assert.equal(redactText(`password=${privateValue} refresh_token=${privateValue} public=kept`),
    "password=[REDACTED] refresh_token=[REDACTED] public=kept");
});
