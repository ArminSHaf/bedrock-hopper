/**
 * Integrated 429 recovery test.
 *
 * Simulates a Claude session hitting a sustained 429 on us-east-1.
 * Runs the REAL CLI hook process with simulated browser and wizard
 * via --import preload + ESM loader hooks (node:module register).
 *
 * Expected outcome: settings.json updated from us-east-1 to eu-west-1
 * with a new API key, preserving all unrelated settings.
 *
 * Run: node test/integrated-429.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = "E:/claude-bedrock-recovery";
const DIST = join(REPO, "dist");
const FAKE_KEY =
  "SIMULATED_BEDROCK_KEY_eu_west_1_ABCDEF0123456789abcdef0123456789abcdefgh";

// ── Setup temp directory ──────────────────────────────────────────
const scratch = await mkdtemp(join(tmpdir(), "integrated-429-"));
const claudeDir = join(scratch, "claude");
await mkdir(claudeDir, { recursive: true });

// ── Write initial Claude settings (us-east-1, old key) ───────────
const existingSettings = {
  env: {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_BEARER_TOKEN_BEDROCK: "OLD_KEY_abc123_EXPIRED",
    AWS_REGION: "us-east-1",
    ANTHROPIC_MODEL: "us.anthropic.claude-opus-4-6",
    ANTHROPIC_DEFAULT_HAIKU_MODEL:
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    MY_CUSTOM_VAR: "should-be-preserved",
  },
  permissions: {
    allow: ["Bash(npm test)", "Read(*)"],
  },
  hooks: {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          { type: "command", command: "echo", args: ["pre-tool"], timeout: 5 },
        ],
      },
    ],
  },
};
await writeFile(
  join(claudeDir, "settings.json"),
  JSON.stringify(existingSettings, null, 2)
);

// ── Write recovery config ─────────────────────────────────────────
const recoveryConfig = {
  schemaVersion: 1,
  enabled: true,
  browser: {
    connection: "playwright-extension",
    channel: "chrome",
    profileName: "Default",
  },
  awsIdentity: { accountId: "123456789012", role: "TestRole" },
  claude: {
    configDirectory: claudeDir,
    configurationMethod: "setup-bedrock-wizard",
    continuationMode: "manual",
  },
  regions: [
    {
      region: "us-east-1",
      models: {
        primary: "us.anthropic.claude-opus-4-6",
        haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      },
    },
    {
      region: "eu-west-1",
      models: {
        primary: "eu.anthropic.claude-opus-4-6",
        haiku: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      },
    },
  ],
  recovery: {
    trigger: "stop-failure",
    maxPasses: 1,
    refreshExpiredKeyInCurrentRegionFirst: true,
    recoverCapacityErrors: false,
    automaticRestart: false,
  },
  diagnostics: { verbose: false },
};
const configPath = join(scratch, "config.json");
await writeFile(configPath, JSON.stringify(recoveryConfig));

// ── Write StopFailure payload (429 rate limit) ───────────────────
const stopFailurePayload = {
  session_id: "session-abc-123",
  prompt_id: "prompt-xyz",
  transcript_path: join(scratch, "transcript.jsonl"),
  cwd: scratch,
  hook_event_name: "StopFailure",
  error: "rate_limit",
  error_details:
    "HTTP 429 ThrottlingException: Too many requests, account quota exhausted for model us.anthropic.claude-opus-4-6 in region us-east-1",
  last_assistant_message:
    "I was working on implementing the feature when the API returned a rate limit error.",
};
const payloadPath = join(scratch, "payload.json");
await writeFile(payloadPath, JSON.stringify(stopFailurePayload));

// ── Write mock wizard module ──────────────────────────────────────
const mockWizardPath = join(scratch, "mock-wizard.mjs");
await writeFile(
  mockWizardPath,
  `
const FAKE_KEY = ${JSON.stringify(FAKE_KEY)};

export async function runWizard(key, candidate) {
  if (key !== FAKE_KEY) {
    return {
      success: false,
      env: null,
      reason: "Key mismatch in wizard: expected FAKE_KEY, got " + key.slice(0, 10) + "...",
      redactedTranscript: [],
    };
  }

  const env = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_BEARER_TOKEN_BEDROCK: key,
    AWS_REGION: candidate.region,
    ANTHROPIC_MODEL: candidate.models.primary,
  };
  if (candidate.models && candidate.models.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = candidate.models.haiku;
  }

  return {
    success: true,
    env,
    reason: "Wizard completed successfully (simulated)",
    redactedTranscript: ["[simulated wizard output]"],
  };
}
`
);

// ── Write ESM loader hooks ────────────────────────────────────────
const hooksPath = join(scratch, "hooks.mjs");
const wizardFileUrl = pathToFileURL(join(DIST, "wizard.js")).href;
const mockWizardUrl = pathToFileURL(mockWizardPath).href;

await writeFile(
  hooksPath,
  `
const REAL_WIZARD = ${JSON.stringify(wizardFileUrl)};
const MOCK_WIZARD = ${JSON.stringify(mockWizardUrl)};

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url === REAL_WIZARD) {
    return { ...result, url: MOCK_WIZARD };
  }
  return result;
}
`
);

// ── Write --import preload ────────────────────────────────────────
const preloadPath = join(scratch, "preload.mjs");
const browserUrl = pathToFileURL(join(DIST, "browser.js")).href;
const hooksUrl = pathToFileURL(hooksPath).href;

await writeFile(
  preloadPath,
  `
import { register } from "node:module";

// Register loader hooks to redirect wizard.js -> mock-wizard.mjs
register(${JSON.stringify(hooksUrl)}, import.meta.url);

// Patch BrowserAdapter prototype — ESM modules are singletons,
// so this patch is visible when coordinator.js imports browser.js
const { BrowserAdapter } = await import(${JSON.stringify(browserUrl)});

const FAKE_KEY = ${JSON.stringify(FAKE_KEY)};

BrowserAdapter.prototype.connect = async function () {};
BrowserAdapter.prototype.disconnect = async function () {};

BrowserAdapter.prototype.generateKey = async function (region, identity) {
  if (region === "us-east-1") {
    throw new Error("Should not attempt rate-limited region us-east-1");
  }
  return { key: FAKE_KEY, region, expiresAt: null };
};

BrowserAdapter.prototype.healthCheck = async function () {
  return { ok: true, reason: "Simulated: extension responding" };
};
`
);

// ── Run the test ──────────────────────────────────────────────────
console.log(
  "============================================================"
);
console.log("  Integrated 429 Recovery Test");
console.log("  Input:    us-east-1 with old expired key");
console.log("  Trigger:  HTTP 429 ThrottlingException");
console.log("  Expected: settings updated to eu-west-1 with new key");
console.log(
  "============================================================"
);
console.log();

console.log("Phase 1: Running CLI hook with simulated browser + wizard...");

const cliPath = join(DIST, "cli.js");
const payload = JSON.stringify(stopFailurePayload);
const preloadUrl = pathToFileURL(preloadPath).href;

let stdout = "", stderr = "", exitCode;
try {
  stdout = execFileSync(
    process.execPath,
    ["--import", preloadUrl, cliPath, "hook", "--claude-bedrock-recovery-managed", "--config", configPath],
    {
      input: payload,
      encoding: "utf-8",
      timeout: 30_000,
      env: {
        ...process.env,
        CLAUDE_BEDROCK_RECOVERY_HELPER: "",
        LOCALAPPDATA: join(scratch, "appdata"),
        APPDATA: join(scratch, "appdata"),
      },
      maxBuffer: 10 * 1024 * 1024,
    }
  );
  exitCode = 0;
} catch (err) {
  stdout = err.stdout || "";
  stderr = err.stderr || "";
  exitCode = err.status;
}

console.log(`  Exit code: ${exitCode}`);
if (stdout) console.log(`  Stdout: ${stdout.slice(0, 500)}`);
if (stderr) console.log(`  Stderr: ${stderr.slice(0, 500)}`);

// ── Verify results ────────────────────────────────────────────────
console.log("\nPhase 2: Verifying published settings...");

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}: ${detail}`);
    failures++;
  }
}

let finalRaw;
try {
  finalRaw = await readFile(join(claudeDir, "settings.json"), "utf-8");
} catch (err) {
  console.log(`  FAIL  Could not read settings.json: ${err.message}`);
  process.exit(1);
}

const final = JSON.parse(finalRaw);
const env = final.env || {};

console.log();
console.log("  Published settings.json env:");
console.log(`    AWS_REGION:                   ${env.AWS_REGION}`);
console.log(`    ANTHROPIC_MODEL:              ${env.ANTHROPIC_MODEL}`);
console.log(
  `    AWS_BEARER_TOKEN_BEDROCK:      ${env.AWS_BEARER_TOKEN_BEDROCK ? "(present, " + env.AWS_BEARER_TOKEN_BEDROCK.length + " chars)" : "MISSING"}`
);
console.log(
  `    ANTHROPIC_DEFAULT_HAIKU_MODEL: ${env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "not set"}`
);
console.log(`    CLAUDE_CODE_USE_BEDROCK:       ${env.CLAUDE_CODE_USE_BEDROCK}`);
console.log(`    MY_CUSTOM_VAR:                ${env.MY_CUSTOM_VAR}`);
console.log();

check("Hook exited successfully", exitCode === 0, `exit code ${exitCode}`);

// Bedrock fields changed to eu-west-1
check(
  "Region changed to eu-west-1",
  env.AWS_REGION === "eu-west-1",
  `got ${env.AWS_REGION}`
);
check(
  "Model changed to eu prefix",
  env.ANTHROPIC_MODEL === "eu.anthropic.claude-opus-4-6",
  `got ${env.ANTHROPIC_MODEL}`
);
check(
  "New API key present",
  env.AWS_BEARER_TOKEN_BEDROCK === FAKE_KEY,
  env.AWS_BEARER_TOKEN_BEDROCK === existingSettings.env.AWS_BEARER_TOKEN_BEDROCK
    ? "still has old key"
    : "key mismatch"
);
check(
  "Haiku model updated",
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL ===
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
  `got ${env.ANTHROPIC_DEFAULT_HAIKU_MODEL}`
);
check(
  "Bedrock enabled",
  env.CLAUDE_CODE_USE_BEDROCK === "1",
  `got ${env.CLAUDE_CODE_USE_BEDROCK}`
);

check(
  "Old key not present",
  env.AWS_BEARER_TOKEN_BEDROCK !== "OLD_KEY_abc123_EXPIRED",
  "old key still present"
);

// Unrelated settings preserved
check(
  "Custom env var preserved",
  env.MY_CUSTOM_VAR === "should-be-preserved",
  `got ${env.MY_CUSTOM_VAR}`
);
check(
  "Permissions preserved",
  JSON.stringify(final.permissions) ===
    JSON.stringify(existingSettings.permissions),
  "permissions changed"
);
check(
  "Hooks preserved",
  JSON.stringify(final.hooks) === JSON.stringify(existingSettings.hooks),
  "hooks changed"
);

// Notification output
check(
  "Notification emitted",
  stdout && stdout.includes("terminalSequence"),
  "no terminalSequence in stdout"
);
check(
  "Notification mentions success",
  stdout && /recovery succeeded/i.test(stdout),
  "stdout doesn't mention success"
);
check(
  "Notification mentions eu-west-1",
  stdout && stdout.includes("eu-west-1"),
  "stdout doesn't mention eu-west-1"
);

// ── Cleanup ───────────────────────────────────────────────────────
await rm(scratch, { recursive: true, force: true });

// ── Summary ───────────────────────────────────────────────────────
console.log();
console.log(
  "============================================================"
);
if (failures === 0) {
  console.log("  ALL CHECKS PASSED");
  console.log("  429 recovery flow verified end-to-end:");
  console.log("    us-east-1 (429) -> eu-west-1 (new key + model)");
  console.log("    Unrelated settings preserved");
} else {
  console.log(`  ${failures} CHECK(S) FAILED`);
}
console.log(
  "============================================================"
);
process.exit(failures > 0 ? 1 : 0);
