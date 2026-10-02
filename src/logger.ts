import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir, getLogDir, redactKey } from "./platform.js";

let verbose = false;
let logDir: string | null = null;

/**
 * Registered secrets that must be redacted from every log entry and
 * console output.  Secrets are added when keys are generated and
 * removed when temporary state is cleaned up.
 */
const registeredSecrets: Set<string> = new Set();

export function configureLogger(opts: { verbose: boolean }): void {
  verbose = opts.verbose;
}

export function registerSecret(secret: string): void {
  if (secret && secret.length > 0) {
    registeredSecrets.add(secret);
  }
}

export function clearSecrets(): void {
  registeredSecrets.clear();
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function getLogFile(): Promise<string> {
  if (!logDir) {
    logDir = getLogDir();
    await ensureDir(logDir);
  }
  return join(logDir, `recovery-${today()}.jsonl`);
}

/**
 * Recursively redact secrets in any value — objects, arrays, and
 * string values.  Checks both field names (for known secret fields)
 * and string content (for registered secrets).
 */
function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactStringContent(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (typeof value === "object" && value !== null) {
    return redactRecord(value as Record<string, unknown>);
  }
  return value;
}

const SECRET_FIELD_PATTERNS = [
  /^AWS_BEARER_TOKEN/i,
  /^ANTHROPIC_API_KEY$/i,
  /^AWS_SECRET_ACCESS_KEY$/i,
  /^AWS_SESSION_TOKEN$/i,
  /secret/i,
  /password/i,
  /credential/i,
  /^key$/i,
  /^token$/i,
];

function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  const redacted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string" && SECRET_FIELD_PATTERNS.some((p) => p.test(key))) {
      redacted[key] = redactKey(value);
    } else {
      redacted[key] = redactValue(value);
    }
  }
  return redacted;
}

/**
 * Scan a string for any registered secret and replace occurrences.
 * This catches secrets embedded in error messages, reasons, or
 * any other string field regardless of the field name.
 */
function redactStringContent(text: string): string {
  let result = text;
  for (const secret of registeredSecrets) {
    if (result.includes(secret)) {
      result = result.replaceAll(secret, redactKey(secret));
    }
  }
  return result;
}

export interface LogEntry {
  event: string;
  incidentId?: string;
  sessionId?: string;
  region?: string;
  model?: string;
  errorCategory?: string;
  outcome?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export async function log(entry: LogEntry): Promise<void> {
  const stamped = { timestamp: new Date().toISOString(), ...entry };
  const safe = redactRecord(stamped);

  if (verbose) {
    const summary = [safe.event, safe.outcome, safe.region, safe.reason]
      .filter(Boolean)
      .join(" — ");
    process.stderr.write(`[recovery] ${redactStringContent(summary as string)}\n`);
  }

  try {
    const file = await getLogFile();
    await appendFile(file, JSON.stringify(safe) + "\n", "utf-8");
  } catch {
    // Logging failure must not break recovery.
  }
}

export function logSync(message: string): void {
  const safe = redactStringContent(message);
  if (verbose) {
    process.stderr.write(`[recovery] ${safe}\n`);
  }
}
