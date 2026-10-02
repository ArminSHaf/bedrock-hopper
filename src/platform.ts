import { createHash } from "node:crypto";
import {
  chmod,
  constants,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { env } from "node:process";

const IS_WINDOWS = platform() === "win32";
const IS_MACOS = platform() === "darwin";

export function isWindows(): boolean {
  return IS_WINDOWS;
}

export function isMacOS(): boolean {
  return IS_MACOS;
}

export function getClaudeConfigDir(): string {
  if (env.CLAUDE_CONFIG_DIR) {
    return resolve(env.CLAUDE_CONFIG_DIR);
  }
  return join(homedir(), ".claude");
}

export function getClaudeSettingsPath(configDir?: string): string {
  return join(configDir ?? getClaudeConfigDir(), "settings.json");
}

export function getDataDir(): string {
  if (IS_WINDOWS) {
    const localAppData = env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "ClaudeBedrockRecovery");
  }
  if (IS_MACOS) {
    return join(
      homedir(),
      "Library",
      "Application Support",
      "ClaudeBedrockRecovery",
    );
  }
  // Linux fallback — not a supported target but avoids a crash
  return join(homedir(), ".claude-bedrock-recovery");
}

export function getLogDir(): string {
  return join(getDataDir(), "logs");
}

export function getLockDir(): string {
  return join(getDataDir(), "locks");
}

export function getLockPath(configDir: string, identity: string): string {
  const scope = createHash("sha256")
    .update(`${configDir}\0${identity}`)
    .digest("hex")
    .slice(0, 16);
  return join(getLockDir(), `recovery-${scope}.lock`);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  // Set owner-only permissions on non-Windows (macOS/Linux)
  if (!IS_WINDOWS) {
    await chmod(dir, 0o700).catch(() => {});
  }
}

/**
 * Write content to a file atomically: write to a temp file in the same
 * directory, then rename.  On the same filesystem `rename` is atomic on
 * both Windows (NTFS MoveFileEx MOVEFILE_REPLACE_EXISTING) and POSIX.
 */
export async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = dirname(filePath);
  await ensureDir(dir);
  const tmp = join(dir, `.tmp-${process.pid}-${Date.now()}`);
  try {
    await writeFile(tmp, content, "utf-8");
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

/**
 * Create a file exclusively (O_CREAT | O_EXCL).  Returns `true` when
 * the file was created, `false` when it already existed.
 */
export async function exclusiveCreate(
  filePath: string,
  content: string,
): Promise<boolean> {
  await ensureDir(dirname(filePath));
  try {
    const fd = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    try {
      await fd.writeFile(content, "utf-8");
    } finally {
      await fd.close();
    }
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw err;
  }
}

export function contentHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function fileContentHash(filePath: string): Promise<string | null> {
  try {
    const data = await readFile(filePath, "utf-8");
    return contentHash(data);
  } catch {
    return null;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a process with the given PID is alive.
 * Sends signal 0, which performs the existence check without
 * actually delivering a signal.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the `claude` executable.  On Windows the global npm install
 * creates a `.cmd` shim; `node-pty` and `child_process.spawn` need
 * different handling for `.cmd` files.
 */
export async function resolveClaude(): Promise<string | null> {
  const names = IS_WINDOWS
    ? ["claude.cmd", "claude.ps1", "claude.exe", "claude"]
    : ["claude"];

  const pathDirs = (env.PATH ?? "").split(IS_WINDOWS ? ";" : ":");
  for (const name of names) {
    for (const dir of pathDirs) {
      const candidate = join(dir, name);
      if (await fileExists(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

export function redactKey(value: string): string {
  if (value.length <= 8) return "****";
  return value.slice(0, 4) + "****" + value.slice(-4);
}

export function makeTempDir(prefix: string): string {
  return join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}`);
}
