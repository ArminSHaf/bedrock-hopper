/**
 * Wizard adapter — drive Claude's /setup-bedrock through a pseudoterminal.
 *
 * Spawns a helper Claude process in an isolated CLAUDE_CONFIG_DIR so that
 * a failed attempt cannot overwrite the real settings.  Prompt recognition
 * uses a state machine over NEW terminal content (not historical buffer).
 * Unexpected prompts stop the attempt with a redacted diagnostic.
 *
 * ASSUMPTION (UNTESTED): The wizard prompt patterns below are based on
 * Claude Code documentation.  They require calibration against the actual
 * /setup-bedrock output from Claude Code 2.1.286.
 */

import { chmod, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./logger.js";
import { isWindows, isMacOS, makeTempDir, redactKey, resolveClaude } from "./platform.js";
import type { RegionEntry, WizardResult } from "./types.js";

const ALLOWED_ENV_FIELDS = new Set([
  "CLAUDE_CODE_USE_BEDROCK",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
]);

// Wizard state machine phases (strict ordering)
type WizardPhase =
  | "startup"
  | "await-prompt"
  | "auth-method"
  | "enter-key"
  | "enter-region"
  | "model-pin"
  | "validating"
  | "result"
  | "done";

const WIZARD_TIMEOUT_MS = 120_000;
const PROMPT_WAIT_MS = 30_000;
const POST_INPUT_DELAY_MS = 2_000;

export async function runWizard(
  key: string,
  candidate: RegionEntry,
): Promise<WizardResult> {
  const claudePath = await resolveClaude();
  if (!claudePath) {
    return failResult("Claude executable not found on PATH", []);
  }

  const tempDir = makeTempDir("claude-recovery-helper");
  // Create helper directory with private permissions
  await mkdir(tempDir, { recursive: true });
  if (!isWindows()) {
    await chmod(tempDir, 0o700);
  }

  const redactedTranscript: string[] = [];

  try {
    const result = await driveWizard(
      claudePath,
      tempDir,
      key,
      candidate,
      redactedTranscript,
    );

    if (result.success && result.env) {
      await log({
        event: "wizard-success",
        region: candidate.region,
        model: candidate.models.primary,
      });
    } else {
      await log({
        event: "wizard-failed",
        region: candidate.region,
        reason: result.reason,
      });
    }

    return result;
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

async function driveWizard(
  claudePath: string,
  tempDir: string,
  key: string,
  candidate: RegionEntry,
  redactedTranscript: string[],
): Promise<WizardResult> {
  const nodePty = await import("node-pty");

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    CLAUDE_CONFIG_DIR: tempDir,
    CLAUDE_BEDROCK_RECOVERY_HELPER: "1",
  };

  const shell = isWindows() ? "cmd.exe" : claudePath;
  const args = isWindows()
    ? ["/c", claudePath]
    : [];

  const pty = nodePty.spawn(shell, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 40,
    cwd: tempDir,
    env,
  });

  // Track new content only — the state machine processes fresh chunks,
  // not the entire historical buffer.
  let newContent = "";
  let helperExited = false;
  let exitCode: number | undefined;
  const redactor = createChunkRedactor(key);

  const exitPromise = new Promise<void>((resolve) => {
    pty.onData((data: string) => {
      newContent += data;
      redactedTranscript.push(redactor(data));
    });
    pty.onExit((e) => {
      helperExited = true;
      exitCode = e.exitCode;
      resolve();
    });
  });

  let phase: WizardPhase = "startup";

  try {
    // Wait for Claude to start — check for immediate startup failure
    const startupContent = await waitForNewContent(
      () => newContent,
      () => helperExited,
      /[>$%#]|error:|usage:/i,
      PROMPT_WAIT_MS,
    );

    if (helperExited) {
      return failResult(
        `Helper exited immediately (code ${exitCode}). ` +
          "Check that the installed Claude version supports the startup command.",
        redactedTranscript,
      );
    }

    if (/error:|usage:|unknown option/i.test(startupContent)) {
      killHelper(pty);
      return failResult(
        "Helper failed at startup: " + startupContent.slice(0, 300),
        redactedTranscript,
      );
    }

    // Send /setup-bedrock
    phase = "await-prompt";
    newContent = "";
    pty.write("/setup-bedrock\r");
    await delay(POST_INPUT_DELAY_MS);

    // PHASE: auth-method — wait for authentication method prompt
    phase = "auth-method";
    const authContent = await waitForNewContent(
      () => newContent,
      () => helperExited,
      /(?:authenticate|credentials|method|sign in|how.*(?:connect|set up))/i,
      PROMPT_WAIT_MS,
    );
    newContent = "";

    if (helperExited) {
      return failResult("Helper exited before showing auth method prompt", redactedTranscript);
    }

    // Select API key authentication
    const apiKeyOption = findOptionNumber(authContent, /(?:api.?key|bearer|bedrock.*key)/i);
    if (apiKeyOption) {
      pty.write(`${apiKeyOption}\r`);
    } else {
      pty.write("Amazon Bedrock API key\r");
    }
    await delay(POST_INPUT_DELAY_MS);

    // PHASE: enter-key — wait for key entry prompt
    phase = "enter-key";
    const keyContent = await waitForNewContent(
      () => newContent,
      () => helperExited,
      /(?:enter|paste|provide|type).*(?:key|token|bearer)/i,
      PROMPT_WAIT_MS,
    );
    newContent = "";

    if (!keyContent) {
      killHelper(pty);
      return failResult("Did not receive API key entry prompt", redactedTranscript);
    }

    // Check for unexpected trust/permission prompts — never auto-accept
    if (/(?:trust|workspace|permission|allow).*\?/i.test(keyContent)) {
      killHelper(pty);
      return failResult(
        "Unexpected trust or permission prompt. Run setup manually first.",
        redactedTranscript,
      );
    }

    pty.write(`${key}\r`);
    await delay(POST_INPUT_DELAY_MS);

    // PHASE: enter-region — wait for region prompt
    phase = "enter-region";
    const regionContent = await waitForNewContent(
      () => newContent,
      () => helperExited,
      /(?:region|model|verif|valid|success|fail|error)/i,
      PROMPT_WAIT_MS,
    );
    newContent = "";

    if (/(?:enter|select|choose).*region/i.test(regionContent)) {
      pty.write(`${candidate.region}\r`);
      await delay(POST_INPUT_DELAY_MS);
    }

    // PHASE: model-pin — handle model pin prompts if present
    phase = "model-pin";
    const modelContent = await waitForNewContent(
      () => newContent,
      () => helperExited,
      /(?:pin|select|choose|configure).*model|verif|valid|success|fail|saved/i,
      PROMPT_WAIT_MS,
    );
    newContent = "";

    if (/(?:pin|select|choose|configure).*model/i.test(modelContent)) {
      if (candidate.models.primary) {
        pty.write(`${candidate.models.primary}\r`);
        await delay(POST_INPUT_DELAY_MS);
      }
      if (candidate.models.haiku) {
        const haikuContent = await waitForNewContent(
          () => newContent,
          () => helperExited,
          /haiku|small|background|saved|success|fail/i,
          PROMPT_WAIT_MS,
        );
        newContent = "";
        if (/haiku|small|background/i.test(haikuContent)) {
          pty.write(`${candidate.models.haiku}\r`);
          await delay(POST_INPUT_DELAY_MS);
        }
      }
    }

    // PHASE: result — wait for explicit validation result
    phase = "validating";
    const finalContent = await waitForNewContent(
      () => newContent,
      () => helperExited,
      /(?:saved|success|configured|fail|error|invalid|denied|cannot|unable)/i,
      WIZARD_TIMEOUT_MS,
    );

    // Check failure FIRST — a later failure overrides earlier positive text
    phase = "result";
    if (/(?:fail|error|invalid|denied|cannot|unable)/i.test(finalContent)) {
      killHelper(pty);
      return failResult(
        "Wizard validation failed — candidate may be unusable",
        redactedTranscript,
      );
    }

    if (!/(?:saved|success|configured)/i.test(finalContent)) {
      killHelper(pty);
      return failResult(
        "Wizard did not reach a clear validation result",
        redactedTranscript,
      );
    }

    // Read and verify the helper's saved settings
    const helperEnv = await readHelperSettings(tempDir);
    if (!helperEnv) {
      killHelper(pty);
      return failResult(
        "Wizard reported success but did not save settings to the helper directory. " +
          "Cannot publish an unvalidated configuration.",
        redactedTranscript,
      );
    }

    // Verify the saved settings match our intended key, region, and model
    const mismatch = verifyHelperSettings(helperEnv, key, candidate);
    if (mismatch) {
      killHelper(pty);
      return failResult(
        `Wizard saved settings do not match the intended configuration: ${mismatch}`,
        redactedTranscript,
      );
    }

    killHelper(pty);
    phase = "done";

    // Return only allowed fields from the helper's env
    const filteredEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(helperEnv)) {
      if (ALLOWED_ENV_FIELDS.has(k)) {
        filteredEnv[k] = v;
      }
    }

    return {
      success: true,
      env: filteredEnv,
      reason: "Wizard completed successfully",
      redactedTranscript,
    };
  } catch (err: unknown) {
    killHelper(pty);
    return failResult(
      `Wizard error: ${err instanceof Error ? err.message : String(err)}`,
      redactedTranscript,
    );
  } finally {
    killHelper(pty);
    await Promise.race([exitPromise, delay(5000)]);
  }
}

async function readHelperSettings(
  tempDir: string,
): Promise<Record<string, string> | null> {
  try {
    const settingsPath = join(tempDir, "settings.json");
    const raw = await readFile(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.env === "object" && parsed.env !== null) {
      const env = parsed.env as Record<string, unknown>;
      const result: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) {
        if (typeof v === "string") {
          result[k] = v;
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    }
    return null;
  } catch {
    return null;
  }
}

function verifyHelperSettings(
  helperEnv: Record<string, string>,
  expectedKey: string,
  candidate: RegionEntry,
): string | null {
  if (!helperEnv.AWS_BEARER_TOKEN_BEDROCK) {
    return "Saved settings are missing the API key (AWS_BEARER_TOKEN_BEDROCK)";
  }
  if (helperEnv.AWS_BEARER_TOKEN_BEDROCK !== expectedKey) {
    return "Saved key does not match the generated key";
  }
  if (!helperEnv.AWS_REGION) {
    return "Saved settings are missing the region (AWS_REGION)";
  }
  if (helperEnv.AWS_REGION !== candidate.region) {
    return `Saved region "${helperEnv.AWS_REGION}" does not match intended "${candidate.region}"`;
  }
  if (!helperEnv.ANTHROPIC_MODEL) {
    return "Saved settings are missing the model (ANTHROPIC_MODEL)";
  }
  if (helperEnv.ANTHROPIC_MODEL !== candidate.models.primary) {
    return `Saved model "${helperEnv.ANTHROPIC_MODEL}" does not match intended "${candidate.models.primary}"`;
  }
  return null;
}

function failResult(reason: string, redactedTranscript: string[]): WizardResult {
  return {
    success: false,
    env: null,
    reason,
    redactedTranscript,
  };
}

/**
 * Wait for new terminal content matching a pattern.  Only examines
 * content produced AFTER the call, avoiding false matches on
 * historical output.
 */
async function waitForNewContent(
  getContent: () => string,
  hasExited: () => boolean,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = getContent();
    if (pattern.test(content)) {
      return content;
    }
    if (hasExited()) {
      return content;
    }
    await delay(300);
  }
  return getContent();
}

function findOptionNumber(content: string, pattern: RegExp): string | null {
  const lines = content.split("\n");
  for (const line of lines) {
    if (pattern.test(line)) {
      const numMatch = line.match(/^\s*(\d+)[.):\s]/);
      if (numMatch) {
        return numMatch[1];
      }
    }
  }
  return null;
}

/**
 * Create a stateful redactor that handles keys split across chunks.
 * Buffers up to key.length-1 bytes at the end of each chunk so a
 * split key is always caught on the next call.
 */
function createChunkRedactor(key: string): (data: string) => string {
  let pending = "";
  return (data: string): string => {
    if (!key || key.length === 0) return data;
    const combined = pending + data;
    const redacted = combined.replaceAll(key, redactKey(key));
    const safeLen = Math.max(0, redacted.length - (key.length - 1));
    pending = redacted.slice(safeLen);
    return redacted.slice(0, safeLen);
  };
}

function redactTerminalData(data: string, key: string): string {
  if (!key || key.length === 0) return data;
  return data.replaceAll(key, redactKey(key));
}

function killHelper(pty: { write: (d: string) => void; kill: (s?: string) => void }): void {
  try {
    pty.write("exit\r");
  } catch { /* already gone */ }
  try {
    pty.kill();
  } catch { /* already gone */ }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
