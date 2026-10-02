#!/usr/bin/env node

/**
 * CLI entry point — manual recovery, hook handler, installer, and diagnostics.
 *
 * Invocation:
 *   node dist/cli.js recover [--region <region>] [--dry-run] [--config <path>]
 *   node dist/cli.js hook [--config <path>]
 *   node dist/cli.js install [--config <path>] [--claude-config-dir <dir>]
 *   node dist/cli.js uninstall [--claude-config-dir <dir>]
 *   node dist/cli.js status [--config <path>]
 *   node dist/cli.js doctor [--config <path>]
 */

import { Command } from "commander";
import { loadConfig } from "./config.js";
import { startManualRecovery } from "./coordinator.js";
import { handleStopFailure } from "./hook-handler.js";
import { installHook, uninstallHook } from "./installer.js";
import { configureLogger, log } from "./logger.js";
import {
  fileExists,
  getClaudeConfigDir,
  getClaudeSettingsPath,
  getDataDir,
  resolveClaude,
} from "./platform.js";
import { detectConflicts, readClaudeSettings } from "./settings.js";
import { BrowserAdapter } from "./browser.js";

const program = new Command()
  .name("claude-bedrock-recovery")
  .description("Automated AWS Bedrock region recovery for Claude Code")
  .version("0.1.0");

