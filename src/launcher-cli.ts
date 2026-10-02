#!/usr/bin/env node

/**
 * `claude-auto` entry point — launches Claude Code with recovery support.
 *
 * Usage:
 *   claude-auto --dangerously-skip-permissions
 *   claude-auto --model opus
 *
 * All arguments after `claude-auto` are forwarded to Claude verbatim.
 * The wrapper preserves the current directory, terminal dimensions,
 * input, output, and exit status.
 */

import { launchClaude } from "./launcher.js";

const args = process.argv.slice(2);

// Separate our flags from Claude flags
let configPath: string | undefined;
const claudeArgs: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--recovery-config" && i + 1 < args.length) {
    configPath = args[++i];
  } else {
    claudeArgs.push(args[i]);
  }
}

launchClaude(claudeArgs, configPath).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`claude-auto: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
