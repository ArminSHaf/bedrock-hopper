import type { ErrorClassification, RecoveryPolicy, StopFailureInput } from "./types.js";

// Patterns in the error/error_details fields that indicate specific failure causes.
// These are assumptions based on AWS documentation; they require verification
// against actual Claude Code error messages from live Bedrock failures.
const BILLING_PATTERNS = [
  /spend.?limit/i,
  /billing/i,
  /budget/i,
  /payment/i,
];

const EXPIRED_KEY_PATTERNS = [
  /expired/i,
  /credential.*expired/i,
  /session.*expired/i,
];

const INVALID_TOKEN_PATTERNS = [
  /token.*invalid/i,
  /invalid.*token/i,
];

const REGION_MODEL_PATTERNS = [
  /not.*available.*region/i,
  /not.*supported.*region/i,
  /inference.*profile/i,
  /model.*not.*found/i,
  /not.*authorized.*model/i,
  /on-demand.*throughput.*isn't.*supported/i,
];

const IDENTITY_PATTERNS = [
  /wrong.*account/i,
  /access.*denied/i,
  /not.*authorized/i,
  /forbidden/i,
];

const CAPACITY_PATTERNS = [
  /capacity/i,
  /503/,
  /529/,
  /service.*unavailable/i,
];

/**
 * Classify a StopFailure into a recovery action.
 *
 * The `error` field is the primary error string from Claude's hook payload.
 * `error_details` may carry the HTTP status or provider-specific message.
 *
 * Classification combines the error string with pattern matching on details.
 * Unknown failures are never silently consumed — they surface to the operator.
 */
const BROWSER_RECOVERY_STATUS_CODES = new Set([400, 429]);

export function classifyError(
  input: StopFailureInput,
  policy: RecoveryPolicy,
): ErrorClassification {
  const details = input.error_details ?? "";
  const httpStatus = extractHttpStatus(details);
  const classification = classifyErrorInner(input, policy);
  return gateBrowserRecovery(classification, httpStatus);
}

