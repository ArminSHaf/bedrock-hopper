/**
 * Integration test suite — multiple recovery scenarios.
 *
 * Each scenario runs the REAL CLI hook with simulated browser + wizard
 * via --import preload + ESM loader hooks.
 *
 * Run: node test/integrated-scenarios.mjs
 */

import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = "E:/claude-bedrock-recovery";
const DIST = join(REPO, "dist");
const FAKE_KEY =
  "SIMULATED_BEDROCK_KEY_ABCDEF0123456789abcdef0123456789abcdefghijklmnop";

let totalPass = 0;
let totalFail = 0;
const results = [];

// ── Helpers ───────────────────────────────────────────────────────

async function setupScenario(name, { settings, config, payload }) {
  const scratch = await mkdtemp(join(tmpdir(), `scenario-${name}-`));
  const claudeDir = join(scratch, "claude");
  await mkdir(claudeDir, { recursive: true });

  await writeFile(
    join(claudeDir, "settings.json"),
    JSON.stringify(settings, null, 2)
  );

  const configPath = join(scratch, "config.json");
  // Inject claudeDir into config
  config.claude.configDirectory = claudeDir;
  await writeFile(configPath, JSON.stringify(config));

  const payloadPath = join(scratch, "payload.json");
  await writeFile(payloadPath, JSON.stringify(payload));

  // Write mock wizard
  const mockWizardPath = join(scratch, "mock-wizard.mjs");
  await writeFile(
    mockWizardPath,
    `
const FAKE_KEY = ${JSON.stringify(FAKE_KEY)};
export async function runWizard(key, candidate) {
  const env = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_BEARER_TOKEN_BEDROCK: key,
    AWS_REGION: candidate.region,
    ANTHROPIC_MODEL: candidate.models.primary,
  };
  if (candidate.models && candidate.models.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = candidate.models.haiku;
  }
  return { success: true, env, reason: "Simulated", redactedTranscript: [] };
}
`
  );

  // Write ESM loader hooks
  const hooksPath = join(scratch, "hooks.mjs");
  const wizardFileUrl = pathToFileURL(join(DIST, "wizard.js")).href;
  const mockWizardUrl = pathToFileURL(mockWizardPath).href;
  await writeFile(
    hooksPath,
    `
const REAL = ${JSON.stringify(wizardFileUrl)};
const MOCK = ${JSON.stringify(mockWizardUrl)};
export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (result.url === REAL) return { ...result, url: MOCK };
  return result;
}
`
  );

  // Write preload
  const preloadPath = join(scratch, "preload.mjs");
  const browserUrl = pathToFileURL(join(DIST, "browser.js")).href;
  const hooksUrl = pathToFileURL(hooksPath).href;
  await writeFile(
    preloadPath,
    `
import { register } from "node:module";
register(${JSON.stringify(hooksUrl)}, import.meta.url);

const { BrowserAdapter } = await import(${JSON.stringify(browserUrl)});
const FAKE_KEY = ${JSON.stringify(FAKE_KEY)};

BrowserAdapter.prototype.connect = async function () {};
BrowserAdapter.prototype.disconnect = async function () {};
BrowserAdapter.prototype.generateKey = async function (region) {
  return { key: FAKE_KEY, region, expiresAt: null };
};
BrowserAdapter.prototype.healthCheck = async function () {
  return { ok: true, reason: "Simulated" };
};
`
  );

  return { scratch, claudeDir, configPath, preloadPath };
}

