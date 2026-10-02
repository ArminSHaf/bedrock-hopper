/**
 * Live browser test — real Playwright MCP against real AWS Bedrock console.
 *
 * This connects to your running Edge browser, opens a new tab,
 * navigates to the Bedrock API keys page, and attempts to generate a key.
 *
 * Run: node test/live-browser-test.mjs [region]
 * Default region: us-east-1
 */

import { pathToFileURL } from "node:url";
import { join } from "node:path";

const DIST = "E:/claude-bedrock-recovery/dist";
const { BrowserAdapter } = await import(
  pathToFileURL(join(DIST, "browser.js")).href
);

const region = process.argv[2] || "us-east-1";

console.log("============================================================");
console.log("  Live Playwright Browser Test");
console.log(`  Target region: ${region}`);
console.log("  Browser: Edge (Default profile)");
console.log("============================================================");
console.log();

const browser = new BrowserAdapter({
  connection: "playwright-extension",
  channel: "msedge",
  profileName: "Default",
  extensionToken: process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN || "FTaOI-HUYu_VBeWoUZeAoDM561Q2YYAqLsbZ-wZz-LM",
});

try {
  // ── Step 1: Connect ─────────────────────────────────────────────
  console.log("Step 1: Connecting to Edge...");
  await browser.connect();
  console.log("  Connected.\n");

  // ── Step 2: List existing tabs ──────────────────────────────────
  console.log("Step 2: Listing existing tabs...");
  const tabs = await browser.callTool("browser_tabs", { action: "list" });
  console.log(tabs);
  console.log();

  // ── Step 3: Open new tab to Bedrock API keys page ───────────────
  const url = `https://console.aws.amazon.com/bedrock/home?region=${region}#/api-keys`;
  console.log(`Step 3: Opening new tab -> ${url}`);
  await browser.openNewTab(url);
  console.log(`  Opened tab (index: ${browser.ownedTabIndex})`);
  console.log("  Waiting for page load...");
  await browser.waitTime(5);
  console.log();

  // ── Step 4: Take snapshot — see what Playwright sees ────────────
  console.log("Step 4: Taking accessibility snapshot...");
  let snap = await browser.snapshot();
  console.log("--- SNAPSHOT START ---");
  console.log(snap.slice(0, 3000));
  if (snap.length > 3000) console.log(`... (${snap.length} total chars)`);
  console.log("--- SNAPSHOT END ---");
  console.log();

  // ── Step 5: Check identity ──────────────────────────────────────
  console.log("Step 5: Checking AWS identity in page...");
  const hasSignIn = /sign.?in/i.test(snap);
  console.log(`  Sign-in page detected: ${hasSignIn}`);
  if (hasSignIn) {
    console.log("  ERROR: Not logged in. Sign in to AWS console first.");
    await browser.disconnect();
    process.exit(1);
  }

  // Look for account info
  const accountMatch = snap.match(/(\d{4}-?\d{4}-?\d{4})/);
  if (accountMatch) {
    console.log(`  AWS Account: ${accountMatch[1]}`);
  }
  console.log();

  // ── Step 6: Look for the Short-term API key tab ─────────────────
  console.log("Step 6: Looking for 'Short-term API key' tab or section...");

  // Search for relevant elements in snapshot
  const lines = snap.split("\n");
  const relevantLines = lines.filter(
    (l) =>
      /api.?key/i.test(l) ||
      /short.?term/i.test(l) ||
      /generate/i.test(l) ||
      /bearer/i.test(l) ||
      /\[ref=/i.test(l) && /key|generat|short|term|create/i.test(l)
  );
  console.log("  Relevant elements found:");
  for (const l of relevantLines) {
    console.log(`    ${l.trim()}`);
  }
  console.log();

  // Try clicking the Short-term tab if it exists
  const shortTermRef = findRef(snap, [
    "Short-term API key",
    "Short-term API keys",
    "Short-term",
  ]);

  if (shortTermRef) {
    console.log(`  Found short-term tab: ref=${shortTermRef.ref}, text="${shortTermRef.text}"`);
    console.log("  Clicking...");
    await browser.click(shortTermRef.ref, shortTermRef.text);
    await browser.waitTime(3);

    // Re-snapshot after tab click
    snap = await browser.snapshot();
    console.log("  Re-snapshot after tab click:");
    const newRelevant = snap.split("\n").filter(
      (l) => /generate/i.test(l) || /api.?key/i.test(l) || /short.?term/i.test(l)
    );
    for (const l of newRelevant) {
      console.log(`    ${l.trim()}`);
    }
    console.log();
  } else {
    console.log("  No 'Short-term' tab found — may already be on the right page.");
    console.log();
  }

  // ── Step 7: Find and click "Generate" button ────────────────────
  console.log("Step 7: Looking for Generate button...");
  const generateRef = findRef(snap, [
    "Generate short-term API key",
    "Generate short-term API keys",
    "Generate API key",
    "Generate",
  ]);

  if (generateRef) {
    console.log(`  Found: ref=${generateRef.ref}, text="${generateRef.text}"`);
    console.log("  Clicking Generate...");
    await browser.click(generateRef.ref, generateRef.text);
    await browser.waitTime(5);

    // ── Step 8: Extract the key ─────────────────────────────────
    console.log("\nStep 8: Extracting generated key...");
    snap = await browser.snapshot();

    console.log("--- POST-GENERATE SNAPSHOT START ---");
    console.log(snap.slice(0, 4000));
    if (snap.length > 4000) console.log(`... (${snap.length} total chars)`);
    console.log("--- POST-GENERATE SNAPSHOT END ---");
    console.log();

    // Try to find the key
    const key = extractKey(snap);
    if (key) {
      console.log(`  KEY FOUND! Length: ${key.length} chars`);
      console.log(`  Preview: ${key.slice(0, 10)}...${key.slice(-10)}`);
      console.log("\n  SUCCESS — Full browser automation flow works!");
    } else {
      console.log("  Could not extract key from snapshot.");
      console.log("  The page structure may need selector updates.");

      // Look for any long strings that might be keys
      const longStrings = snap.match(/[a-zA-Z0-9+/=_-]{30,}/g) || [];
      if (longStrings.length > 0) {
        console.log(`  Found ${longStrings.length} candidate long string(s):`);
        for (const s of longStrings.slice(0, 5)) {
          console.log(`    ${s.slice(0, 20)}... (${s.length} chars)`);
        }
      }
    }
  } else {
    console.log("  Generate button NOT found in snapshot.");
    console.log("  Full snapshot for debugging:");
    console.log(snap);
  }
} catch (err) {
  console.error(`\nERROR: ${err.message}`);
  if (err.stack) console.error(err.stack.split("\n").slice(1, 4).join("\n"));
} finally {
  console.log("\nCleaning up — closing our tab and disconnecting...");
  try {
    await browser.disconnect();
    console.log("  Done.");
  } catch {
    console.log("  Disconnect error (non-fatal).");
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function findRef(snap, patterns) {
  for (const pattern of patterns) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // With quotes
    const refMatch = snap.match(
      new RegExp(`"${escaped}"[^\\n]*\\[ref=([^\\]]+)\\]`, "i")
    );
    if (refMatch) return { ref: refMatch[1], text: pattern };
    // Without quotes
    const bareMatch = snap.match(
      new RegExp(`${escaped}[^\\n]*\\[ref=([^\\]]+)\\]`, "i")
    );
    if (bareMatch) return { ref: bareMatch[1], text: pattern };
  }
  return null;
}

function extractKey(snap) {
  // Strategy 1: key/token/bearer context
  const copyMatch = snap.match(
    /(?:copy|token|key|bearer)[^a-zA-Z0-9]*([a-zA-Z0-9+/=_-]{40,})/i
  );
  if (copyMatch) return copyMatch[1];

  // Strategy 2: very long token
  const tokenMatch = snap.match(/\b([a-zA-Z0-9+/=_-]{80,})\b/);
  if (tokenMatch) return tokenMatch[1];

  // Strategy 3: delimited
  const delimitedMatch = snap.match(/["']([a-zA-Z0-9+/=_-]{40,})["']/);
  if (delimitedMatch) return delimitedMatch[1];

  return null;
}
