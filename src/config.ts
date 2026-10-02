import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getDataDir } from "./platform.js";
import type { RecoveryConfig } from "./types.js";

const CONFIG_FILENAMES = ["config.local.json", "config.json"];

export async function loadConfig(explicitPath?: string): Promise<RecoveryConfig> {
  const configPath = explicitPath
    ? resolve(explicitPath)
    : await findConfig();

  if (!configPath) {
    throw new Error(
      `No configuration found. Place config.json in ${getDataDir()} or pass --config.`,
    );
  }

  const raw = await readFile(configPath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in ${configPath}`);
  }

  return validateConfig(parsed, configPath);
}

async function findConfig(): Promise<string | null> {
  const dataDir = getDataDir();
  for (const name of CONFIG_FILENAMES) {
    const candidate = join(dataDir, name);
    try {
      await readFile(candidate, "utf-8");
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function validateConfig(raw: unknown, path: string): RecoveryConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`Configuration in ${path} is not a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== 1) {
    throw new Error(`Unsupported schemaVersion ${String(obj.schemaVersion)} in ${path}`);
  }

  // browser
  const browser = requireObject(obj, "browser", path);
  requireString(browser, "connection", path);
  if (browser.connection !== "playwright-extension") {
    throw new Error(`Unsupported browser.connection "${String(browser.connection)}" in ${path}. Only "playwright-extension" is supported.`);
  }
  requireString(browser, "channel", path);
  if (browser.channel !== "chrome" && browser.channel !== "msedge") {
    throw new Error(`browser.channel must be "chrome" or "msedge" in ${path}`);
  }
  requireString(browser, "profileName", path);

  // awsIdentity
  const identity = requireObject(obj, "awsIdentity", path);
  requireString(identity, "accountId", path);
  requireString(identity, "role", path);

  // claude
  const claude = requireObject(obj, "claude", path);
  requireString(claude, "configDirectory", path);
  if (claude.configurationMethod !== "setup-bedrock-wizard") {
    throw new Error(`Only "setup-bedrock-wizard" configurationMethod is supported in ${path}`);
  }
  requireString(claude, "continuationMode", path);

  // regions
  if (!Array.isArray(obj.regions) || obj.regions.length === 0) {
    throw new Error(`At least one region is required in ${path}`);
  }
  for (let i = 0; i < obj.regions.length; i++) {
    const r = obj.regions[i] as Record<string, unknown>;
    if (!r || typeof r !== "object") {
      throw new Error(`regions[${i}] is not an object in ${path}`);
    }
    requireString(r, "region", path);
    const models = requireObject(r, "models", path);
    requireString(models, "primary", path);
    const primaryId = String(models.primary);
    if (primaryId.startsWith("<") || primaryId.endsWith(">")) {
      throw new Error(`regions[${i}].models.primary contains a placeholder in ${path}. Supply a real model ID.`);
    }
  }

  // recovery
  const recovery = requireObject(obj, "recovery", path);
  if (typeof recovery.maxPasses !== "number" || recovery.maxPasses < 1) {
    throw new Error(`recovery.maxPasses must be a positive integer in ${path}`);
  }

  // diagnostics — force-strip any secret-logging fields
  const diagnostics = (typeof obj.diagnostics === "object" && obj.diagnostics !== null)
    ? obj.diagnostics as Record<string, unknown>
    : {};

  return {
    schemaVersion: 1,
    enabled: obj.enabled === true,
    browser: {
      connection: "playwright-extension",
      channel: browser.channel as "chrome" | "msedge",
      profileName: String(browser.profileName),
      extensionToken: typeof browser.extensionToken === "string" ? browser.extensionToken : undefined,
    },
    awsIdentity: {
      accountId: String(identity.accountId),
      role: String(identity.role),
    },
    claude: {
      configDirectory: String(claude.configDirectory),
      configurationMethod: "setup-bedrock-wizard",
      continuationMode: claude.continuationMode === "auto" ? "auto" : "manual",
    },
    regions: (obj.regions as Record<string, unknown>[]).map((r) => ({
      region: String(r.region),
      models: {
        primary: String((r.models as Record<string, unknown>).primary),
        haiku: (r.models as Record<string, unknown>).haiku
          ? String((r.models as Record<string, unknown>).haiku)
          : null,
      },
    })),
    recovery: {
      trigger: "stop-failure",
      maxPasses: Number(recovery.maxPasses),
      refreshExpiredKeyInCurrentRegionFirst: recovery.refreshExpiredKeyInCurrentRegionFirst === true,
      recoverCapacityErrors: recovery.recoverCapacityErrors === true,
      automaticRestart: recovery.automaticRestart === true,
    },
    diagnostics: {
      verbose: diagnostics.verbose === true,
    },
  };
}

function requireObject(
  parent: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> {
  const val = parent[key];
  if (typeof val !== "object" || val === null) {
    throw new Error(`"${key}" must be an object in ${path}`);
  }
  return val as Record<string, unknown>;
}

function requireString(
  parent: Record<string, unknown>,
  key: string,
  path: string,
): void {
  if (typeof parent[key] !== "string" || (parent[key] as string).length === 0) {
    throw new Error(`"${key}" must be a non-empty string in ${path}`);
  }
}
