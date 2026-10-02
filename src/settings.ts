import { readFile } from "node:fs/promises";
import {
  atomicWriteFile,
  contentHash,
  getClaudeConfigDir,
  getClaudeSettingsPath,
} from "./platform.js";
import { log } from "./logger.js";
import type { ClaudeSettingsFile, RegionEntry, SettingsPatch } from "./types.js";

export async function readClaudeSettings(
  configDir?: string,
): Promise<ClaudeSettingsFile> {
  const dir = configDir ?? getClaudeConfigDir();
  const settingsPath = getClaudeSettingsPath(dir);
  let raw: string;
  try {
    raw = await readFile(settingsPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      raw = "{}";
    } else {
      throw err;
    }
  }

  let content: Record<string, unknown>;
  try {
    content = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid JSON in ${settingsPath}`);
  }

  return {
    path: settingsPath,
    content,
    contentHash: contentHash(raw),
    raw,
  };
}

/**
 * Build the env patch for a successful region/key recovery.
 *
 * Only the fields required by Claude Code's Bedrock integration are included.
 * The function does not invent model mappings — it uses the operator's
 * configured model IDs exactly as provided.
 */
export function buildRecoveryPatch(
  key: string,
  candidate: RegionEntry,
): SettingsPatch {
  const env: Record<string, string> = {
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_BEARER_TOKEN_BEDROCK: key,
    AWS_REGION: candidate.region,
    ANTHROPIC_MODEL: candidate.models.primary,
  };

  if (candidate.models.haiku) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = candidate.models.haiku;
  }

  return { env };
}

/**
 * Merge recovery env vars into the existing Claude settings.
 *
 * Preserves all unrelated settings and existing env vars that are not
 * part of the recovery patch.  The merge is shallow on the `env` object:
 * recovery keys overwrite, everything else is kept.
 */
export function mergeSettings(
  existing: Record<string, unknown>,
  patch: SettingsPatch,
): Record<string, unknown> {
  const merged = { ...existing };
  const existingEnv =
    typeof merged.env === "object" && merged.env !== null
      ? { ...(merged.env as Record<string, string>) }
      : {};

  merged.env = { ...existingEnv, ...patch.env };
  return merged;
}

/**
 * Detect conditions that block safe publication.
 *
 * Returns an array of problems; empty means publication is safe.
 */
export function detectConflicts(
  settings: Record<string, unknown>,
): string[] {
  const problems: string[] = [];
  const env =
    typeof settings.env === "object" && settings.env !== null
      ? (settings.env as Record<string, string>)
      : {};

  if (env.ANTHROPIC_BEDROCK_BASE_URL) {
    problems.push(
      "Custom Bedrock endpoint (ANTHROPIC_BEDROCK_BASE_URL) is set. " +
        "Recovery cannot verify that the custom endpoint works with the new region.",
    );
  }

  if (env.ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION) {
    problems.push(
      "Small-model region override (ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION) is set. " +
        "Verify that the small model remains accessible after region change.",
    );
  }

  if (env.CLAUDE_CODE_USE_MANTLE === "1") {
    problems.push(
      "Mantle endpoint is enabled. Recovery generates Bedrock API keys, " +
        "not Mantle credentials.",
    );
  }

  return problems;
}

/**
 * Publish validated recovery settings to the real Claude settings file.
 *
 * - Re-reads the file before writing to detect concurrent edits.
 * - If the content hash changed since we first read it, aborts to avoid
 *   overwriting user changes.
 * - Writes through a temp file + atomic rename.
 */
export async function publishSettings(
  patch: SettingsPatch,
  originalSnapshot: ClaudeSettingsFile,
): Promise<{ published: boolean; reason: string }> {
  // Re-read and compare to detect edits during recovery
  const current = await readClaudeSettings(
    originalSnapshot.path.replace(/[/\\]settings\.json$/, ""),
  );

  if (current.contentHash !== originalSnapshot.contentHash) {
    await log({
      event: "settings-publish-aborted",
      reason: "Settings file changed during recovery",
    });
    return {
      published: false,
      reason:
        "Settings file was modified during recovery. " +
        "Re-read and merge manually, or re-run recovery.",
    };
  }

  const conflicts = detectConflicts(current.content);
  if (conflicts.length > 0) {
    await log({
      event: "settings-publish-conflicts",
      conflicts,
    });
    return {
      published: false,
      reason: `Conflicts detected:\n${conflicts.join("\n")}`,
    };
  }

  const merged = mergeSettings(current.content, patch);
  const serialized = JSON.stringify(merged, null, 2) + "\n";

  // Validate that our output is parseable
  try {
    JSON.parse(serialized);
  } catch {
    return {
      published: false,
      reason: "Internal error: merged settings produced invalid JSON",
    };
  }

  await atomicWriteFile(originalSnapshot.path, serialized);

  await log({
    event: "settings-published",
    region: patch.env.AWS_REGION,
    model: patch.env.ANTHROPIC_MODEL,
  });

  return { published: true, reason: "Settings published successfully" };
}