// ── recover ────────────────────────────────────────────────────────
program
  .command("recover")
  .description("Run region recovery manually")
  .option("--region <region>", "Target a specific region")
  .option("--dry-run", "Check inputs and propose candidates without changing anything")
  .option("--config <path>", "Path to configuration file")
  .action(async (opts: { region?: string; dryRun?: boolean; config?: string }) => {
    try {
      const config = await loadConfig(opts.config);
      configureLogger({ verbose: config.diagnostics.verbose });

      if (!config.enabled && !opts.dryRun) {
        process.stderr.write(
          'Configuration is disabled (enabled: false). Use --dry-run to check, or enable it first.\n',
        );
        process.exit(1);
      }

      const result = await startManualRecovery(config, {
        targetRegion: opts.region,
        dryRun: opts.dryRun === true,
      });

      if (opts.dryRun) {
        if (!result.success) {
          process.exit(1);
        }
      } else if (result.success) {
        process.stdout.write(
          `Recovery succeeded: region ${result.region}, model ${result.model}\n`,
        );
      } else {
        process.stderr.write(`Recovery did not succeed: ${result.reason}\n`);
        if (result.candidatesAttempted.length > 0) {
          process.stderr.write("Candidates attempted:\n");
          for (const c of result.candidatesAttempted) {
            process.stderr.write(`  ${c.region} — ${c.outcome}: ${c.reason}\n`);
          }
        }
        process.exit(1);
      }
    } catch (err: unknown) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

// ── hook ───────────────────────────────────────────────────────────
program
  .command("hook")
  .description("StopFailure hook handler (called by Claude, not by users)")
  .option("--config <path>", "Path to configuration file")
  .option("--claude-bedrock-recovery-managed", "Managed recovery hook marker")
  .action(async (opts: { config?: string }) => {
    await handleStopFailure(opts.config);
  });

// ── install ────────────────────────────────────────────────────────
program
  .command("install")
  .description("Install the StopFailure recovery hook into Claude settings")
  .option("--config <path>", "Path to recovery configuration file")
  .option("--claude-config-dir <dir>", "Claude configuration directory")
  .action(async (opts: { config?: string; claudeConfigDir?: string }) => {
    try {
      // The handler is this CLI file itself with the "hook" subcommand
      const handlerPath = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
      const result = await installHook(handlerPath, opts.config, opts.claudeConfigDir);
      process.stdout.write(`${result.reason}\n`);
    } catch (err: unknown) {
      process.stderr.write(
        `Install failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

// ── uninstall ──────────────────────────────────────────────────────
program
  .command("uninstall")
  .description("Remove the recovery hook from Claude settings")
  .option("--claude-config-dir <dir>", "Claude configuration directory")
  .action(async (opts: { claudeConfigDir?: string }) => {
    try {
      const result = await uninstallHook(opts.claudeConfigDir);
      process.stdout.write(`${result.reason}\n`);
    } catch (err: unknown) {
      process.stderr.write(
        `Uninstall failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

// ── status ─────────────────────────────────────────────────────────
program
  .command("status")
  .description("Show current configuration and recent recovery activity")
  .option("--config <path>", "Path to configuration file")
  .action(async (opts: { config?: string }) => {
    try {
      const config = await loadConfig(opts.config);
      const configDir = config.claude.configDirectory === "auto"
        ? getClaudeConfigDir()
        : config.claude.configDirectory;

      process.stdout.write("=== Claude Bedrock Recovery Status ===\n\n");
      process.stdout.write(`Enabled:    ${config.enabled}\n`);
      process.stdout.write(`Data dir:   ${getDataDir()}\n`);
      process.stdout.write(`Config dir: ${configDir}\n`);
      process.stdout.write(`Settings:   ${getClaudeSettingsPath(configDir)}\n`);
      process.stdout.write(`AWS:        ${config.awsIdentity.accountId} / ${config.awsIdentity.role}\n`);
      process.stdout.write(`Browser:    ${config.browser.channel}, profile "${config.browser.profileName}"\n`);
      process.stdout.write(`Trigger:    ${config.recovery.trigger}\n`);
      process.stdout.write(`Max passes: ${config.recovery.maxPasses}\n`);
      process.stdout.write(`\nRegions (${config.regions.length}):\n`);
      for (const r of config.regions) {
        process.stdout.write(`  ${r.region} — primary: ${r.models.primary}, haiku: ${r.models.haiku ?? "none"}\n`);
      }
    } catch (err: unknown) {
      process.stderr.write(
        `Error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  });

// ── doctor ─────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Validate configuration, browser, and Claude installation")
  .option("--config <path>", "Path to configuration file")
  .action(async (opts: { config?: string }) => {
    let ok = true;
    const check = (label: string, pass: boolean, detail: string) => {
      const icon = pass ? "[OK]" : "[!!]";
      process.stdout.write(`${icon} ${label}: ${detail}\n`);
      if (!pass) ok = false;
    };

    // 1. Configuration
    let config;
    try {
      config = await loadConfig(opts.config);
      check("Configuration", true, "loaded and valid");
    } catch (err: unknown) {
      check("Configuration", false, err instanceof Error ? err.message : String(err));
      process.exit(1);
      return; // unreachable but helps TS
    }

    // 2. Claude executable
    const claudePath = await resolveClaude();
    check("Claude executable", !!claudePath, claudePath ?? "not found on PATH");

    // 3. Claude settings
    const configDir = config.claude.configDirectory === "auto"
      ? getClaudeConfigDir()
      : config.claude.configDirectory;
    const settingsPath = getClaudeSettingsPath(configDir);
    const settingsExist = await fileExists(settingsPath);
    check("Claude settings", settingsExist, settingsPath);

    if (settingsExist) {
      try {
        const settings = await readClaudeSettings(configDir);
        const conflicts = detectConflicts(settings.content);
        if (conflicts.length > 0) {
          for (const c of conflicts) {
            check("Settings conflict", false, c);
          }
        } else {
          check("Settings conflicts", true, "none detected");
        }
      } catch (err: unknown) {
        check("Settings parse", false, err instanceof Error ? err.message : String(err));
      }
    }

    // 4. Browser connection
    process.stdout.write("\nChecking browser connection...\n");
    const browser = new BrowserAdapter(config.browser);
    try {
      await browser.connect();
      const health = await browser.healthCheck();
      check("Browser extension", health.ok, health.reason);

      if (health.ok) {
        const identity = await browser.verifyIdentity(config.awsIdentity);
        check("AWS identity", identity.verified, identity.reason);
      }

      await browser.disconnect();
    } catch (err: unknown) {
      check("Browser extension", false, err instanceof Error ? err.message : String(err));
    }

    // 5. Data directory
    const dataDir = getDataDir();
    check("Data directory", true, dataDir);

    // 6. Region configuration
    check(
      "Regions",
      config.regions.length > 0,
      `${config.regions.length} region(s) configured`,
    );
    for (const r of config.regions) {
      const hasPlaceholder = r.models.primary.includes("<") || r.models.primary.includes(">");
      check(
        `  ${r.region}`,
        !hasPlaceholder,
        hasPlaceholder ? "PLACEHOLDER — supply real model ID" : r.models.primary,
      );
    }

    process.stdout.write(`\n${ok ? "All checks passed." : "Some checks failed."}\n`);
    process.exit(ok ? 0 : 1);
  });

program.parse();
