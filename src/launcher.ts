/**
 * Terminal launcher — `claude-auto` wrapper that forwards Claude arguments,
 * terminal I/O, and resize events through node-pty.
 *
 * Preserves the user's permission mode (including --dangerously-skip-permissions)
 * by passing arguments as an array, never rebuilding them as a shell command string.
 *
 * The launcher observes terminal output for eligible failure messages and
 * can trigger recovery before StopFailure fires.  Continuation is submitted
 * only when:
 *   - Recovery succeeded
 *   - The session is at an idle prompt
 *   - No user input is queued or unsubmitted
 *   - The session was not busy, in a permission dialog, or slash-command menu
 *
 * ASSUMPTION (UNTESTED): Failure message patterns, idle prompt detection,
 * and session lifecycle output require calibration against live Claude Code.
 */

import { loadConfig } from "./config.js";
import { startRecovery } from "./coordinator.js";
import { configureLogger, log, logSync } from "./logger.js";
import { isWindows, resolveClaude } from "./platform.js";
import type { StopFailureInput } from "./types.js";

// Patterns for detecting eligible API failure output in the terminal.
// These must be versioned and verified against actual Claude Code output.
// Disable unverified early detection rather than guessing.
const FAILURE_PATTERNS = [
  /API error.*(?:429|rate.?limit|throttl)/i,
  /API error.*(?:overload|503|529)/i,
  /API error.*(?:auth|credential|expired)/i,
  /Bedrock.*(?:error|fail|unavailable)/i,
];

const IDLE_PROMPT_PATTERN = /^[>$%#]\s*$/m;
const BUSY_INDICATORS = [
  /⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/, // spinner
  /Thinking|Working|Running|Reading|Editing|Searching/,
  /\[y\/n\]|\[Y\/n\]/i, // permission dialog
];

export async function launchClaude(
  claudeArgs: string[],
  configPath?: string,
): Promise<number> {
  const claudePath = await resolveClaude();
  if (!claudePath) {
    process.stderr.write(
      "Error: claude executable not found on PATH.\n" +
        "Install Claude Code first: https://code.claude.com\n",
    );
    return 1;
  }

  let config: Awaited<ReturnType<typeof loadConfig>> | null = null;
  try {
    config = await loadConfig(configPath);
    configureLogger({ verbose: config.diagnostics.verbose });
  } catch (err: unknown) {
    process.stderr.write(
      `Warning: Recovery config not loaded (${err instanceof Error ? err.message : String(err)}). ` +
        "Running Claude without recovery.\n",
    );
  }

  const nodePty = await import("node-pty");

  // Forward arguments as an array — never as a shell string.
  // This preserves --dangerously-skip-permissions and all other flags exactly.
  const shell = isWindows() ? "cmd.exe" : claudePath;
  const args = isWindows()
    ? ["/c", claudePath, ...claudeArgs]
    : claudeArgs;

  const pty = nodePty.spawn(shell, args, {
    name: "xterm-256color",
    cols: process.stdout.columns ?? 120,
    rows: process.stdout.rows ?? 40,
    cwd: process.cwd(),
    env: process.env as Record<string, string>,
  });

  let sessionId: string | null = null;
  let lastOutputTime = Date.now();
  let hasUserInput = false;
  let recoveryInProgress = false;
  let sessionIdle = false;

  // Forward terminal output to the user
  pty.onData((data: string) => {
    process.stdout.write(data);
    lastOutputTime = Date.now();

    // Track session identity from lifecycle output
    const sessionMatch = data.match(/session[_\s]?(?:id)?[:\s]+([a-f0-9-]+)/i);
    if (sessionMatch) {
      sessionId = sessionMatch[1];
    }

    // Track session state
    sessionIdle = IDLE_PROMPT_PATTERN.test(data);
    if (sessionIdle) {
      hasUserInput = false;
    }

    // Check for eligible failure patterns (only when recovery is configured)
    if (config?.enabled && !recoveryInProgress) {
      for (const pattern of FAILURE_PATTERNS) {
        if (pattern.test(data)) {
          handleDetectedFailure(data, config, sessionId).catch(() => {});
          break;
        }
      }
    }
  });

  // Forward user input to Claude
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("data", (data: Buffer) => {
    pty.write(data.toString());
    hasUserInput = true;
  });

  // Forward terminal resize events
  process.stdout.on("resize", () => {
    pty.resize(
      process.stdout.columns ?? 120,
      process.stdout.rows ?? 40,
    );
  });

  // Wait for exit
  return new Promise<number>((resolve) => {
    pty.onExit(({ exitCode }) => {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      resolve(exitCode);
    });
  });

  async function handleDetectedFailure(
    terminalData: string,
    recoveryConfig: NonNullable<typeof config>,
    detectedSessionId: string | null,
  ): Promise<void> {
    if (recoveryInProgress) return;
    recoveryInProgress = true;

    try {
      logSync("Detected eligible failure — starting recovery");

      const syntheticInput: StopFailureInput = {
        session_id: detectedSessionId ?? "unknown",
        cwd: process.cwd(),
        hook_event_name: "StopFailure",
        error: terminalData.slice(0, 500),
        error_details: terminalData.slice(0, 1000),
      };

      const result = await startRecovery(syntheticInput, recoveryConfig);

      if (result.success) {
        logSync(`Recovery succeeded: ${result.region}`);

        // Continuation: only if configured, session is idle, and no user input
        if (
          recoveryConfig.claude.continuationMode === "auto" &&
          sessionIdle &&
          !hasUserInput &&
          !isBusy(terminalData)
        ) {
          logSync("Submitting continuation");
          // Send Enter to resume the failed request
          pty.write("\r");
        }
      } else {
        logSync(`Recovery did not succeed: ${result.reason}`);
      }
    } catch (err: unknown) {
      await log({
        event: "launcher-recovery-error",
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      recoveryInProgress = false;
    }
  }
}

function isBusy(recentOutput: string): boolean {
  return BUSY_INDICATORS.some((p) => p.test(recentOutput));
}
