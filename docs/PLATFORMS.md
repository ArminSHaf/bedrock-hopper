# Windows and macOS operation

Status: installation design. Commands for the utility become available only after implementation and packaging.

## Shared behavior

Both platforms use the same Node.js application, region/model configuration, Playwright browser adapter, and recovery logic. The first dependency target is Node.js 22; supported package versions will be pinned during the prototype.

Use Chrome or Edge with the Playwright extension in the profile where AWS is signed in. Initial connection may require choosing and authorizing the intended browser tab/profile. Reusing authentication cannot extend an expired AWS session; the user signs in again when needed. [Playwright connection documentation](https://playwright.dev/mcp/configuration/browser-extension)

The existing shell command remains valid in hook mode:

```sh
claude --dangerously-skip-permissions
```

The planned optional wrapper command is identical on both platforms:

```sh
claude-auto --dangerously-skip-permissions
```

It preserves the current directory, arguments, terminal dimensions, input, output, and exit status. User flags are passed as an argument array, not rebuilt as a shell command string. Session startup, Ctrl+C, resize, Unicode, and redirected/non-interactive input require verification.

## Platform adapters

| Area | Windows | macOS |
| --- | --- | --- |
| User shell | PowerShell or CMD; VS Code integrated terminal | Usually zsh; Terminal, iTerm2, or VS Code |
| Working terminal | `node-pty` through ConPTY | `node-pty` through a Unix pseudoterminal |
| Command resolution | Resolve native Claude executable or supported `.cmd`/`.ps1` shim carefully | Resolve installed executable from PATH |
| Utility data directory | Proposed `%LOCALAPPDATA%\ClaudeBedrockRecovery` | Proposed `~/Library/Application Support/ClaudeBedrockRecovery` |
| Default Claude settings | `%USERPROFILE%\.claude\settings.json` | `~/.claude/settings.json` |
| Custom Claude directory | Honor `CLAUDE_CONFIG_DIR` | Honor `CLAUDE_CONFIG_DIR` |
| Private file access | Owner-restricted Windows ACL | Owner-only directory/file permissions |
| Installation target | Global npm command shims on PATH | Global npm executable on PATH |

`node-pty` supports both operating systems. Windows uses ConPTY and requires an appropriate Windows version. Native dependency compilation may require Python/MSVC tools on Windows and Xcode tools on macOS; the packaging prototype must determine whether users need those tools for the selected release. [Microsoft node-pty](https://github.com/microsoft/node-pty)

Windows is the first live validation target. macOS support remains a target until installation, browser reuse, wizard interaction, and recovery are exercised on a Mac. No claim of macOS certification is made from a Windows-only test.

## Planned installation

1. Install or locate Node.js/npm and Claude Code.
2. Install the packaged utility globally and confirm its command is on PATH.
3. Select the authenticated browser profile and expected AWS identity.
4. Supply the real ordered region/model configuration.
5. Complete the browser connection and helper setup once.
6. Merge the global recovery hook without removing existing hooks.
7. Run a two-region recovery check and record supported behavior.

The eventual package may support local development through `npm link`; there is currently no `package.json` or executable to install. Do not copy nonexistent installation commands into a shell.

## Global hook installation

The installer will merge a `StopFailure` entry into the actual Claude user settings. A project hook is unnecessary for shared use. Respect alternate Claude configuration directories and preserve all existing hook entries.

Invoke the recovery executable with structured command arguments where supported by the installed Claude version. Windows PATH shims, spaces in paths, and startup from a different project directory require checks. The handler must work with the project's current working directory without assuming the utility is stored there.

The setup helper is a PTY child process and does not need a separate visible PowerShell or Terminal window. Operating system focus and simulated desktop keyboard events are not part of the normal design.

## Removal

Remove only the utility's own hook entries and global command. Leave Claude conversations, permissions, model preferences, and AWS browser login intact. An optional restore operation should restore only provider fields recorded before an explicit change, with a comparison against later user edits.
