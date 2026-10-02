# Code review — 1 October 2026

## Result

The implementation compiles and all 30 existing tests pass, but live recovery is not ready. There are reproducible failures in the browser adapter, wizard startup, hook removal, log redaction, and dry-run result reporting. The current tests do not exercise the browser/wizard/coordinator/launcher or actual lock acquisition.

This review changed no implementation code and did not generate AWS keys, navigate the authenticated browser, install real hooks, or change real Claude settings. Synthetic checks used an isolated directory under `output/review-checks-VLxe15`.

Priority: **P1** should be fixed before live recovery or global installation; **P2** affects correctness and operational reliability.

## Findings

### 1. P1 — Browser tool calls do not match the installed MCP server

Location: [browser.ts](../src/browser.ts), lines 83–123.

The installed MCP server's actual `listTools` response requires `browser_click.arguments.target`. The adapter supplies `element` and `ref`, and sets `ref` to a human-readable label rather than a snapshot reference or unique selector. It also calls `browser_wait_for_timeout`, which is absent from this server; the available tool is `browser_wait_for` with `time` expressed in seconds.

`generateKey` reaches the invalid wait call immediately after navigation. A successful snapshot health check therefore does not establish that key generation can proceed. `callTool` also discards `result.isError`, letting tool failures look like normal text.

Fix: implement against the installed tool schemas, use real targets/selectors from observations, check MCP errors, and add adapter contract tests using the server's published schemas. Browser reachability is only a connection check.

### 2. P1 — The helper exits before opening the wizard

Location: [wizard.ts](../src/wizard.ts), lines 116–120.

Both platform paths pass `--no-color`. Running `claude --no-color` against the installed Claude Code 2.1.286 returns `error: unknown option '--no-color'` and exits with status 1. The adapter does not check startup failure promptly; it can instead wait through its prompt timeouts.

Fix: remove the unsupported flag, use a supported output option if needed, and fail immediately on helper exit. Add a startup smoke check that does not require an AWS call.

### 3. P1 — Wizard success is inferred from old text and can publish an unvalidated key

Location: [wizard.ts](../src/wizard.ts), lines 231–249 and 322–335; [coordinator.ts](../src/coordinator.ts), lines 297–306.

Every wait scans the complete historical terminal buffer. Success matches generic words including `ready` and `connected`. The success branch is evaluated before the failure branch, so earlier positive text can override a later validation failure. The wait result is not used to establish a final wizard state. A missing helper settings file still produces `success: true` with `env: null`, after which the coordinator publishes its own candidate patch.

The coordinator also copies every returned helper environment variable with `Object.assign`, without verifying key, region, models, or an allowed field list. A helper can consequently overwrite the intended candidate fields or unrelated environment settings.

Fix: use a prompt state machine over new terminal content, require an explicit final validation result and saved helper settings, verify the exact intended key/region/model values, and publish only allowed fields. Include transcripts with early positive text followed by failure, missing settings, and mismatched settings.

### 4. P1 — Installation and removal can delete unrelated hooks

Location: [installer.ts](../src/installer.ts), lines 71–77, 123–125, and 155–162.

`isOurHook` accepts any handler with an argument equal to `hook`, or with an argument containing the utility name. These are not ownership checks. A synthetic unrelated handler with `command: "unrelated-tool", args: ["hook"]` was removed by `uninstallHook`.

Even a correctly identified handler causes the entire matcher group to be replaced or removed, including other handlers in that group. Installation/removal also bypass the publisher's content-change detection.

Fix: identify the exact canonical utility executable/module and subcommand, modify only the owned handler, preserve its sibling handlers, and protect settings writes against concurrent edits. Test unrelated `hook` arguments and mixed groups.

### 5. P1 — Logging does not enforce the stated secret policy

Location: [logger.ts](../src/logger.ts), lines 36–47 and 66–90; [wizard.ts](../src/wizard.ts), lines 133–139 and 359–361.

Logger redaction checks field names, not string content. Secrets in `reason` or `errorDetails` remain unchanged. Arrays are not traversed, including `candidatesAttempted` entries. An isolated check confirmed that a synthetic secret was written verbatim to the JSONL log.

Wizard redaction operates on individual PTY chunks. A key split across two chunks is not matched, so the supposedly redacted transcript can contain it when reassembled. Generic raw error messages and MCP errors can also reach console output without the logger.

Fix: use structured diagnostics that exclude key-bearing tool output, recursively sanitize arrays/objects, and redact registered secrets across stream boundaries before any transcript/display/log sink. Test split chunks and keys inside error messages and arrays.

### 6. P1 — Automatic continuation cannot reliably continue the failed task

Location: [launcher.ts](../src/launcher.ts), lines 95–114 and 171–180.

The launcher sends only a carriage return. At an empty Claude prompt that does not submit a continuation request. The idle detector uses a shell-style `>`, `%`, `$`, or `#` regex on a raw output chunk and is not a Claude terminal state parser. Whenever it sees that pattern it clears `hasUserInput`, which can erase its knowledge of unsubmitted text. The busy check inspects the original error chunk rather than the current terminal state.

Normal assistant text quoting an API error can trigger recovery. Captured session IDs are inferred from arbitrary output and are not required before continuation. These assumptions are active when the user enables recovery/auto continuation, despite comments saying unverified detection should be disabled.

Fix: leave early detection and automatic continuation disabled until observed/versioned terminal behavior is supported. Use lifecycle identity and a current screen/state model, retain pending-input information, and submit an explicit continuation exactly once after a confirmed failed idle state.

### 7. P1 — Stale-lock reclamation can remove a new owner's live lock

Location: [lock.ts](../src/lock.ts), lines 72–101.