function classifyErrorInner(
  input: StopFailureInput,
  policy: RecoveryPolicy,
): ErrorClassification {
  const error = input.error ?? "";
  const details = input.error_details ?? "";
  const rendered = input.last_assistant_message ?? "";
  const combined = `${error} ${details} ${rendered}`;

  // Billing / spend limit — always stop
  if (matchesAny(combined, BILLING_PATTERNS)) {
    return {
      action: "stop-for-operator",
      reason: "Billing or spend limit error requires operator action",
      errorCategory: "billing",
    };
  }

  // Identity / permission problems — stop
  if (matchesAny(combined, IDENTITY_PATTERNS) && !matchesAny(combined, EXPIRED_KEY_PATTERNS)) {
    return {
      action: "stop-for-operator",
      reason: "Permission or identity error requires operator action",
      errorCategory: "identity",
    };
  }

  // Expired key — refresh in current region first
  if (matchesAny(combined, EXPIRED_KEY_PATTERNS)) {
    return {
      action: "refresh-current-key",
      reason: "Credentials appear expired; refresh key in current region first",
      errorCategory: "expired-key",
    };
  }

  // Invalid token without expiration evidence — stop for operator
  if (matchesAny(combined, INVALID_TOKEN_PATTERNS)) {
    return {
      action: "stop-for-operator",
      reason: "Token invalid without expiration evidence; requires operator action",
      errorCategory: "invalid-token",
    };
  }

  // Region/model specific errors — skip this candidate
  if (matchesAny(combined, REGION_MODEL_PATTERNS)) {
    return {
      action: "skip-candidate",
      reason: "Region or model unavailable; try next configured candidate",
      errorCategory: "region-model",
    };
  }

  // Rate limiting (sustained / quota)
  if (/rate.?limit/i.test(combined) || /throttl/i.test(combined) || /429/.test(details)) {
    if (/brief/i.test(combined) || /retry.?after/i.test(combined)) {
      return {
        action: "allow-existing-retries",
        reason: "Brief rate limit; allow existing retries before rotating",
        errorCategory: "rate-limit-brief",
      };
    }
    return {
      action: "region-recovery",
      reason: "Sustained rate limit or quota exhaustion; try next region",
      errorCategory: "rate-limit",
    };
  }

  // Overloaded — treat as capacity, respect policy
  if (/overload/i.test(combined)) {
    if (policy.recoverCapacityErrors) {
      return {
        action: "region-recovery",
        reason: "Service overloaded; region recovery enabled by policy",
        errorCategory: "overloaded",
      };
    }
    return {
      action: "allow-existing-retries",
      reason: "Service overloaded; region recovery not enabled for capacity errors",
      errorCategory: "overloaded",
    };
  }

  // Capacity errors (503/529) — optional recovery
  if (matchesAny(combined, CAPACITY_PATTERNS)) {
    if (policy.recoverCapacityErrors) {
      return {
        action: "region-recovery",
        reason: "Capacity error; region recovery enabled by policy",
        errorCategory: "capacity",
      };
    }
    return {
      action: "allow-existing-retries",
      reason: "Capacity error; region recovery not enabled for capacity errors",
      errorCategory: "capacity",
    };
  }

  // Invalid request — check if region/model related
  if (/invalid.?request/i.test(combined) || /400/.test(details)) {
    if (matchesAny(combined, REGION_MODEL_PATTERNS)) {
      return {
        action: "skip-candidate",
        reason: "Invalid request related to region/model configuration",
        errorCategory: "invalid-request-regional",
      };
    }
    // HTTP 400 alone is insufficient for candidate rejection (per architecture doc).
    return {
      action: "stop-for-operator",
      reason: "Invalid request unrelated to region; preserving error for operator",
      errorCategory: "invalid-request",
    };
  }

  // Authentication failure — could be expired key or wrong identity
  if (/auth/i.test(combined)) {
    if (matchesAny(combined, EXPIRED_KEY_PATTERNS)) {
      return {
        action: "refresh-current-key",
        reason: "Authentication failure with expired credentials",
        errorCategory: "auth-expired",
      };
    }
    return {
      action: "stop-for-operator",
      reason: "Authentication failure requires operator action",
      errorCategory: "auth-failure",
    };
  }

  // Server error
  if (/server.?error/i.test(combined) || /500/.test(details)) {
    if (policy.recoverCapacityErrors) {
      return {
        action: "region-recovery",
        reason: "Server error; region recovery enabled by policy",
        errorCategory: "server-error",
      };
    }
    return {
      action: "allow-existing-retries",
      reason: "Server error; waiting for existing retries",
      errorCategory: "server-error",
    };
  }

  // Unknown — surface to operator, never silently consume
  return {
    action: "stop-for-operator",
    reason: `Unrecognized error — surfacing for operator. Error: ${error.slice(0, 200)}`,
    errorCategory: "unknown",
  };
}

export function gateBrowserRecovery(
  classification: ErrorClassification,
  httpStatus: number | null,
): ErrorClassification {
  const browserActions: Set<string> = new Set([
    "region-recovery",
    "refresh-current-key",
    "skip-candidate",
  ]);

  if (
    browserActions.has(classification.action) &&
    httpStatus !== null &&
    !BROWSER_RECOVERY_STATUS_CODES.has(httpStatus)
  ) {
    return {
      action: "stop-for-operator",
      reason: `${classification.reason} (HTTP ${httpStatus} — browser recovery restricted to 400/429)`,
      errorCategory: classification.errorCategory,
    };
  }

  return classification;
}

function extractHttpStatus(details: string): number | null {
  const match = details.match(/\bHTTP\s+(\d{3})\b/i);
  if (match) return parseInt(match[1], 10);
  const bareMatch = details.match(/\b([345]\d{2})\b/);
  if (bareMatch) return parseInt(bareMatch[1], 10);
  return null;
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}
