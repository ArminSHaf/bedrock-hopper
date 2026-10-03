/**
 * Recovery coordinator — state machine that serializes recovery operations,
 * tracks candidates, and publishes validated settings.
 *
 * Implements the state machine from docs/ARCHITECTURE.md:
 *   Working → Classify → WaitForLock → SelectRegion → ObtainKey
 *     → Validate → Publish → Working
 *
 * Each failure incident tries a candidate region/model combination at most
 * once.  Concurrent failures join the existing operation through the lock.
 * The coordinator rechecks the settings revision after acquiring the lock;
 * if another operation already resolved the incident, it does not generate
 * another key.
 */

import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BrowserAdapter } from "./browser.js";
import { classifyError } from "./classifier.js";
import { acquireLock } from "./lock.js";
import { log, registerSecret, clearSecrets } from "./logger.js";
import {
  buildRecoveryPatch,
  publishSettings,
  readClaudeSettings,
} from "./settings.js";
import { getClaudeConfigDir, getDataDir } from "./platform.js";

const COOLDOWN_MS = 5 * 60 * 1000;
import type {
  CandidateOutcome,
  ErrorClassification,
  RecoveryConfig,
  RecoveryResult,
  RecoveryState,
  RegionEntry,
  StopFailureInput,
} from "./types.js";