Exclusive creation protects first acquisition, but reclamation reads a dead owner's file and later unlinks its path without protecting that transition. Two waiters can both read the old dead PID: waiter A removes it and creates its own live lock; waiter B then removes A's replacement and creates another. Both can believe they own recovery.

`isProcessAlive` also treats all exceptions as proof of death, including permission failures. A corrupt/incompletely written lock cannot be recovered at all by the current loop.

Fix: serialize stale-owner reclamation as well as initial acquisition, distinguish confirmed nonexistence from an uncertain process check, and cover simultaneous reclamation/crash scenarios with real multi-process tests.

### 8. P2 — Concurrent incidents are serialized but are not deduplicated

Location: [coordinator.ts](../src/coordinator.ts), lines 71–103; [lock.ts](../src/lock.ts), lines 19–20.

The claimed settings-revision recheck never compares against a pre-lock revision or an incident's failed configuration. `settingsBefore` is first read after acquisition. A second waiter can therefore repeat key generation after the first operation has succeeded. If the first takes over 30 seconds, the second times out instead of joining and receiving its result.

Fix: record the failed revision/incident, compare after acquisition, and share the completed result among waiters. Verify both hook and launcher triggering for the same failure.

### 9. P2 — Candidate traversal ignores the documented failure policy

Location: [coordinator.ts](../src/coordinator.ts), lines 247–295; [classifier.ts](../src/classifier.ts), overloaded branch.

Every unsuccessful wizard result excludes the candidate and continues. Missing prompts, helper startup errors, missing files, and unrelated validation errors therefore cause a sweep through regions even though they require fixing the tool/request. Key-generation errors also usually trigger another region attempt. The detailed provider error is lost in the generic wizard failure reason.

The `overloaded` classifier branch always requests region recovery, even when `recoverCapacityErrors` is false. This was confirmed with the supplied fixture policy.

Fix: return typed adapter failures and classify them before deciding whether to rotate, refresh, or stop. Honor the capacity policy for overloaded errors too.

### 10. P2 — Dry-run reports success when the browser is disconnected

Location: [coordinator.ts](../src/coordinator.ts), lines 414–447; [cli.ts](../src/cli.ts), lines 60–75.

Browser failures and settings conflicts are printed but `dryRunCheck` unconditionally returns `success: true`. The CLI does not use the failure status for dry-run exit codes. A controlled disconnected-browser check still returned success. An unknown requested region can also produce a successful zero-candidate result.

Fix: return explicit check results, fail required checks, and use a nonzero CLI exit code. Keep dry-run non-mutating.

### 11. P1 — Credential files are created with ordinary default permissions

Location: [platform.ts](../src/platform.ts), lines 71–88; [wizard.ts](../src/wizard.ts), lines 58–59.

Helper directories and temporary settings files have no explicit private permissions. On macOS with a common umask of 022, directory/file defaults allow other local users to traverse/read them. Atomic replacement also replaces the existing settings file's permissions with the temporary file's defaults. Windows owner-restricted ACLs described in the platform document are not implemented.

Fix: create helper directories with owner-only access, create key-bearing files privately, preserve or deliberately set the destination permissions/ACL, and verify this on each platform. This is a source-level finding; no macOS runtime test was performed.

## Additional gaps to address during adapter calibration

- `generateKey` navigates the current browser tab; it never creates or tracks the dedicated tab described in the plan.
- Browser `channel` is used in logging but not passed to the MCP connection; verify the selected browser/profile explicitly.
- Snapshot-wide account/role substring checks do not verify a specific AWS identity control.
- Key extraction accepts arbitrary long strings from the page. Read the actual generated-key field instead.
- `expiresAt` is always guessed as generation plus 12 hours even though the session may expire sooner; report unknown or an explicit upper bound unless actual expiry is available.
- File URL `.pathname` conversion does not decode escaped spaces/non-ASCII characters; use `fileURLToPath` for module paths, especially on macOS installs in paths containing spaces.
- Publication checks only user settings, not higher-precedence project/managed settings or the effective environment. Conflict detection also happens after key generation/validation rather than before.
- The helper has no single overall operation deadline or coordinated cancellation for browser, PTY, lock release, and temporary-file cleanup when the hook times out.
- Hash comparison reduces overwrites but does not make compare-and-replace atomic against an external settings writer; installation/removal are not even using that check.

## Verification performed

- `npm run build`: passed.
- `npm test`: passed, 30 tests in four files.
- `claude --no-color`: confirmed unsupported flag; exited 1 before startup.
- Installed MCP `listTools`: inspected actual click, wait, and tab schemas without browsing AWS.
- Mock browser calls: confirmed malformed click parameters, nonexistent wait tool, and ignored `isError`.
- Isolated settings: confirmed removal of an unrelated hook.
- Isolated synthetic logs: confirmed unredacted secret content.
- Mock disconnected browser: confirmed dry-run success despite failed reachability.
- Classifier fixture: confirmed overloaded recovery ignores the disabled capacity policy.

The four tests in `test/lock.test.ts` cover hashing and process-existence checks; they do not call `acquireLock` or `release`. Browser, wizard, coordinator, installer, logger, launcher, and live publication have no coverage in the current 30-test suite.

## Recommended repair order

1. Fix MCP contracts and helper startup so the manual path can reach the real interfaces.
2. Fix wizard validation/publication, hook ownership, secret handling, and file privacy.
3. Fix recovery classification, locking/deduplication, and truthful diagnostic exit codes.
4. Observe one controlled manual two-region flow with real configuration, including a failed candidate that does not publish settings.
5. Only then implement/enable verified early detection and continuation; validate macOS on a Mac.