async function runHook({ scratch, configPath, preloadPath, payload }) {
  const preloadUrl = pathToFileURL(preloadPath).href;
  const cliPath = join(DIST, "cli.js");

  let stdout = "",
    stderr = "",
    exitCode;
  try {
    stdout = execFileSync(
      process.execPath,
      [
        "--import",
        preloadUrl,
        cliPath,
        "hook",
        "--claude-bedrock-recovery-managed",
        "--config",
        configPath,
      ],
      {
        input: JSON.stringify(payload),
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

  return { stdout, stderr, exitCode };
}

function check(scenario, label, condition, detail) {
  if (condition) {
    totalPass++;
    return true;
  } else {
    console.log(`    FAIL  ${label}: ${detail}`);
    totalFail++;
    return false;
  }
}

function baseConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    enabled: true,
    browser: {
      connection: "playwright-extension",
      channel: "chrome",
      profileName: "Default",
    },
    awsIdentity: { accountId: "123456789012", role: "TestRole" },
    claude: {
      configDirectory: "REPLACED",
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
      ...overrides,
    },
    diagnostics: { verbose: false },
  };
}

function baseSettings() {
  return {
    env: {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "OLD_KEY_abc123",
      AWS_REGION: "us-east-1",
      ANTHROPIC_MODEL: "us.anthropic.claude-opus-4-6",
      MY_CUSTOM_VAR: "preserved",
    },
    permissions: { allow: ["Read(*)"] },
  };
}

// ── Scenarios ─────────────────────────────────────────────────────

async function scenario_429_recovery() {
  const name = "429-rate-limit";
  const payload = {
    session_id: "s1",
    error: "rate_limit",
    error_details: "HTTP 429 ThrottlingException: quota exhausted",
  };

  const env = await setupScenario(name, {
    settings: baseSettings(),
    config: baseConfig(),
    payload,
  });

  const { stdout, exitCode } = await runHook({ ...env, payload });
  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region -> eu-west-1", final.env.AWS_REGION === "eu-west-1", final.env.AWS_REGION);
  c("model updated", final.env.ANTHROPIC_MODEL === "eu.anthropic.claude-opus-4-6", final.env.ANTHROPIC_MODEL);
  c("new key", final.env.AWS_BEARER_TOKEN_BEDROCK === FAKE_KEY, "mismatch");
  c("custom preserved", final.env.MY_CUSTOM_VAR === "preserved", final.env.MY_CUSTOM_VAR);
  c("notification", /recovery succeeded/i.test(stdout), "no success notification");

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

async function scenario_expired_key() {
  const name = "expired-key";
  const payload = {
    session_id: "s2",
    error: "auth_error",
    error_details: "The security token included in the request is expired",
  };

  const env = await setupScenario(name, {
    settings: baseSettings(),
    config: baseConfig(),
    payload,
  });

  const { stdout, exitCode } = await runHook({ ...env, payload });
  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  // Expired key with refreshExpiredKeyInCurrentRegionFirst=true
  // should try current region (us-east-1) first
  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region -> us-east-1 (refresh)", final.env.AWS_REGION === "us-east-1", final.env.AWS_REGION);
  c("new key", final.env.AWS_BEARER_TOKEN_BEDROCK === FAKE_KEY, "mismatch");
  c("notification", /recovery succeeded/i.test(stdout), "no success notification");

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

async function scenario_400_stop_for_operator() {
  const name = "400-invalid-request";
  const payload = {
    session_id: "s3",
    error: "invalid_request",
    error_details: "HTTP 400 Bad Request: malformed input",
  };

  const env = await setupScenario(name, {
    settings: baseSettings(),
    config: baseConfig(),
    payload,
  });

  const { stdout, exitCode } = await runHook({ ...env, payload });
  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  // 400 unrelated to region should stop — no settings change
  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region unchanged", final.env.AWS_REGION === "us-east-1", final.env.AWS_REGION);
  c("key unchanged", final.env.AWS_BEARER_TOKEN_BEDROCK === "OLD_KEY_abc123", final.env.AWS_BEARER_TOKEN_BEDROCK);
  c("notification mentions stop", /stop.*operator|preserving error/i.test(stdout) || !(/recovery succeeded/i.test(stdout)), stdout.slice(0, 200));

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

async function scenario_billing_stop() {
  const name = "billing-limit";
  const payload = {
    session_id: "s4",
    error: "api_error",
    error_details: "Account has exceeded spend limit. Contact billing.",
  };

  const env = await setupScenario(name, {
    settings: baseSettings(),
    config: baseConfig(),
    payload,
  });

  const { stdout, exitCode } = await runHook({ ...env, payload });
  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  // Billing errors should never trigger recovery
  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region unchanged", final.env.AWS_REGION === "us-east-1", final.env.AWS_REGION);
  c("key unchanged", final.env.AWS_BEARER_TOKEN_BEDROCK === "OLD_KEY_abc123", final.env.AWS_BEARER_TOKEN_BEDROCK);
  c("no success notification", !(/recovery succeeded/i.test(stdout)), "got success when shouldn't");

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

async function scenario_overloaded_no_capacity_recovery() {
  const name = "overloaded-no-recovery";
  const payload = {
    session_id: "s5",
    error: "overloaded",
    error_details: "Service is overloaded, please try again later",
  };

  const env = await setupScenario(name, {
    settings: baseSettings(),
    config: baseConfig({ recoverCapacityErrors: false }),
    payload,
  });

  const { stdout, exitCode } = await runHook({ ...env, payload });
  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  // Overloaded with recoverCapacityErrors=false should allow retries, not recover
  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region unchanged", final.env.AWS_REGION === "us-east-1", final.env.AWS_REGION);
  c("key unchanged", final.env.AWS_BEARER_TOKEN_BEDROCK === "OLD_KEY_abc123", final.env.AWS_BEARER_TOKEN_BEDROCK);
  c("no success notification", !(/recovery succeeded/i.test(stdout)), "got success when shouldn't");

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

async function scenario_overloaded_with_capacity_recovery() {
  const name = "overloaded-with-recovery";
  const payload = {
    session_id: "s6",
    error: "overloaded",
    error_details: "Service is overloaded, please try again later",
  };

  const env = await setupScenario(name, {
    settings: baseSettings(),
    config: baseConfig({ recoverCapacityErrors: true }),
    payload,
  });

  const { stdout, exitCode } = await runHook({ ...env, payload });
  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  // Overloaded with recoverCapacityErrors=true should trigger region recovery
  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region -> eu-west-1", final.env.AWS_REGION === "eu-west-1", final.env.AWS_REGION);
  c("new key", final.env.AWS_BEARER_TOKEN_BEDROCK === FAKE_KEY, "mismatch");
  c("notification", /recovery succeeded/i.test(stdout), "no success notification");

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

async function scenario_model_not_found() {
  const name = "model-not-found";
  const payload = {
    session_id: "s7",
    error: "api_error",
    error_details: "Model not found in region us-east-1. The model is not available in this region.",
  };

  const env = await setupScenario(name, {
    settings: baseSettings(),
    config: baseConfig(),
    payload,
  });

  const { stdout, exitCode } = await runHook({ ...env, payload });
  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  // Model not found should skip candidate, try next region
  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region -> eu-west-1", final.env.AWS_REGION === "eu-west-1", final.env.AWS_REGION);
  c("new key", final.env.AWS_BEARER_TOKEN_BEDROCK === FAKE_KEY, "mismatch");
  c("notification", /recovery succeeded/i.test(stdout), "no success notification");

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

async function scenario_disabled_config() {
  const name = "disabled-config";
  const payload = {
    session_id: "s8",
    error: "rate_limit",
    error_details: "HTTP 429 ThrottlingException",
  };

  const config = baseConfig();
  config.enabled = false;

  const env = await setupScenario(name, {
    settings: baseSettings(),
    config,
    payload,
  });

  const { stdout, exitCode } = await runHook({ ...env, payload });
  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  // Disabled config should do nothing
  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region unchanged", final.env.AWS_REGION === "us-east-1", final.env.AWS_REGION);
  c("key unchanged", final.env.AWS_BEARER_TOKEN_BEDROCK === "OLD_KEY_abc123", final.env.AWS_BEARER_TOKEN_BEDROCK);

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

async function scenario_invalid_token() {
  const name = "invalid-token";
  const payload = {
    session_id: "s9",
    error: "auth_error",
    error_details: "The token included in the request is invalid",
  };

  const env = await setupScenario(name, {
    settings: baseSettings(),
    config: baseConfig(),
    payload,
  });

  const { stdout, exitCode } = await runHook({ ...env, payload });
  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  // Invalid token (not expired) should stop for operator
  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region unchanged", final.env.AWS_REGION === "us-east-1", final.env.AWS_REGION);
  c("key unchanged", final.env.AWS_BEARER_TOKEN_BEDROCK === "OLD_KEY_abc123", final.env.AWS_BEARER_TOKEN_BEDROCK);
  c("no recovery", !(/recovery succeeded/i.test(stdout)), "wrongly recovered");

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

async function scenario_brief_rate_limit() {
  const name = "brief-rate-limit";
  const payload = {
    session_id: "s10",
    error: "rate_limit",
    error_details: "HTTP 429 Too Many Requests. Brief rate limit, retry after 5 seconds",
  };

  const env = await setupScenario(name, {
    settings: baseSettings(),
    config: baseConfig(),
    payload,
  });

  const { stdout, exitCode } = await runHook({ ...env, payload });
  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  // Brief rate limit should allow existing retries, not recover
  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region unchanged", final.env.AWS_REGION === "us-east-1", final.env.AWS_REGION);
  c("key unchanged", final.env.AWS_BEARER_TOKEN_BEDROCK === "OLD_KEY_abc123", final.env.AWS_BEARER_TOKEN_BEDROCK);
  c("no recovery", !(/recovery succeeded/i.test(stdout)), "wrongly recovered");

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

async function scenario_settings_preserved() {
  const name = "settings-preservation";
  const payload = {
    session_id: "s11",
    error: "rate_limit",
    error_details: "HTTP 429 ThrottlingException: quota exhausted",
  };

  // Rich settings with lots of unrelated fields
  const settings = {
    env: {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "OLD_KEY",
      AWS_REGION: "us-east-1",
      ANTHROPIC_MODEL: "us.anthropic.claude-opus-4-6",
      CUSTOM_A: "aaa",
      CUSTOM_B: "bbb",
      PATH_EXTRA: "/usr/local/custom",
    },
    permissions: {
      allow: ["Bash(npm test)", "Bash(npm run build)", "Read(*)", "Edit(src/*)"],
      deny: ["Bash(rm -rf /*)"],
    },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "lint-check" }] },
      ],
      StopFailure: [
        {
          matcher: "*",
          hooks: [{
            type: "command",
            command: "node",
            args: ["dist/cli.js", "hook"],
            timeout: 300,
          }],
        },
      ],
    },
    mcpServers: {
      playwright: { command: "node", args: ["mcp.js"] },
    },
    theme: "dark",
    preferredNotifChannel: "osc777",
  };

  const env = await setupScenario(name, {
    settings,
    config: baseConfig(),
    payload,
  });

  const { stdout, exitCode } = await runHook({ ...env, payload });
  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region changed", final.env.AWS_REGION === "eu-west-1", final.env.AWS_REGION);
  c("CUSTOM_A", final.env.CUSTOM_A === "aaa", final.env.CUSTOM_A);
  c("CUSTOM_B", final.env.CUSTOM_B === "bbb", final.env.CUSTOM_B);
  c("PATH_EXTRA", final.env.PATH_EXTRA === "/usr/local/custom", final.env.PATH_EXTRA);
  c("permissions", JSON.stringify(final.permissions) === JSON.stringify(settings.permissions), "changed");
  c("hooks", JSON.stringify(final.hooks) === JSON.stringify(settings.hooks), "changed");
  c("mcpServers", JSON.stringify(final.mcpServers) === JSON.stringify(settings.mcpServers), "changed");
  c("theme", final.theme === "dark", final.theme);
  c("preferredNotifChannel", final.preferredNotifChannel === "osc777", final.preferredNotifChannel);

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

async function scenario_helper_guard() {
  const name = "helper-recursion-guard";
  const payload = {
    session_id: "s12",
    error: "rate_limit",
    error_details: "HTTP 429 ThrottlingException",
  };

  const env = await setupScenario(name, {
    settings: baseSettings(),
    config: baseConfig(),
    payload,
  });

  // Run with CLAUDE_BEDROCK_RECOVERY_HELPER=1 (wizard child process)
  const preloadUrl = pathToFileURL(env.preloadPath).href;
  const cliPath = join(DIST, "cli.js");
  let stdout = "", exitCode;
  try {
    stdout = execFileSync(
      process.execPath,
      ["--import", preloadUrl, cliPath, "hook", "--claude-bedrock-recovery-managed", "--config", env.configPath],
      {
        input: JSON.stringify(payload),
        encoding: "utf-8",
        timeout: 15_000,
        env: {
          ...process.env,
          CLAUDE_BEDROCK_RECOVERY_HELPER: "1",
          LOCALAPPDATA: join(env.scratch, "appdata"),
          APPDATA: join(env.scratch, "appdata"),
        },
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    exitCode = 0;
  } catch (err) {
    stdout = err.stdout || "";
    exitCode = err.status;
  }

  const final = JSON.parse(
    await readFile(join(env.claudeDir, "settings.json"), "utf-8")
  );

  let pass = 0, fail = 0;
  const c = (l, cond, d) => {
    if (check(name, l, cond, d)) pass++;
    else fail++;
  };

  // Helper guard should prevent recovery from running
  c("exit 0", exitCode === 0, `exit ${exitCode}`);
  c("region unchanged", final.env.AWS_REGION === "us-east-1", final.env.AWS_REGION);
  c("key unchanged", final.env.AWS_BEARER_TOKEN_BEDROCK === "OLD_KEY_abc123", final.env.AWS_BEARER_TOKEN_BEDROCK);
  c("no output", !stdout || stdout.trim() === "", `got: ${stdout.slice(0, 100)}`);

  await rm(env.scratch, { recursive: true, force: true });
  return { name, pass, fail };
}

// ── Run all scenarios ─────────────────────────────────────────────

console.log("============================================================");
console.log("  Integration Test Suite — Multiple Scenarios");
console.log("============================================================");
console.log();

const scenarios = [
  { fn: scenario_429_recovery, desc: "429 rate limit -> region recovery" },
  { fn: scenario_expired_key, desc: "Expired key -> refresh in current region" },
  { fn: scenario_400_stop_for_operator, desc: "400 bad request -> stop for operator" },
  { fn: scenario_billing_stop, desc: "Billing limit -> stop for operator" },
  { fn: scenario_overloaded_no_capacity_recovery, desc: "Overloaded (no capacity recovery) -> allow retries" },
  { fn: scenario_overloaded_with_capacity_recovery, desc: "Overloaded (capacity recovery ON) -> region recovery" },
  { fn: scenario_model_not_found, desc: "Model not found -> skip candidate" },
  { fn: scenario_disabled_config, desc: "Disabled config -> no action" },
  { fn: scenario_invalid_token, desc: "Invalid token (not expired) -> stop for operator" },
  { fn: scenario_brief_rate_limit, desc: "Brief rate limit -> allow retries" },
  { fn: scenario_settings_preserved, desc: "Rich settings preservation (10 fields)" },
  { fn: scenario_helper_guard, desc: "Helper recursion guard -> no action" },
];

for (const { fn, desc } of scenarios) {
  process.stdout.write(`  ${desc}... `);
  try {
    const r = await fn();
    results.push(r);
    if (r.fail === 0) {
      console.log(`PASS (${r.pass} checks)`);
    } else {
      console.log(`FAIL (${r.pass} pass, ${r.fail} fail)`);
    }
  } catch (err) {
    console.log(`ERROR: ${err.message}`);
    totalFail++;
    results.push({ name: desc, pass: 0, fail: 1 });
  }
}

// ── Summary ───────────────────────────────────────────────────────
console.log();
console.log("============================================================");
console.log(`  ${results.length} scenarios, ${totalPass} checks passed, ${totalFail} failed`);
if (totalFail === 0) {
  console.log("  ALL SCENARIOS PASSED");
} else {
  console.log("  SOME CHECKS FAILED — see details above");
}
console.log("============================================================");
process.exit(totalFail > 0 ? 1 : 0);
