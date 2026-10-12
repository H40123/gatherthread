import type { TranscriptEvent } from "./types.js";

const REDACTED = "[REDACTED]";

const DEFAULT_SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:ENCRYPTED |RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|github_pat|glpat|sk|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:gt[abid]|acp(?:i|d)?)_[A-Za-z0-9_-]{20,}\b/g,
  /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret|token)\s*[=:]\s*)[^\s,;]+/gi,
  /\b([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|AUTH_TOKEN_PEPPER)\s*[=:]\s*)[^\s,;]+/g,
];

const SENSITIVE_KEY_NAMES = new Set([
  "apikey",
  "accesstoken",
  "authtoken",
  "authorization",
  "cookie",
  "setcookie",
  "bearer",
  "clientsecret",
  "password",
  "passwd",
  "privatekey",
  "refreshtoken",
  "secret",
  "token",
  "thinking",
  "rawthinking",
  "systemprompt",
  "developerprompt",
  "localsessionid",
]);

export interface RedactionOptions {
  extraPatterns?: readonly RegExp[];
  replacement?: string;
}

export function redactText(value: string, options: RedactionOptions = {}): string {
  const replacement = options.replacement ?? REDACTED;
  return [...DEFAULT_SECRET_PATTERNS, ...(options.extraPatterns ?? [])].reduce(
    (redacted, pattern) => redacted.replace(cloneGlobal(pattern), (match, prefix) =>
      typeof prefix === "string" && prefix.length < match.length
        ? `${prefix}${replacement}`
        : replacement,
    ),
    redactSensitiveFields(value, replacement),
  );
}

/** Use the same policy for structured objects and their textual representations,
 * including interrupted JSON. Walk quoted/composite values instead of stopping
 * at an internal comma, which could expose the rest of a private value. */
function redactSensitiveFields(text: string, replacement: string): string {
  const fields = /("(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|\b[A-Za-z_][A-Za-z0-9_.-]*)(\s*[:=]\s*)/gu;
  const parts: string[] = [];
  let retainedFrom = 0;
  let match: RegExpExecArray | null;
  while ((match = fields.exec(text)) !== null) {
    const encodedKey = match[1]!;
    let key = encodedKey;
    if (encodedKey.startsWith('"')) {
      try { key = JSON.parse(encodedKey) as string; } catch { continue; }
    } else if (encodedKey.startsWith("'")) key = encodedKey.slice(1, -1);
    if (!isSensitiveKey(key)) continue;
    const start = fields.lastIndex;
    const end = sensitiveValueEnd(text, start, encodedKey[0] !== '"' && encodedKey[0] !== "'"
      && /^(?:authorization|cookie|set-cookie)$/iu.test(key));
    const quote = text[start];
    const masked = quote === "'" ? `'${replacement.replace(/\\/gu, "\\\\").replace(/'/gu, "\\'")}'`
      : quote === '"' || encodedKey.startsWith('"') ? JSON.stringify(replacement) : replacement;
    parts.push(text.slice(retainedFrom, start), masked);
    retainedFrom = end;
    fields.lastIndex = end;
  }
  return parts.length === 0 ? text : parts.join("") + text.slice(retainedFrom);
}

function sensitiveValueEnd(text: string, start: number, header: boolean): number {
  if (header) { const end = text.indexOf("\n", start); return end < 0 ? text.length : end; }
  const first = text[start];
  if (first === '"' || first === "'") {
    for (let index = start + 1; index < text.length; index++) {
      if (text[index] === "\\") index++;
      else if (text[index] === first) return index + 1;
    }
    return text.length;
  }
  if (first === "{" || first === "[") {
    const closing = [first === "{" ? "}" : "]"];
    let quote: string | undefined;
    for (let index = start + 1; index < text.length; index++) {
      const character = text[index];
      if (quote !== undefined) {
        if (character === "\\") index++;
        else if (character === quote) quote = undefined;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === "{" || character === "[") closing.push(character === "{" ? "}" : "]");
      else if (character === "}" || character === "]") {
        if (character !== closing.pop()) return text.length;
        if (closing.length === 0) return index + 1;
      }
    }
    return text.length;
  }
  let index = start;
  while (index < text.length && !/[\s,;}\]]/u.test(text[index]!)) index++;
  return index;
}

export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options));
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key)
        ? options.replacement ?? REDACTED
        : redactValue(item, options),
    ]),
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return SENSITIVE_KEY_NAMES.has(normalized)
    || normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password")
    || normalized.endsWith("passwd")
    || normalized.endsWith("apikey")
    || normalized.endsWith("privatekey")
    || normalized.endsWith("tokenpepper")
    || normalized.endsWith("systemprompt")
    || normalized.endsWith("developerprompt")
    || normalized.endsWith("rawthinking");
}

export function redactTranscriptEvent(
  event: TranscriptEvent,
  options: RedactionOptions = {},
): TranscriptEvent {
  return {
    ...event,
    ...(event.content === undefined ? {} : { content: redactText(event.content, options) }),
    ...(event.arguments === undefined ? {} : { arguments: redactValue(event.arguments, options) }),
    ...(event.result === undefined ? {} : { result: redactValue(event.result, options) }),
  };
}

function cloneGlobal(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
}
