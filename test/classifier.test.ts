import { describe, it, expect } from "vitest";
import { classifyError } from "../src/classifier.js";
import type { RecoveryPolicy, StopFailureInput } from "../src/types.js";

const defaultPolicy: RecoveryPolicy = {
  trigger: "stop-failure",
  maxPasses: 1,
  refreshExpiredKeyInCurrentRegionFirst: true,
  recoverCapacityErrors: false,
  automaticRestart: false,
};

function makeInput(overrides: Partial<StopFailureInput>): StopFailureInput {
  return {
    session_id: "test-session",
    cwd: "/tmp",
    hook_event_name: "StopFailure",
    error: "",
    ...overrides,
  };
}

describe("classifyError", () => {
  it("classifies sustained rate limit (429) as region-recovery", () => {
    const input = makeInput({
      error:
        "API error: rate limit exceeded (429). Bedrock throttling limit reached for model us.anthropic.claude-opus-4-6 in region us-east-1",
      error_details: "HTTP 429 ThrottlingException: Too many requests",
    });
    const result = classifyError(input, defaultPolicy);
    expect(result.action).toBe("region-recovery");
    expect(result.errorCategory).toBe("rate-limit");
  });

  it("classifies expired key (HTTP 403) as stop-for-operator — browser recovery restricted to 400/429", () => {
    const input = makeInput({
      error:
        "API error: authentication failed. The security token included in the request is expired",
      error_details: "HTTP 403 ExpiredTokenException: credential expired",
    });
    const result = classifyError(input, defaultPolicy);
    expect(result.action).toBe("stop-for-operator");
    expect(result.errorCategory).toMatch(/expired/);
  });

  it("classifies model not found (HTTP 404) as stop-for-operator — browser recovery restricted to 400/429", () => {
    const input = makeInput({
      error:
        "API error: model not found. The model us.anthropic.claude-opus-4-6 is not available in region eu-west-1",
      error_details: "HTTP 404 ResourceNotFoundException",
    });
    const result = classifyError(input, defaultPolicy);
    expect(result.action).toBe("stop-for-operator");
    expect(result.errorCategory).toBe("region-model");
  });

  it("classifies billing/spend limit as stop-for-operator", () => {
    const input = makeInput({
      error: "API error: billing error. Your spend limit has been reached",
      error_details: "HTTP 429 spend limit exceeded",
    });
    const result = classifyError(input, defaultPolicy);
    expect(result.action).toBe("stop-for-operator");
    expect(result.errorCategory).toBe("billing");
  });

  it("classifies invalid request with region/model pattern as skip-candidate", () => {
    const input = makeInput({
      error:
        "API error: invalid request. on-demand throughput isn't supported for this model in this region",
      error_details: "HTTP 400 ValidationException",
    });
    const result = classifyError(input, defaultPolicy);
    expect(result.action).toBe("skip-candidate");
    expect(result.errorCategory).toMatch(/region/);
  });

  it("classifies invalid request unrelated to region as stop-for-operator", () => {
    const input = makeInput({
      error: "API error: invalid request. Malformed input document",
      error_details: "HTTP 400 ValidationException",
    });
    const result = classifyError(input, defaultPolicy);
    expect(result.action).toBe("stop-for-operator");
    expect(result.errorCategory).toBe("invalid-request");
  });

  it("classifies unknown error as stop-for-operator", () => {
    const input = makeInput({
      error: "API error: unexpected internal condition",
      error_details: "Something entirely novel happened",
    });
    const result = classifyError(input, defaultPolicy);
    expect(result.action).toBe("stop-for-operator");
    expect(result.errorCategory).toBe("unknown");
  });

  it("classifies capacity error as allow-existing-retries when recoverCapacityErrors is false", () => {
    const input = makeInput({
      error:
        "API error: server error. Service unavailable due to capacity constraints",
      error_details: "HTTP 503 ServiceUnavailableException",
    });
    const result = classifyError(input, { ...defaultPolicy, recoverCapacityErrors: false });
    expect(result.action).toBe("allow-existing-retries");
    expect(result.errorCategory).toBe("capacity");
  });

  it("classifies capacity error (HTTP 503) as stop-for-operator even when recoverCapacityErrors is true — browser recovery restricted to 400/429", () => {
    const input = makeInput({
      error:
        "API error: server error. Service unavailable due to capacity constraints",
      error_details: "HTTP 503 ServiceUnavailableException",
    });
    const result = classifyError(input, { ...defaultPolicy, recoverCapacityErrors: true });
    expect(result.action).toBe("stop-for-operator");
    expect(result.errorCategory).toBe("capacity");
  });

  it("classifies authentication failure (not expired) as stop-for-operator", () => {
    const input = makeInput({
      error: "API error: authentication failed. Access denied for this resource",
      error_details: "HTTP 403 AccessDeniedException",
    });
    const result = classifyError(input, defaultPolicy);
    expect(result.action).toBe("stop-for-operator");
    expect(result.errorCategory).toMatch(/identity|auth/);
  });
});