export async function startRecovery(
  input: StopFailureInput,
  config: RecoveryConfig,
): Promise<RecoveryResult> {
  const incidentId = randomUUID().slice(0, 8);
  const configDir = resolveConfigDir(config);

  await log({
    event: "recovery-start",
    incidentId,
    sessionId: input.session_id,
    error: input.error,
  });

  // Classify the error
  const classification = classifyError(input, config.recovery);

  await log({
    event: "error-classified",
    incidentId,
    errorCategory: classification.errorCategory,
    action: classification.action,
    reason: classification.reason,
  });

  if (classification.action === "stop-for-operator") {
    return immediateResult(incidentId, classification);
  }

  if (classification.action === "allow-existing-retries") {
    return immediateResult(incidentId, classification);
  }

  // Cooldown — skip if another recovery succeeded recently
  const cooldownResult = await checkCooldown(incidentId);
  if (cooldownResult) {
    return cooldownResult;
  }

  // Snapshot Bedrock configuration before lock — used to detect if another recovery resolved this
  const preFailureSettings = await readClaudeSettings(configDir);
  const preFailureFingerprint = bedrockFingerprint(preFailureSettings.content);

  // Acquire the per-configuration lock
  const identity = `${config.awsIdentity.accountId}:${config.awsIdentity.role}`;
  let lock;
  try {
    lock = await acquireLock(configDir, identity);
  } catch (err: unknown) {
    return {
      success: false,
      region: null,
      model: null,
      reason: `Lock acquisition failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: 0,
      candidatesAttempted: [],
    };
  }

  try {
    // Re-read settings after lock — another recovery may have resolved this
    const settingsBefore = await readClaudeSettings(configDir);
    const currentFingerprint = bedrockFingerprint(settingsBefore.content);

    if (currentFingerprint !== preFailureFingerprint) {
      const currentEnv = getSettingsEnv(settingsBefore.content);
      await log({
        event: "recovery-joined",
        incidentId,
        reason: "Bedrock configuration changed while waiting for lock",
        region: currentEnv.AWS_REGION,
        model: currentEnv.ANTHROPIC_MODEL,
      });
      return {
        success: true,
        region: currentEnv.AWS_REGION ?? null,
        model: currentEnv.ANTHROPIC_MODEL ?? null,
        reason: "Another recovery operation already updated Bedrock configuration",
        durationMs: 0,
        candidatesAttempted: [],
      };
    }

    const state: RecoveryState = {
      phase: "select-region",
      incidentId,
      sessionId: input.session_id,
      configDir,
      startedAt: Date.now(),
      currentCandidate: null,
      excludedCandidates: new Map(),
      settingsRevisionBefore: settingsBefore.contentHash,
      result: null,
    };

    return await runCandidateLoop(state, config, settingsBefore, classification);
  } finally {
    await lock.release();
  }
}

/**
 * Manual recovery — bypass error classification and go directly to
 * candidate selection.  Used by the `recover` CLI command.
 */
export async function startManualRecovery(
  config: RecoveryConfig,
  opts: {
    targetRegion?: string;
    dryRun: boolean;
  },
): Promise<RecoveryResult> {
  const incidentId = randomUUID().slice(0, 8);
  const configDir = resolveConfigDir(config);

  await log({ event: "manual-recovery-start", incidentId });

  if (opts.dryRun) {
    return dryRunCheck(incidentId, config, opts.targetRegion);
  }

  const identity = `${config.awsIdentity.accountId}:${config.awsIdentity.role}`;
  let lock;
  try {
    lock = await acquireLock(configDir, identity);
  } catch (err: unknown) {
    return {
      success: false,
      region: null,
      model: null,
      reason: `Lock acquisition failed: ${err instanceof Error ? err.message : String(err)}`,
      durationMs: 0,
      candidatesAttempted: [],
    };
  }

  try {
    const settingsBefore = await readClaudeSettings(configDir);
    const classification: ErrorClassification = {
      action: "region-recovery",
      reason: "Manual recovery requested",
      errorCategory: "manual",
    };

    const candidates = opts.targetRegion
      ? config.regions.filter((r) => r.region === opts.targetRegion)
      : config.regions;

    if (candidates.length === 0) {
      return {
        success: false,
        region: null,
        model: null,
        reason: opts.targetRegion
          ? `Region "${opts.targetRegion}" not found in configuration`
          : "No regions configured",
        durationMs: 0,
        candidatesAttempted: [],
      };
    }

    const state: RecoveryState = {
      phase: "select-region",
      incidentId,
      sessionId: "manual",
      configDir,
      startedAt: Date.now(),
      currentCandidate: null,
      excludedCandidates: new Map(),
      settingsRevisionBefore: settingsBefore.contentHash,
      result: null,
    };

    return await runCandidateLoop(state, { ...config, regions: candidates }, settingsBefore, classification);
  } finally {
    await lock.release();
  }
}

function isInfrastructureFailure(reason: string): boolean {
  return (
    /extension.*not found/i.test(reason) ||
    /playwright.*not found/i.test(reason) ||
    /MCP.*failed/i.test(reason) ||
    /browser.*not.*reachable/i.test(reason) ||
    /Identity verification failed/i.test(reason) ||
    /session expired/i.test(reason)
  );
}

async function runCandidateLoop(
  state: RecoveryState,
  config: RecoveryConfig,
  settingsBefore: Awaited<ReturnType<typeof readClaudeSettings>>,
  classification: ErrorClassification,
): Promise<RecoveryResult> {
  const candidatesAttempted: CandidateOutcome[] = [];
  const browser = new BrowserAdapter(config.browser);
  let pass = 0;

  // If refreshExpiredKeyInCurrentRegionFirst, try current region first
  let candidates = [...config.regions];
  if (
    classification.action === "refresh-current-key" &&
    config.recovery.refreshExpiredKeyInCurrentRegionFirst
  ) {
    const currentRegion = getCurrentRegion(settingsBefore.content);
    if (currentRegion) {
      const currentEntry = candidates.find((c) => c.region === currentRegion);
      if (currentEntry) {
        candidates = [
          currentEntry,
          ...candidates.filter((c) => c.region !== currentRegion),
        ];
      }
    }
  }

  // For skip-candidate or region-recovery, rotate to the NEXT region in the
  // list after the current one (round-robin), so we cycle through all regions
  // instead of always falling back to the first one.
  if (
    classification.action === "skip-candidate" ||
    classification.action === "region-recovery"
  ) {
    const currentRegion = getCurrentRegion(settingsBefore.content);
    if (currentRegion) {
      const currentIdx = candidates.findIndex((c) => c.region === currentRegion);
      if (currentIdx >= 0) {
        candidates = [
          ...candidates.slice(currentIdx + 1),
          ...candidates.slice(0, currentIdx),
        ];
      }
      if (candidates.length === 0) {
        return {
          success: false,
          region: null,
          model: null,
          reason: `No alternative regions after excluding failed region ${currentRegion}`,
          durationMs: Date.now() - state.startedAt,
          candidatesAttempted: [],
        };
      }
    }
  }

  try {
    await browser.connect();
  } catch (err: unknown) {
    await browser.disconnect();
    return {
      success: false,
      region: null,
      model: null,
      reason: `Browser connection failed: ${err instanceof Error ? err.message : String(err)}. ` +
        "Verify that Chrome/Edge is running with the Playwright extension installed.",
      durationMs: Date.now() - state.startedAt,
      candidatesAttempted,
    };
  }

  try {
    while (pass < config.recovery.maxPasses) {
      for (const candidate of candidates) {
        const candidateKey = `${candidate.region}:${candidate.models.primary}`;
        if (state.excludedCandidates.has(candidateKey)) {
          continue;
        }

        state.currentCandidate = candidate;
        state.phase = "obtain-key";

        await log({
          event: "trying-candidate",
          incidentId: state.incidentId,
          region: candidate.region,
          model: candidate.models.primary,
        });

        // Generate key
        let keyResult;
        try {
          keyResult = await browser.generateKey(
            candidate.region,
            config.awsIdentity,
          );
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err);
          state.excludedCandidates.set(candidateKey, reason);
          candidatesAttempted.push({
            region: candidate.region,
            model: candidate.models.primary,
            outcome: "key-generation-failed",
            reason,
          });

          // Infrastructure/browser/identity failures stop the entire operation
          if (isInfrastructureFailure(reason)) {
            return {
              success: false,
              region: candidate.region,
              model: candidate.models.primary,
              reason: `Infrastructure failure: ${reason}`,
              durationMs: Date.now() - state.startedAt,
              candidatesAttempted,
            };
          }

          continue;
        }

        // Register the key as a secret before any logging
        registerSecret(keyResult.key);

        // Publish settings directly — the key was just generated from the
        // AWS console so it is valid.  Skipping the wizard avoids a 2-minute
        // PTY round-trip through /setup-bedrock.
        state.phase = "publish";
        const patch = buildRecoveryPatch(keyResult.key, candidate);

        const pubResult = await publishSettings(patch, settingsBefore);

        if (!pubResult.published) {
          candidatesAttempted.push({
            region: candidate.region,
            model: candidate.models.primary,
            outcome: "validation-failed",
            reason: pubResult.reason,
          });
          return {
            success: false,
            region: candidate.region,
            model: candidate.models.primary,
            reason: pubResult.reason,
            durationMs: Date.now() - state.startedAt,
            candidatesAttempted,
          };
        }

        candidatesAttempted.push({
          region: candidate.region,
          model: candidate.models.primary,
          outcome: "success",
          reason: "Settings published",
        });

        const result: RecoveryResult = {
          success: true,
          region: candidate.region,
          model: candidate.models.primary,
          reason: `Recovery succeeded — region ${candidate.region}, model ${candidate.models.primary}`,
          durationMs: Date.now() - state.startedAt,
          candidatesAttempted,
        };

        await log({
          event: "recovery-success",
          incidentId: state.incidentId,
          region: candidate.region,
          model: candidate.models.primary,
          durationMs: result.durationMs,
        });

        await wakeIdleSessions(state.sessionId);
        await writeCooldown(candidate.region);

        return result;
      }
      pass++;
    }

    // All candidates exhausted — log while secrets are still registered
    const exhaustedResult: RecoveryResult = {
      success: false,
      region: null,
      model: null,
      reason: `All ${candidatesAttempted.length} candidate(s) exhausted after ${config.recovery.maxPasses} pass(es)`,
      durationMs: Date.now() - state.startedAt,
      candidatesAttempted,
    };

    await log({
      event: "recovery-exhausted",
      incidentId: state.incidentId,
      candidatesAttempted: candidatesAttempted.map((c) => ({
        region: c.region,
        outcome: c.outcome,
        reason: c.reason,
      })),
    });

    return exhaustedResult;
  } finally {
    await browser.disconnect();
    clearSecrets();
  }
}

async function dryRunCheck(
  incidentId: string,
  config: RecoveryConfig,
  targetRegion?: string,
): Promise<RecoveryResult> {
  const candidates = targetRegion
    ? config.regions.filter((r) => r.region === targetRegion)
    : config.regions;

  const configDir = resolveConfigDir(config);
  const settings = await readClaudeSettings(configDir);

  const lines: string[] = [
    "=== DRY RUN — no keys generated, no settings changed ===",
    "",
    `Configuration directory: ${configDir}`,
    `Settings file: ${settings.path}`,
    `AWS identity: ${config.awsIdentity.accountId} / ${config.awsIdentity.role}`,
    `Browser: ${config.browser.channel}, profile "${config.browser.profileName}"`,
    "",
    `Candidates (${candidates.length}):`,
  ];

  const outcomes: CandidateOutcome[] = [];
  for (const c of candidates) {
    lines.push(`  ${c.region} — primary: ${c.models.primary}, haiku: ${c.models.haiku ?? "none"}`);
    outcomes.push({
      region: c.region,
      model: c.models.primary,
      outcome: "skipped",
      reason: "Dry run — not attempted",
    });
  }

  // Check browser reachability
  lines.push("");
  let browserOk = false;
  const browser = new BrowserAdapter(config.browser);
  try {
    await browser.connect();
    const health = await browser.healthCheck();
    browserOk = health.ok;
    lines.push(`Browser: ${health.ok ? "reachable" : "NOT reachable"} — ${health.reason}`);
    await browser.disconnect();
  } catch (err: unknown) {
    lines.push(`Browser: NOT reachable — ${err instanceof Error ? err.message : String(err)}`);
    await browser.disconnect();
  }

  // Check for conflicts
  const { detectConflicts } = await import("./settings.js");
  const conflicts = detectConflicts(settings.content);
  if (conflicts.length > 0) {
    lines.push("");
    lines.push("Conflicts detected:");
    for (const c of conflicts) {
      lines.push(`  ⚠ ${c}`);
    }
  }

  const allOk = browserOk && conflicts.length === 0;
  const reason = lines.join("\n");
  process.stdout.write(reason + "\n");

  return {
    success: allOk,
    region: null,
    model: null,
    reason: allOk ? "Dry run completed" : "Dry run completed with failures",
    durationMs: 0,
    candidatesAttempted: outcomes,
  };
}

function resolveConfigDir(config: RecoveryConfig): string {
  if (config.claude.configDirectory === "auto") {
    return getClaudeConfigDir();
  }
  return config.claude.configDirectory;
}

function getCurrentRegion(
  settings: Record<string, unknown>,
): string | null {
  if (typeof settings.env !== "object" || settings.env === null) {
    return null;
  }
  const env = settings.env as Record<string, string>;
  return env.AWS_REGION ?? null;
}

function getSettingsEnv(
  settings: Record<string, unknown>,
): Record<string, string> {
  if (typeof settings.env !== "object" || settings.env === null) {
    return {};
  }
  return settings.env as Record<string, string>;
}

const BEDROCK_FINGERPRINT_KEYS = [
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_REGION",
  "ANTHROPIC_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
] as const;

function bedrockFingerprint(settings: Record<string, unknown>): string {
  const env = getSettingsEnv(settings);
  return BEDROCK_FINGERPRINT_KEYS.map((k) => `${k}=${env[k] ?? ""}`).join("\0");
}

function immediateResult(
  incidentId: string,
  classification: ErrorClassification,
): RecoveryResult {
  return {
    success: false,
    region: null,
    model: null,
    reason: `${classification.action}: ${classification.reason}`,
    durationMs: 0,
    candidatesAttempted: [],
  };
}

function getCooldownPath(): string {
  return join(getDataDir(), "last-recovery.json");
}

async function checkCooldown(incidentId: string): Promise<RecoveryResult | null> {
  try {
    const raw = await readFile(getCooldownPath(), "utf8");
    const data = JSON.parse(raw);
    const elapsed = Date.now() - data.timestamp;
    if (elapsed < COOLDOWN_MS) {
      const remainingSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      await log({
        event: "cooldown-active",
        incidentId,
        lastRegion: data.region,
        elapsedSec: Math.floor(elapsed / 1000),
        remainingSec,
      });
      return {
        success: true,
        region: data.region,
        model: null,
        reason: `Recovery already ran ${Math.floor(elapsed / 1000)}s ago (region ${data.region}). Cooldown: ${remainingSec}s remaining. New settings should already be active.`,
        durationMs: 0,
        candidatesAttempted: [],
      };
    }
  } catch {
    // No cooldown file or invalid — proceed
  }
  return null;
}

async function writeCooldown(region: string): Promise<void> {
  try {
    const dir = getDataDir();
    await mkdir(dir, { recursive: true });
    await writeFile(
      getCooldownPath(),
      JSON.stringify({ timestamp: Date.now(), region }),
    );
  } catch {
    // best-effort
  }
}

interface ClaudeSession {
  pid: number;
  sessionId: string;
  status: string;
  cwd: string;
  kind: string;
}

async function wakeIdleSessions(triggerSessionId: string): Promise<void> {
  try {
    const sessions = await listClaudeSessions();
    const idle = sessions.filter(
      (s) => s.status === "idle" && s.sessionId !== triggerSessionId,
    );

    if (idle.length === 0) {
      await log({ event: "wake-sessions", found: 0 });
      return;
    }

    await log({ event: "wake-sessions", found: idle.length });

    for (const session of idle) {
      try {
        const child = spawn(
          "claude",
          [
            "--resume", session.sessionId,
            "--dangerously-skip-permissions",
            "-p", "continue",
            "--print",
          ],
          {
            stdio: "ignore",
            detached: true,
            shell: true,
          },
        );
        child.unref();
        await log({
          event: "wake-session-sent",
          sessionId: session.sessionId,
          pid: session.pid,
        });
      } catch (err: unknown) {
        await log({
          event: "wake-session-failed",
          sessionId: session.sessionId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err: unknown) {
    await log({
      event: "wake-sessions-error",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

function listClaudeSessions(): Promise<ClaudeSession[]> {
  return new Promise((resolve) => {
    execFile("claude", ["sessions", "list", "--json"], { shell: true, timeout: 10_000 }, (err, stdout) => {
      if (err) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (Array.isArray(parsed)) {
          resolve(parsed as ClaudeSession[]);
          return;
        }
      } catch {
        // invalid JSON
      }
      resolve([]);
    });
  });
}
