# Claude Bedrock Recovery

Auto-rotate AWS Bedrock regions when Claude Code hits rate limits. No manual intervention — just keep coding.

## How it works

Claude hits a rate limit → this tool picks the next region → generates a new API key in your browser → updates Claude's settings → you keep working. The whole cycle takes ~15-30 seconds.

Works globally across all your terminals and projects. Install once, done.

## What you need before starting

- **Claude Code** already working with AWS Bedrock (you've run `/setup-bedrock` at least once and can use Claude with Bedrock)
- **Node.js 22+** (`node --version` to check)
- **Chrome or Edge** open and signed into the [AWS Bedrock console](https://console.aws.amazon.com/bedrock)
- **Multiple Bedrock regions enabled** in your AWS account (the more regions, the more headroom)

## Setup (5 minutes)

### Step 1: Install the Playwright MCP extension

This browser extension lets the tool automate key generation in your browser.

1. Open Chrome or Edge
2. Go to the [Playwright MCP extension](https://chromewebstore.google.com/detail/mmlmfjhmonkocbjadbfplnigmagldckm?utm_source=item-share-cb) in the Chrome Web Store
3. Click **Add to Chrome** (works for Edge too)
4. After installing, click the **puzzle piece icon** (extensions menu) in your browser toolbar
5. Click **Playwright MCP** — you'll see a popup with a **token string**
6. Copy that token — you'll paste it into the config in Step 3

> The token changes if you reinstall the extension. If recovery stops working later, check for a new token.

### Step 2: Build the tool

```sh
git clone https://github.com/ArminSHaf/bedrock-hopper.git
cd bedrock-hopper
npm install
npm run build
```

If `npm run build` fails, make sure you have Node.js 22+ and TypeScript is installed (`npx tsc --version`).

### Step 3: Create your config file

```sh
cp config.example.json config.json
```

Open `config.json` in any editor and fill in your details:

```jsonc
{
  "enabled": true,
  "browser": {
    "channel": "chrome",                // "chrome" on Mac/Linux, "msedge" on Windows
    "profileName": "Default",           // see below if you use multiple browser profiles
    "extensionToken": "paste-your-token-here"  // from Step 1
  },
  "awsIdentity": {
    "accountId": "*",                   // "*" skips account verification (fine for single-account setups)
    "role": "*"                         // "*" matches any role
  },
  "claude": {
    "configDirectory": "auto",
    "configurationMethod": "setup-bedrock-wizard",
    "continuationMode": "manual"        // "auto" to resume sessions after recovery
  },
  "regions": [
    { "region": "eu-central-1",   "models": { "primary": "global.anthropic.claude-opus-4-6-v1" } },
    { "region": "eu-west-1",      "models": { "primary": "global.anthropic.claude-opus-4-6-v1" } },
    { "region": "ap-northeast-1", "models": { "primary": "global.anthropic.claude-opus-4-6-v1" } },
    { "region": "ap-southeast-1", "models": { "primary": "global.anthropic.claude-opus-4-6-v1" } },
    { "region": "ca-central-1",   "models": { "primary": "global.anthropic.claude-opus-4-6-v1" } }
  ],
  "recovery": {
    "trigger": "stop-failure",
    "maxPasses": 1,
    "refreshExpiredKeyInCurrentRegionFirst": true,
    "recoverCapacityErrors": false,
    "automaticRestart": false
  },
  "diagnostics": {
    "verbose": false
  }
}
```

**`accountId`:**
- Set to `"*"` to skip account verification — recommended for single-account setups
- If you use multiple AWS accounts and want the tool to verify it's using the right one, replace `"*"` with your 12-digit account ID (found in the AWS console top-right dropdown)

**Browser profile name:**
- If you only have one Chrome/Edge profile, use `"Default"`
- If you use multiple profiles, check `chrome://version` in the browser — look for the "Profile Path" line, the last folder name is your profile (e.g., `Profile 1`)

**Which model ID to use:**
- `global.anthropic.claude-opus-4-6-v1` — Opus (most capable)
- `global.anthropic.claude-sonnet-5-5-v1` — Sonnet (faster, cheaper)
- The `global.` prefix works across all regions — no need to change model IDs when rotating

**Which regions to add:**
- Add every region where you have Bedrock access and Claude models enabled
- To check: open the [Bedrock console](https://console.aws.amazon.com/bedrock), switch regions in the top-right dropdown, and check if you see the API keys page
- More regions = more failover capacity. 4+ regions recommended
- Regions are tried in order — put your preferred/closest regions first

### Step 4: Install the hook

```sh
node dist/cli.js install --config config.json
```

This writes a `StopFailure` hook and sets `CLAUDE_CODE_MAX_RETRIES=1` in `~/.claude/settings.json`. The hook uses absolute paths to Node.js, this tool, and your config file — so it works from any terminal, any project, globally.

> **Important:** Don't move or delete the `config.json` or the cloned repo folder after installing. The hook points to these exact paths. If you move them, run `install` again.

### Step 5: Verify everything works

```sh
node dist/cli.js doctor --config config.json
```

This checks:
- Config file is valid
- Browser extension is reachable
- Settings file has the hook installed

Fix anything it flags. If it all passes, you're done.

**That's it.** Use Claude Code normally from any terminal. When you hit a rate limit, recovery happens automatically in the background.

## What gets recovered

| Error | What happens |
|---|---|
| 429 rate limit | Rotates to next region, generates new key |
| 400 model unavailable | Skips to next region |
| Expired key (400) | Refreshes key in current region first, then rotates |
| Everything else (403, 503, etc.) | Stops — you handle it manually |

Only 400 and 429 trigger browser automation. Other errors are not recoverable by region rotation.

## Fast recovery

The `install` command sets `CLAUDE_CODE_MAX_RETRIES=1` — Claude gets one retry for transient errors, then the `StopFailure` hook fires immediately. After a successful recovery, the tool writes the same value back. Recovery takes ~15 seconds instead of the default 2-5 minutes (10 retries).

If you want Claude to retry more aggressively on its own (e.g., for flaky networks), set it higher:

```json
{ "env": { "CLAUDE_CODE_MAX_RETRIES": "3" } }
```

## How it works under the hood

1. Claude Code hits a rate limit → one retry, then `StopFailure` hook fires
2. The tool classifies the error and picks the **next** region (round-robin through your list)
3. Opens a new tab in your browser → navigates to the Bedrock API keys page for that region
4. Clicks "Generate short-term API key" → extracts the key from the page
5. Writes the new region, model, key, and `CLAUDE_CODE_MAX_RETRIES=1` to `~/.claude/settings.json`
6. Closes its tab — your browser stays exactly as it was (on macOS, focus returns to your previous app)
7. 5-minute cooldown prevents cascading recoveries from multiple sessions

All Claude Code sessions share `~/.claude/settings.json`, so a recovery in one terminal fixes all of them.

## Multi-terminal behavior

When you have multiple Claude Code sessions open:
- **Session A** hits a rate limit → recovery runs → writes new settings (~15s)
- **Session B** (idle) picks up the new key on its next API call — no action needed
- **Session C** also hits a rate limit → hook fires, but sees settings already changed → skips recovery

A file lock prevents concurrent recoveries from racing, and a fingerprint check ensures the second session doesn't re-run what the first already fixed.

## Config file location

The `--config` flag accepts any path. If you want the tool to find the config automatically (without `--config`), place it at the platform default:

| OS | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\ClaudeBedrockRecovery\config.json` |
| macOS | `~/Library/Application Support/ClaudeBedrockRecovery/config.json` |
| Linux | `~/.config/ClaudeBedrockRecovery/config.json` |

## Other commands

```sh
node dist/cli.js recover --config config.json          # manual recovery — rotate now
node dist/cli.js recover --dry-run --config config.json # check setup without changing anything
node dist/cli.js status --config config.json            # show current config and regions
node dist/cli.js uninstall                              # remove the hook from settings
```

## Available Bedrock regions

Common regions that support Claude models. Your account may not have access to all of them.

| Region | Location |
|---|---|
| `eu-west-1` | Ireland |
| `eu-west-3` | Paris |
| `eu-central-1` | Frankfurt |
| `eu-north-1` | Stockholm |
| `ap-south-1` | Mumbai |
| `ap-south-2` | Hyderabad |
| `ap-southeast-1` | Singapore |
| `ap-southeast-2` | Sydney |
| `ap-northeast-1` | Tokyo |
| `ca-central-1` | Canada |
| `sa-east-1` | São Paulo |
| `af-south-1` | Cape Town |
| `us-east-1` | N. Virginia |
| `us-west-2` | Oregon |

## Troubleshooting

| Problem | Fix |
|---|---|
| `npm run build` fails | Make sure you have Node.js 22+ (`node --version`) |
| "Browser connection failed" | Chrome/Edge must be running with the Playwright MCP extension. Check the extension is enabled (not just installed) |
| "Identity verification failed" | Set `accountId` to `"*"` in config, or verify the browser is signed into the correct AWS account |
| Button click times out | Retries automatically (up to 3 times with JS fallback). If persistent, try loading the Bedrock API keys page manually first to warm it up |
| Recovery ran but Claude is still stuck | Claude picks up new settings on the next API call. Send a new message or wait for the current one to retry |
| Extension token invalid | Click the Playwright MCP extension icon again and copy the current token into your config |
| "Config file not found" | Pass `--config path/to/config.json` explicitly, or place it at the platform default path (see above) |
| Need more detail | Set `"verbose": true` in config, then check the logs |

**Logs:**
| OS | Path |
|---|---|
| Windows | `%LOCALAPPDATA%\ClaudeBedrockRecovery\logs` |
| macOS | `~/Library/Application Support/ClaudeBedrockRecovery/logs` |
| Linux | `~/.config/ClaudeBedrockRecovery/logs` |

## Limitations

- **Browser must be open:** The tool automates your real browser. Chrome/Edge must be running with the Playwright extension and signed into AWS.
- **Short-term keys expire:** Bedrock API keys last up to 12 hours (or until your AWS session expires). After expiry, the next rate limit will trigger a fresh key generation.
- **One recovery at a time:** A file lock prevents concurrent recoveries from racing. If two sessions hit limits simultaneously, the second waits for the first.
- **AWS console changes:** If AWS changes their Bedrock console UI, the browser automation may break until this tool is updated.
- **Multi-agent workflows:** If a subagent fails mid-work, recovery updates credentials for future requests, but the failed subagent won't automatically resume — the parent orchestrator will see it as a failure.

## Supported platforms

| OS | Browser | Status |
|---|---|---|
| macOS | Chrome (`chrome`) | Tested |
| macOS | Edge (`msedge`) | Should work |
| Windows | Edge (`msedge`) | Tested |
| Windows | Chrome (`chrome`) | Tested |
| Linux | Chrome (`chrome`) | Untested |

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the state machine, recovery rules, and concurrency model.
