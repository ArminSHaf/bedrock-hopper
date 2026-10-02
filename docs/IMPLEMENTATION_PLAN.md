# Implementation stages and acceptance checks

Status: proposed work. This document describes future tests; none of these recovery checks has been executed yet.

## Stage 1: confirm the two-region workflow

Obtain the browser/profile, expected AWS identity, exact model IDs, and two eligible regions. Pin the dependencies and Claude version used for the prototype.

Implement the authenticated browser connection and key-generation operation first. Then exercise the helper wizard in isolation. Validate that failed candidates cannot publish settings, and that success identifies the intended account, region, and model.

Deliver a manual recovery command with redacted diagnostics and an explicit dry-run mode. Dry-run checks inputs and proposes candidates; it must not generate keys, invoke models, or change settings.

## Stage 2: global hook and coordinated recovery

Add the `StopFailure` stdin adapter, error classification, per-configuration lock, bounded candidate traversal, and settings merge. Keep the user's existing `claude --dangerously-skip-permissions` startup command.

The initial hook mode automates validated credential rotation. Its notification explains whether the operator must retry; it does not promise automatic continuation.

## Stage 3: prove live settings behavior

Measure what happens when a second working session observes a settings change. Verify a new request separately from a retry already in progress. Use an identifiable regional endpoint and redact authentication in any instrumentation.

If existing retries pick up the new configuration, retain that behavior without refreshing terminals. If they do not, document exactly when the change takes effect and add a managed fallback. Browser/wizard recovery timing is measured here; the earlier estimate of tens of seconds is not a performance guarantee.

## Stage 4: optional terminal launcher

Implement `claude-auto` using `node-pty`. Forward Claude arguments, permission mode, working directory, input/output, resize events, and exit status. Capture exact session identity through lifecycle data.

Observe eligible retry messages and coordinate early recovery without treating text in a normal model response as an API failure. Use versioned prompt/output recognition and disable unsupported early detection rather than guessing.

Allow one continuation per validated incident, only in an idle failed session with no queued user input. Keep hook-only mode available for sessions started with ordinary `claude`. Unmanaged sessions will not be forcefully attached or restarted.

## Stage 5: packaging and macOS validation

Create the global package commands, hook installer/remover, and platform diagnostics. Verify Windows first, then run the same acceptance scenarios on macOS. Record supported Node, Claude, browser, architecture, and operating system versions.

## Acceptance scenarios

| Scenario | Required result |
| --- | --- |
| Working request with no error | Same user workflow, no recovery or unnecessary browser activity |
| Regional 429 | One bounded recovery; brief throttling can resolve through existing retries |
| Unavailable model in a candidate region | Skip that combination and try the next configured candidate |
| 400 unrelated to region | Preserve the actual failure; stop region cycling |
| Inference profile required | Apply configured regional profile or report missing configuration |
| Expired key | Refresh current-region key first |
| Wrong AWS account/role | Stop before generating/publishing credentials |
| Expired AWS browser login | Request sign-in; no false recovery success |
| Unexpected wizard prompt or timeout | Stop and retain previous working settings |
| Two terminals fail together | One rotation, both receive the same resulting settings revision |
| Settings edited during recovery | Preserve edits and merge or stop safely |
| Candidate list exhausted | Stop after one traversal and report failed combinations |
| New request after publication | Uses intended key, region, and configured model |
| Retry in progress during publication | Measured behavior; no assumption based on environment reload alone |
| Managed stopped session | One continuation with exact conversation identity |
| Busy terminal or unsubmitted input | No injected continuation |
| Restart fallback | Previous writer stopped; exact session resumed; runtime limits reported |
| Secrets in terminal/browser data | Redacted from displays and diagnostic artifacts |
| Removal | Only utility hooks/commands removed; user settings and conversations preserved |

Use fixtures and synthetic terminal transcripts for deterministic error, prompt, and lock checks. Run only the necessary controlled AWS calls for live proof; do not manufacture load to reach a real quota. Live model probes can incur normal Bedrock charges.

## Current evidence

- Documentation and an inactive configuration example created.
- Windows executable checks: Node.js 22.20.0 and Claude Code 2.1.286.
- No dependency installation, browser connection, key generation, settings change, or recovery execution performed.
- macOS validation outstanding.
