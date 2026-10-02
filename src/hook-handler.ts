/**
 * StopFailure hook handler — reads JSON from stdin, classifies the error,
 * and triggers recovery when applicable.
 *
 * This runs as the `command` target of a Claude StopFailure hook.  The hook
 * is configured with `async: true` and a 300-second timeout so recovery can
 * complete without blocking Claude and without being interrupted prematurely.
 *
 * StopFailure output is ignored except for `terminalSequence`, which can
 * deliver a desktop notification.  Recovery results are logged to the
 * event log, not returned through the hook output.
 */

import { loadConfig } from "./config.js";
import { startRecovery } from "./coordinator.js";
import { configureLogger, log } from "./logger.js";
import type { StopFailureInput } from "./types.js";

export async function handleStopFailure(configPath?: string): Promise<void> {
  let input: StopFailureInput;
  try {
    input = await readStdin();
  } catch (err: unknown) {
    await log({
      event: "hook-stdin-error",
      reason: err instanceof Error ? err.message : String(err),
    });
    emitNotification("Recovery hook: failed to read input");
    return;
  }

  let config;
  try {
    config = await loadConfig(configPath);
  } catch (err: unknown) {
    await log({
      event: "hook-config-error",
      sessionId: input.session_id,
      reason: err instanceof Error ? err.message : String(err),
    });
    emitNotification("Recovery hook: configuration error");
    return;
  }

  if (!config.enabled) {
    await log({
      event: "hook-disabled",
      sessionId: input.session_id,
    });
    return;
  }

  // Prevent the helper wizard process from triggering its own recovery
  if (process.env.CLAUDE_BEDROCK_RECOVERY_HELPER === "1") {
    return;
  }

  configureLogger({ verbose: config.diagnostics.verbose });

  await log({
    event: "hook-received",
    sessionId: input.session_id,
    error: input.error,
    errorDetails: input.error_details,
  });

  try {
    const result = await startRecovery(input, config);

    if (result.success) {
      emitNotification(
        `Bedrock recovery succeeded — ${result.region} / ${result.model}`,
      );
    } else {
      emitNotification(`Bedrock recovery: ${result.reason}`);
    }
  } catch (err: unknown) {
    await log({
      event: "hook-recovery-error",
      sessionId: input.session_id,
      reason: err instanceof Error ? err.message : String(err),
    });
    emitNotification("Recovery hook: unexpected error (see log)");
  }
}

async function readStdin(): Promise<StopFailureInput> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        const parsed = JSON.parse(raw) as StopFailureInput;
        if (!parsed.error && !parsed.session_id) {
          reject(new Error("Parsed JSON lacks expected StopFailure fields"));
          return;
        }
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    process.stdin.on("error", reject);

    // Safeguard: if stdin is not piped, don't hang forever
    if (process.stdin.isTTY) {
      reject(new Error("Stdin is a TTY — hook must receive piped JSON"));
    }
  });
}

/**
 * Emit a terminal notification sequence.  This is the only output
 * StopFailure acts on — it can trigger a desktop notification in
 * terminals that support OSC 777.
 */
function emitNotification(message: string): void {
  const safe = message.replace(/[\x00-\x1f\x7f]/g, "");
  const seq = `\x1b]777;notify;Claude Bedrock Recovery;${safe}\x07`;
  const output = JSON.stringify({ terminalSequence: seq });
  process.stdout.write(output);
}
