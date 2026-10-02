import { describe, it, expect } from "vitest";
import { contentHash, isProcessAlive } from "../src/platform.js";

describe("contentHash", () => {
  it("produces the same hash for the same input", () => {
    const a = contentHash("hello world");
    const b = contentHash("hello world");
    expect(a).toBe(b);
  });

  it("produces different hashes for different input", () => {
    const a = contentHash("hello world");
    const b = contentHash("hello world!");
    expect(a).not.toBe(b);
  });
});

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("returns false for a nonexistent PID", () => {
    expect(isProcessAlive(99999999)).toBe(false);
  });
});
