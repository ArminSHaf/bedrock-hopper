import { describe, it, expect, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, "fixtures");
const validConfigPath = join(fixtureDir, "config-valid.json");

const tempFiles: string[] = [];

function writeTempConfig(name: string, content: string): string {
  const dir = join(tmpdir(), "cbr-test");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${name}-${Date.now()}.json`);
  writeFileSync(p, content, "utf-8");
  tempFiles.push(p);
  return p;
}

afterEach(() => {
  for (const p of tempFiles) {
    try {
      unlinkSync(p);
    } catch {
      // ignore
    }
  }
  tempFiles.length = 0;
});

describe("loadConfig", () => {
  it("loads a valid config from the fixture path", async () => {
    const config = await loadConfig(validConfigPath);
    expect(config).toBeDefined();
    expect(config.schemaVersion).toBe(1);
  });

  it("parses correct fields from valid config", async () => {
    const config = await loadConfig(validConfigPath);
    expect(config.enabled).toBe(true);
    expect(config.regions).toHaveLength(2);
    expect(config.awsIdentity.accountId).toBe("123456789012");
    expect(config.awsIdentity.role).toBe("TestRole");
    expect(config.regions[0].region).toBe("us-east-1");
    expect(config.regions[0].models.primary).toBe("us.anthropic.claude-opus-4-6");
  });

  it("rejects a nonexistent file", async () => {
    await expect(loadConfig("/no/such/file.json")).rejects.toThrow();
  });

  it("rejects invalid JSON", async () => {
    const p = writeTempConfig("bad-json", "{broken");
    await expect(loadConfig(p)).rejects.toThrow(/Invalid JSON/);
  });

  it("rejects config with placeholder model IDs", async () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      browser: { connection: "playwright-extension", channel: "chrome", profileName: "Default" },
      awsIdentity: { accountId: "111", role: "R" },
      claude: { configDirectory: "auto", configurationMethod: "setup-bedrock-wizard", continuationMode: "manual" },
      regions: [{ region: "us-east-1", models: { primary: "<PLACEHOLDER>", haiku: null } }],
      recovery: { trigger: "stop-failure", maxPasses: 1, refreshExpiredKeyInCurrentRegionFirst: true, recoverCapacityErrors: false, automaticRestart: false },
      diagnostics: { verbose: false },
    });
    const p = writeTempConfig("placeholder", raw);
    await expect(loadConfig(p)).rejects.toThrow(/placeholder/i);
  });

  it("rejects config with zero regions", async () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      browser: { connection: "playwright-extension", channel: "chrome", profileName: "Default" },
      awsIdentity: { accountId: "111", role: "R" },
      claude: { configDirectory: "auto", configurationMethod: "setup-bedrock-wizard", continuationMode: "manual" },
      regions: [],
      recovery: { trigger: "stop-failure", maxPasses: 1, refreshExpiredKeyInCurrentRegionFirst: true, recoverCapacityErrors: false, automaticRestart: false },
      diagnostics: { verbose: false },
    });
    const p = writeTempConfig("no-regions", raw);
    await expect(loadConfig(p)).rejects.toThrow(/region/i);
  });
});
