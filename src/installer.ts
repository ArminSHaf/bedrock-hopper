/**
 * Hook installer / remover.
 *
 * Merges a StopFailure hook entry into the Claude user settings without
 * disturbing existing hooks.  Removal identifies entries by the exact
 * canonical handler executable path and removes only the specific handler
 * within its matcher group, preserving sibling handlers.
 */

import { resolve } from "node:path";
import { log } from "./logger.js";
import {
  atomicWriteFile,
  contentHash,
  getClaudeConfigDir,
  getClaudeSettingsPath,
} from "./platform.js";
import { readClaudeSettings } from "./settings.js";
import type { HookEntry, HookHandler } from "./types.js";

const HOOK_MATCHER =
  "rate_limit|overloaded|authentication_failed|cloud_credential_error|" +
  "model_not_found|server_error|invalid_request|billing_error|" +
  "account_on_hold|oauth_org_not_allowed|max_output_tokens|unknown";

/**
 * Canonical marker embedded in the handler args to identify our hook.
 * This is a fixed string that will not collide with user commands.
 */
const OWNERSHIP_MARKER = "--claude-bedrock-recovery-managed";

/**
 * Install the StopFailure hook into Claude user settings.
 *
 * The hook runs with `async: true` so it does not block Claude's
 * UI, and a 300-second timeout to allow the full browser + wizard
 * recovery cycle to complete.
 */
export async function installHook(
  handlerPath: string,
  configPath?: string,
  claudeConfigDir?: string,
): Promise<{ installed: boolean; reason: string }> {
  const configDir = claudeConfigDir ?? getClaudeConfigDir();
  const settingsFile = await readClaudeSettings(configDir);

  const resolvedHandler = resolve(handlerPath);

  const newHandler: HookHandler = {
    type: "command",
    command: process.execPath,
    args: [
      resolvedHandler,
      "hook",
      OWNERSHIP_MARKER,
      ...(configPath ? ["--config", resolve(configPath)] : []),
    ],
    timeout: 300,
    async: true,
  };

  const settings = { ...settingsFile.content };

  if (typeof settings.hooks !== "object" || settings.hooks === null) {
    settings.hooks = {};
  }
  const hooks = settings.hooks as Record<string, unknown>;

  if (!Array.isArray(hooks.StopFailure)) {
    hooks.StopFailure = [];
  }
  const stopFailure = hooks.StopFailure as HookEntry[];

  // Find an existing matcher group that contains our handler
  let installed = false;
  for (const entry of stopFailure) {
    if (!Array.isArray(entry.hooks)) continue;
    const ourIdx = entry.hooks.findIndex((h) => isOwnedHandler(h));
    if (ourIdx >= 0) {
      // Replace only our handler within this group, keep siblings
      entry.hooks[ourIdx] = newHandler;
      // Update matcher to ensure it covers all needed error types
      entry.matcher = HOOK_MATCHER;
      installed = true;
      break;
    }
  }

  if (!installed) {
    // Append a new matcher group with our handler — preserve all existing groups
    stopFailure.push({
      matcher: HOOK_MATCHER,
      hooks: [newHandler],
    });
  }

  // Set CLAUDE_CODE_MAX_RETRIES so StopFailure fires quickly
  if (typeof settings.env !== "object" || settings.env === null) {
    settings.env = {};
  }
  const env = settings.env as Record<string, string>;
  if (!env.CLAUDE_CODE_MAX_RETRIES) {
    env.CLAUDE_CODE_MAX_RETRIES = "1";
  }

  // Protect against concurrent settings edits
  const currentFile = await readClaudeSettings(configDir);
  if (currentFile.contentHash !== settingsFile.contentHash) {
    return {
      installed: false,
      reason: "Settings file was modified concurrently. Retry installation.",
    };
  }

  const serialized = JSON.stringify(settings, null, 2) + "\n";
  const settingsPath = getClaudeSettingsPath(configDir);
  await atomicWriteFile(settingsPath, serialized);

  await log({
    event: "hook-installed",
    settingsPath,
    handlerPath: resolvedHandler,
  });

  return {
    installed: true,
    reason: `StopFailure hook installed in ${settingsPath}`,
  };
}

/**
 * Remove the utility's StopFailure hook from Claude user settings.
 *
 * Removes only the specific handler identified by the ownership marker.
 * If the handler is the only one in its matcher group, the group is
 * removed.  All other hooks, settings, conversations, and permissions
 * are preserved.
 */
export async function uninstallHook(
  claudeConfigDir?: string,
): Promise<{ removed: boolean; reason: string }> {
  const configDir = claudeConfigDir ?? getClaudeConfigDir();
  const settingsFile = await readClaudeSettings(configDir);
  const settings = { ...settingsFile.content };

  if (typeof settings.hooks !== "object" || settings.hooks === null) {
    return { removed: false, reason: "No hooks section in settings" };
  }
  const hooks = settings.hooks as Record<string, unknown>;

  if (!Array.isArray(hooks.StopFailure)) {
    return { removed: false, reason: "No StopFailure hooks in settings" };
  }
  const stopFailure = hooks.StopFailure as HookEntry[];

  let removedCount = 0;
  for (const entry of stopFailure) {
    if (!Array.isArray(entry.hooks)) continue;
    const before = entry.hooks.length;
    entry.hooks = entry.hooks.filter((h) => !isOwnedHandler(h));
    removedCount += before - entry.hooks.length;
  }

  if (removedCount === 0) {
    return { removed: false, reason: "No recovery hook found to remove" };
  }

  // Remove empty matcher groups
  hooks.StopFailure = stopFailure.filter(
    (entry) => Array.isArray(entry.hooks) && entry.hooks.length > 0,
  );
  if ((hooks.StopFailure as HookEntry[]).length === 0) {
    delete hooks.StopFailure;
  }
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  }

  // Protect against concurrent settings edits
  const currentFile = await readClaudeSettings(configDir);
  if (currentFile.contentHash !== settingsFile.contentHash) {
    return {
      removed: false,
      reason: "Settings file was modified concurrently. Retry uninstallation.",
    };
  }

  const serialized = JSON.stringify(settings, null, 2) + "\n";
  const settingsPath = getClaudeSettingsPath(configDir);
  await atomicWriteFile(settingsPath, serialized);

  await log({
    event: "hook-uninstalled",
    settingsPath,
    removedCount,
  });

  return {
    removed: true,
    reason: `Removed ${removedCount} recovery handler(s) from ${settingsPath}`,
  };
}

/**
 * Identify whether a handler belongs to this utility.  Checks for the
 * exact ownership marker in the args array.  A generic "hook" argument
 * or substring match is NOT sufficient — only the canonical marker qualifies.
 */
function isOwnedHandler(handler: HookHandler): boolean {
  if (!Array.isArray(handler.args)) return false;
  return handler.args.includes(OWNERSHIP_MARKER);
}
