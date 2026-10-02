import { describe, it, expect } from "vitest";
import { buildRecoveryPatch, mergeSettings, detectConflicts } from "../src/settings.js";
import type { RegionEntry } from "../src/types.js";

describe("buildRecoveryPatch", () => {
  const candidate: RegionEntry = {
    region: "us-east-1",
    models: {
      primary: "us.anthropic.claude-opus-4-6",
      haiku: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    },
  };

  it("produces correct env vars including haiku when set", () => {
    const patch = buildRecoveryPatch("test-key-abc", candidate);
    expect(patch.env).toEqual({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_BEARER_TOKEN_BEDROCK: "test-key-abc",
      AWS_REGION: "us-east-1",
      ANTHROPIC_MODEL: "us.anthropic.claude-opus-4-6",
      ANTHROPIC_DEFAULT_HAIKU_MODEL: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
  });

  it("omits ANTHROPIC_DEFAULT_HAIKU_MODEL when haiku is null", () => {
    const noHaiku: RegionEntry = {
      region: "eu-west-1",
      models: { primary: "eu.anthropic.claude-opus-4-6", haiku: null },
    };
    const patch = buildRecoveryPatch("key-xyz", noHaiku);
    expect(patch.env).not.toHaveProperty("ANTHROPIC_DEFAULT_HAIKU_MODEL");
    expect(patch.env.ANTHROPIC_MODEL).toBe("eu.anthropic.claude-opus-4-6");
    expect(patch.env.AWS_REGION).toBe("eu-west-1");
  });
});

describe("mergeSettings", () => {
  it("preserves existing unrelated settings like permissions and hooks", () => {
    const existing = {
      permissions: { allow: ["Bash(npm test)"] },
      hooks: { PreToolUse: [{ matcher: "*", hooks: [] }] },
    };
    const patch = { env: { AWS_REGION: "us-east-1" } };
    const merged = mergeSettings(existing, patch);

    expect(merged.permissions).toEqual({ allow: ["Bash(npm test)"] });
    expect(merged.hooks).toEqual({ PreToolUse: [{ matcher: "*", hooks: [] }] });
  });

  it("preserves existing unrelated env vars", () => {
    const existing = {
      env: { MY_CUSTOM_VAR: "keep-me", DEBUG: "true" },
    };
    const patch = { env: { AWS_REGION: "us-east-1" } };
    const merged = mergeSettings(existing, patch);
    const env = merged.env as Record<string, string>;

    expect(env.MY_CUSTOM_VAR).toBe("keep-me");
    expect(env.DEBUG).toBe("true");
    expect(env.AWS_REGION).toBe("us-east-1");
  });

  it("overwrites recovery-related env vars", () => {
    const existing = {
      env: {
        AWS_REGION: "old-region",
        AWS_BEARER_TOKEN_BEDROCK: "old-key",
        ANTHROPIC_MODEL: "old-model",
        UNRELATED: "stays",
      },
    };
    const patch = {
      env: {
        AWS_REGION: "new-region",
        AWS_BEARER_TOKEN_BEDROCK: "new-key",
        ANTHROPIC_MODEL: "new-model",
      },
    };
    const merged = mergeSettings(existing, patch);
    const env = merged.env as Record<string, string>;

    expect(env.AWS_REGION).toBe("new-region");
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("new-key");
    expect(env.ANTHROPIC_MODEL).toBe("new-model");
    expect(env.UNRELATED).toBe("stays");
  });

  it("creates env block when none exists", () => {
    const existing = { permissions: { allow: [] } };
    const patch = { env: { AWS_REGION: "us-west-2" } };
    const merged = mergeSettings(existing, patch);

    expect(merged.env).toEqual({ AWS_REGION: "us-west-2" });
    expect(merged.permissions).toEqual({ allow: [] });
  });
});

describe("detectConflicts", () => {
  it("returns empty for clean settings", () => {
    const settings = {
      env: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_REGION: "us-east-1",
      },
    };
    expect(detectConflicts(settings)).toEqual([]);
  });

  it("detects ANTHROPIC_BEDROCK_BASE_URL", () => {
    const settings = {
      env: { ANTHROPIC_BEDROCK_BASE_URL: "https://custom.example.com" },
    };
    const conflicts = detectConflicts(settings);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]).toMatch(/ANTHROPIC_BEDROCK_BASE_URL/);
  });

  it("detects ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION", () => {
    const settings = {
      env: { ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: "us-west-2" },
    };
    const conflicts = detectConflicts(settings);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]).toMatch(/ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION/);
  });

  it("detects CLAUDE_CODE_USE_MANTLE", () => {
    const settings = {
      env: { CLAUDE_CODE_USE_MANTLE: "1" },
    };
    const conflicts = detectConflicts(settings);
    expect(conflicts.length).toBe(1);
    expect(conflicts[0]).toMatch(/Mantle/);
  });
});
