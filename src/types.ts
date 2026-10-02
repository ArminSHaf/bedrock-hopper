export interface RecoveryConfig {
  schemaVersion: number;
  enabled: boolean;
  browser: BrowserConfig;
  awsIdentity: AwsIdentity;
  claude: ClaudeConfig;
  regions: RegionEntry[];
  recovery: RecoveryPolicy;
  diagnostics: DiagnosticsConfig;
}

export interface BrowserConfig {
  connection: "playwright-extension";
  channel: "chrome" | "msedge";
  profileName: string;
  extensionToken?: string;
}

export interface AwsIdentity {
  accountId: string;
  role: string;
}

export interface ClaudeConfig {
  configDirectory: "auto" | string;
  configurationMethod: "setup-bedrock-wizard";
  continuationMode: "manual" | "auto";
}

export interface RegionEntry {
  region: string;
  models: {
    primary: string;
    haiku: string | null;
  };
}

export interface RecoveryPolicy {
  trigger: "stop-failure";
  maxPasses: number;
  refreshExpiredKeyInCurrentRegionFirst: boolean;
  recoverCapacityErrors: boolean;
  automaticRestart: boolean;
}

export interface DiagnosticsConfig {
  verbose: boolean;
}

// StopFailure hook input — fields documented at
// https://code.claude.com/docs/en/hooks#stopfailure
export interface StopFailureInput {
  session_id: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd: string;
  scratchpad_dir?: string;
  hook_event_name: string;
  error: string;
  error_details?: string;
  last_assistant_message?: string;
}

export type RecoveryAction =
  | "region-recovery"
  | "refresh-current-key"
  | "stop-for-operator"
  | "allow-existing-retries"
  | "skip-candidate";

export interface ErrorClassification {
  action: RecoveryAction;
  reason: string;
  errorCategory: string;
}

export type RecoveryPhase =
  | "working"
  | "classify"
  | "wait-for-lock"
  | "select-region"
  | "obtain-key"
  | "validate"
  | "publish"
  | "needs-operator";

export interface RecoveryState {
  phase: RecoveryPhase;
  incidentId: string;
  sessionId: string;
  configDir: string;
  startedAt: number;
  currentCandidate: RegionEntry | null;
  excludedCandidates: Map<string, string>;
  settingsRevisionBefore: string;
  result: RecoveryResult | null;
}

export interface RecoveryResult {
  success: boolean;
  region: string | null;
  model: string | null;
  reason: string;
  durationMs: number;
  candidatesAttempted: CandidateOutcome[];
}

export interface CandidateOutcome {
  region: string;
  model: string;
  outcome: "success" | "key-generation-failed" | "wizard-failed" | "validation-failed" | "skipped";
  reason: string;
}

export interface KeyGenResult {
  key: string;
  region: string;
  expiresAt: Date | null;
}

export interface WizardResult {
  success: boolean;
  env: Record<string, string> | null;
  reason: string;
  redactedTranscript: string[];
}

export interface LockHandle {
  path: string;
  token: string;
  release: () => Promise<void>;
}

export interface ClaudeSettingsFile {
  path: string;
  content: Record<string, unknown>;
  contentHash: string;
  raw: string;
}

export interface SettingsPatch {
  env: Record<string, string>;
}

export interface HookEntry {
  matcher: string;
  hooks: HookHandler[];
}

export interface HookHandler {
  type: "command";
  command: string;
  args?: string[];
  timeout?: number;
  async?: boolean;
}
