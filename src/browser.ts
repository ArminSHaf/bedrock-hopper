/**
 * Browser adapter — AWS console automation via Playwright extension.
 *
 * Connects to the user's authenticated browser through the official
 * Playwright MCP extension.  The extension is installed in Chrome/Edge
 * and provides browser automation without requiring --remote-debugging-port.
 *
 * ASSUMPTION (UNTESTED): All AWS console selectors, page structure, and
 * navigation URLs are based on AWS documentation.  They require verification
 * against a live AWS console before enabling automated recovery.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { log } from "./logger.js";
import { redactKey } from "./platform.js";
import type { AwsIdentity, BrowserConfig, KeyGenResult } from "./types.js";

const BEDROCK_CONSOLE_BASE = "https://console.aws.amazon.com/bedrock";
const API_KEYS_HASH = "#/api-keys";

export class BrowserAdapter {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private ownedTabIndex: number | null = null;
  private previousTabIndex: number | null = null;

  constructor(private readonly config: BrowserConfig) {}

  async connect(): Promise<void> {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const mcpBin = join(thisDir, "..", "node_modules", "@playwright", "mcp", "cli.js");

    const args = [mcpBin, "--extension"];
    if (this.config.channel) {
      args.push(`--browser=${this.config.channel}`);
    }
    if (this.config.profileName) {
      args.push(`--profile-dir-name=${this.config.profileName}`);
    }

    const token = this.config.extensionToken ?? process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    if (token) {
      env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = token;
    }

    this.transport = new StdioClientTransport({
      command: process.execPath,
      args,
      env,
    });

    this.client = new Client(
      { name: "claude-bedrock-recovery", version: "0.1.0" },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    await log({ event: "browser-connected", channel: this.config.channel });
  }

  async disconnect(): Promise<void> {
    if (this.ownedTabIndex !== null) {
      try {
        // Switch back to the user's original tab before closing ours
        if (this.previousTabIndex !== null) {
          await this.callTool("browser_tabs", { action: "select", index: this.previousTabIndex });
        }
        await this.callTool("browser_tabs", { action: "close", index: this.ownedTabIndex });
      } catch {
        // best-effort tab cleanup
      }
      this.ownedTabIndex = null;
      this.previousTabIndex = null;
    }
    if (this.client) {
      try {
        await this.client.close();
      } catch {
        // best-effort
      }
      this.client = null;
    }
    if (this.transport) {
      try {
        await this.transport.close();
      } catch {
        // best-effort
      }
      this.transport = null;
    }
  }

  private requireClient(): Client {
    if (!this.client) {
      throw new Error("Browser not connected. Call connect() first.");
    }
    return this.client;
  }

  /**
   * Call an MCP tool and return the text result.  Throws on tool-level
   * errors so callers never silently proceed with a failure message.
   */
  private async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const client = this.requireClient();
    const result = await client.callTool({ name, arguments: args });

    if (result.isError) {
      const errText = (result.content as Array<{ type: string; text?: string }>)
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      throw new Error(`MCP tool "${name}" failed: ${errText}`);
    }

    return (result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
  }

  private async navigate(url: string): Promise<string> {
    return this.callTool("browser_navigate", { url });
  }

  private async snapshot(): Promise<string> {
    return this.callTool("browser_snapshot", {});
  }

  /**
   * Click an element.  `target` must be an exact snapshot reference
   * (e.g. "[ref=s3e12]") or a CSS/ARIA selector.  `element` is a
   * human-readable description for the MCP permission prompt.
   */
  private async click(target: string, element: string): Promise<string> {
    return this.callTool("browser_click", { target, element });
  }

  private async clickWithRetry(target: string, element: string, maxAttempts = 3): Promise<string> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (attempt > 1) {
          // Scroll the button into view before retrying
          await this.callTool("browser_evaluate", {
            function: `() => { document.querySelector('[data-analytics="GenerateShortApiKey"]')?.scrollIntoView({block:'center'}) }`,
          }).catch(() => {});
          await this.waitTime(2);
        }
        return await this.click(target, element);
      } catch (err: unknown) {
        await log({
          event: "click-retry",
          attempt,
          target,
          reason: err instanceof Error ? err.message : String(err),
        });
        if (attempt === maxAttempts) {
          // Final attempt: force click via JavaScript
          await log({ event: "click-force-js", target });
          await this.callTool("browser_evaluate", {
            function: `() => { const b = document.querySelector('[data-analytics="GenerateShortApiKey"]'); if (b) { b.scrollIntoView({block:'center'}); b.click(); return 'clicked'; } return 'not found'; }`,
          });
          await this.waitTime(3);
          return "js-click";
        }
        await this.waitTime(3);
        const snap = await this.snapshot();
        const fresh = findTargetRef(snap, [element]);
        if (fresh) {
          target = fresh.ref;
        }
      }
    }
    throw new Error("clickWithRetry: unreachable");
  }

  /**
   * Wait for a number of seconds (max 30 per the MCP schema).
   */
  private async waitTime(seconds: number): Promise<void> {
    await this.callTool("browser_wait_for", { time: Math.min(seconds, 30) });
  }

  /**
   * Wait for specific text to appear on the page.
   */
  private async waitForText(text: string): Promise<void> {
    await this.callTool("browser_wait_for", { text });
  }

  /**
   * Open a new browser tab and track it so we can close only our tab.
   */
  private async openNewTab(url: string): Promise<void> {
    // Record the currently active tab so we can switch back later
    const before = await this.callTool("browser_tabs", { action: "list" });
    const currentMatch = before.match(/^-\s*(\d+):\s*\(current\)/m);
    this.previousTabIndex = currentMatch ? parseInt(currentMatch[1], 10) : null;

    await this.callTool("browser_tabs", { action: "new", url });

    const after = await this.callTool("browser_tabs", { action: "list" });
    // Playwright MCP lists tabs as "- N: ..." lines
    const indices = [...after.matchAll(/^-\s*(\d+):/gm)].map(m => parseInt(m[1], 10));
    this.ownedTabIndex = indices.length > 0 ? indices[indices.length - 1] : null;
  }

  /**
   * Verify that the AWS console shows the expected account and role.
   *
   * ASSUMPTION: The account indicator in the AWS console header contains
   * the account ID.  This needs live verification.
   */
  async verifyIdentity(expected: AwsIdentity): Promise<{
    verified: boolean;
    reason: string;
  }> {
    const snap = await this.snapshot();

    if (/sign.?in/i.test(snap)) {
      return {
        verified: false,
        reason: "AWS session expired — sign in to the console and retry",
      };
    }

    if (!snap.includes(expected.accountId)) {
      return {
        verified: false,
        reason: `Expected AWS account ${expected.accountId} but it was not found in the console header`,
      };
    }

    if (expected.role && expected.role !== "*") {
      if (!snap.includes(expected.role)) {
        return {
          verified: false,
          reason: `Expected role "${expected.role}" but it was not found in the console identity`,
        };
      }
    }

    return { verified: true, reason: "Identity verified" };
  }

  /**
   * Generate a short-term API key in the specified region.
   *
   * ASSUMPTION (UNTESTED): The page structure, button text, and key
   * extraction logic are based on AWS documentation for the Bedrock
   * API keys page.  They require live verification before enabling
   * automated recovery.
   *
   * Flow:
   * 1. Open a new dedicated tab (never reuse or close user's tabs)
   * 2. Navigate to Bedrock console API keys page for the target region
   * 3. Verify identity matches expected account/role
   * 4. Click "Generate short-term API keys"
   * 5. Extract the generated key from the page
   * 6. Close only our tab on success or failure
   */
  async generateKey(
    region: string,
    expectedIdentity: AwsIdentity,
  ): Promise<KeyGenResult> {
    const url = `${BEDROCK_CONSOLE_BASE}/home?region=${region}${API_KEYS_HASH}`;

    await log({ event: "key-gen-start", region });

    // Open a dedicated tab — never navigate the user's existing tabs
    await this.openNewTab(url);
    await this.waitTime(5);

    // Verify identity before generating credentials
    const identityCheck = await this.verifyIdentity(expectedIdentity);
    if (!identityCheck.verified) {
      throw new Error(`Identity verification failed: ${identityCheck.reason}`);
    }

    // Wait for the page to fully settle (AWS console animations/lazy loading)
    await this.waitTime(3);

    // Take a snapshot and find clickable elements by their snapshot references
    let snap = await this.snapshot();

    // Look for the generate button using snapshot element references.
    // The snapshot returns elements with refs like [ref=s3e12].
    // We search for text near "Generate" and "short-term" in the snapshot.
    const generateTarget = findTargetRef(snap, [
      "Generate short-term API key",
      "Generate short-term API keys",
      "Generate API key",
    ]);

    if (!generateTarget) {
      // Try the Short-term API keys tab first
      const tabTarget = findTargetRef(snap, ["Short-term API key", "Short-term"]);
      if (tabTarget) {
        await this.click(tabTarget.ref, tabTarget.text);
        await this.waitTime(2);
        snap = await this.snapshot();
        const retryTarget = findTargetRef(snap, [
          "Generate short-term API key",
          "Generate short-term API keys",
          "Generate API key",
        ]);
        if (retryTarget) {
          await this.clickWithRetry(retryTarget.ref, retryTarget.text);
        } else {
          throw new Error(
            "Could not find the generate button after selecting the short-term tab. " +
              "The page structure may have changed.",
          );
        }
      } else {
        throw new Error(
          "Could not find the generate API key button on the Bedrock console. " +
            "The page structure may have changed.",
        );
      }
    } else {
      await this.clickWithRetry(generateTarget.ref, generateTarget.text);
    }

    // Wait for key to appear
    await this.waitTime(3);

    // Extract the generated key from a fresh snapshot
    snap = await this.snapshot();
    const key = extractKeyFromSnapshot(snap);

    if (!key) {
      throw new Error(
        "Key generation appeared to succeed but the key could not be extracted " +
          "from the page. The page structure may have changed.",
      );
    }

    await log({
      event: "key-gen-success",
      region,
      keyPreview: redactKey(key),
    });

    return {
      key,
      region,
      // Short-term keys expire at the shorter of 12 hours or session duration.
      // We cannot determine the session's remaining duration, so we report
      // the upper bound and note the uncertainty.
      expiresAt: null,
    };
  }

  /**
   * Check whether the browser extension is reachable and responding.
   *
   * This is a connection check only.  It does not establish that key
   * generation, identity verification, or any other operation will succeed.
   */
  async healthCheck(): Promise<{ ok: boolean; reason: string }> {
    try {
      await this.snapshot();
      return { ok: true, reason: "Browser extension is responding (connection check only)" };
    } catch (err: unknown) {
      return {
        ok: false,
        reason: `Browser connection failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
}

/**
 * Search a Playwright accessibility snapshot for an element matching
 * one of the given text patterns.  Returns the snapshot reference
 * and matched text, or null if not found.
 *
 * Snapshot elements appear as lines like:
 *   - button "Generate short-term API keys" [ref=s3e12]
 *   - link "Short-term" [ref=s3e8]
 *
 * ASSUMPTION: These patterns are based on Playwright MCP snapshot
 * format; they need verification against real snapshots.
 */
function findTargetRef(
  snap: string,
  patterns: string[],
): { ref: string; text: string } | null {
  for (const pattern of patterns) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Find ALL matches and return the last one — on the AWS console the
    // main action button appears after the "How it works" info section.
    const allQuoted = [...snap.matchAll(
      new RegExp(`"${escaped}"[^\\n]*\\[ref=([^\\]]+)\\]`, "gi"),
    )];
    if (allQuoted.length > 0) {
      return { ref: allQuoted[allQuoted.length - 1][1], text: pattern };
    }
    const allBare = [...snap.matchAll(
      new RegExp(`${escaped}[^\\n]*\\[ref=([^\\]]+)\\]`, "gi"),
    )];
    if (allBare.length > 0) {
      return { ref: allBare[allBare.length - 1][1], text: pattern };
    }
  }
  return null;
}

/**
 * Extract an API key from a page accessibility snapshot.
 *
 * Bedrock short-term API keys have the format:
 *   bedrock-api-key-<base64 presigned URL>
 * The full key including the prefix is ~2500 chars.
 */
function extractKeyFromSnapshot(snap: string): string | null {
  const contentStart = snap.indexOf("### Snapshot");
  const content = contentStart >= 0 ? snap.slice(contentStart) : snap;

  // Strategy 1: full key with bedrock-api-key- prefix
  const prefixedMatch = content.match(/(bedrock-api-key-[a-zA-Z0-9+/=]{100,})/);
  if (prefixedMatch) {
    return prefixedMatch[1];
  }

  // Strategy 2: base64 part only — prepend the required prefix
  const presignedMatch = content.match(/([a-zA-Z0-9+/=]{200,})/);
  if (presignedMatch) {
    return `bedrock-api-key-${presignedMatch[1]}`;
  }

  // Strategy 3: any long token with hyphens (fallback)
  const tokenMatch = content.match(/([a-zA-Z0-9+/=_-]{80,})/);
  if (tokenMatch) {
    const val = tokenMatch[1];
    if (!val.startsWith("bedrock-api-key-")) {
      return `bedrock-api-key-${val}`;
    }
    return val;
  }

  return null;
}
