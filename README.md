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
2. Go to the [Playwright MCP extension](https://chromewebstore.google.com/detail/playwright-mcp/hbikcehmkloieaopnkbfnpbjnlcjnaof) in the Chrome Web Store
3. Click **Add to Chrome** (works for Edge too)
4. After installing, click the **puzzle piece icon** (extensions menu) in your browser toolbar
5. Click **Playwright MCP** — you'll see a popup with a **token string**
6. Copy that token — you'll paste it into the config in Step 3

> The token changes if you reinstall the extension. If recovery stops working later, check for a new token.

### Step 2: Build the tool

```sh
git clone <repo-url>
cd claude-bedrock-recovery
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
    "accountId": "123456789012",        // see below for how to find this
    "role": "*"                         // "*" matches any role
  },
  "regions": [
    { "region": "eu-west-1",      "models": { "primary": "global.anthropic.claude-opus-4-6-v1" } },
    { "region": "eu-central-1",   "models": { "primary": "global.anthropic.claude-opus-4-6-v1" } },
    { "region": "ap-northeast-1", "models": { "primary": "global.anthropic.claude-opus-4-6-v1" } },
    { "region": "ap-southeast-1", "models": { "primary": "global.anthropic.claude-opus-4-6-v1" } }
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

**How to find your AWS account ID:**
- Sign into the [AWS console](https://console.aws.amazon.com)
- Click your name in the top-right corner
- Your 12-digit account ID is shown in the dropdown

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
- Regions are tried in the order listed — put your preferred/closest regions first

### Step 4: Install the hook

```sh
node dist/cli.js install --config config.json
```

This writes a `StopFailure` hook into `~/.claude/settings.json`. The hook uses absolute paths to Node.js, this tool, and your config file — so it works from any terminal, any project, globally.

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

## How it works under the hood

1. Claude Code hits a rate limit and fires its `StopFailure` hook
2. The hook runs this tool with the error details (piped as JSON on stdin)
3. The tool classifies the error and picks the next region from your config
4. Opens a new tab in your browser → navigates to the Bedrock API keys page for that region
5. Clicks "Generate short-term API key" → extracts the key from the page
6. Writes the new region, model, and key to `~/.claude/settings.json`
7. Closes its tab — your browser stays exactly as it was
8. Claude Code picks up the new settings on its next API call

All Claude Code sessions share `~/.claude/settings.json`, so a recovery in one terminal fixes all of them.

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
| "Identity verification failed" | The browser is signed into a different AWS account than your config. Check `accountId` matches |
| Button click times out | Retries automatically (up to 3 times with JS fallback). If persistent, try loading the Bedrock API keys page manually first to warm it up |
| Hook doesn't fire | The `StopFailure` hook only fires after Claude exhausts all its internal retries (~2-5 min of retrying). Brief rate limits that Claude handles on its own won't trigger recovery |
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

- **Hook timing:** The `StopFailure` hook fires only after Claude Code exhausts all its internal retries. If Claude retries successfully on its own, recovery never triggers. This is a Claude Code limitation, not a bug.
- **Browser must be open:** The tool automates your real browser. Chrome/Edge must be running with the Playwright extension and signed into AWS.
- **Short-term keys expire:** Bedrock API keys last up to 12 hours (or until your AWS session expires). After expiry, the next rate limit will trigger a fresh key generation.
- **One recovery at a time:** A file lock prevents concurrent recoveries from racing. If two sessions hit limits simultaneously, the second waits for the first.
- **AWS console changes:** If AWS changes their Bedrock console UI, the browser automation may break until this tool is updated.

## Supported platforms

| OS | Browser | Status |
|---|---|---|
| Windows | Edge (`msedge`) | Tested |
| Windows | Chrome (`chrome`) | Should work |
| macOS | Chrome (`chrome`) | Should work |
| macOS | Edge (`msedge`) | Should work |
| Linux | Chrome (`chrome`) | Untested |

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the state machine, recovery rules, and concurrency model.
