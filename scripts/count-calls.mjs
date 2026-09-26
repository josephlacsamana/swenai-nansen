#!/usr/bin/env node
/** Prints the key's credit balance and what each endpoint we use costs.
 *  Makes one 1-credit call. Exit code 1 when there is no key or the call fails. */
import { Nansen, loadApiKey, explainError } from "../src/nansen.mjs";

async function main() {
  const key = loadApiKey(new URL("../.env", import.meta.url));
  if (!key) {
    console.error("\nNANSEN_API_KEY not found.");
    console.error("  Set it in this terminal (see README, Try it), or: cp .env.example .env");
    console.error("  and paste your key after the =. Get a key at https://app.nansen.ai/api\n");
    return 1;
  }

  const n = new Nansen(key);
  // One cheap call just to read the credit headers.
  try {
    await n.cohortFlow("ethereum", "0x6982508145454ce325ddbe47a25d4ec3d2311933");
  } catch (err) {
    const e = explainError(err);
    console.error(`\n  NANSEN API ERROR: ${e.what}`);
    if (e.said) console.error(`    Nansen said: ${e.said}`);
    console.error(`    Likely cause: ${e.cause}.\n`);
    return 1;
  }

  console.log(`
  Credits remaining: ${n.creditsRemaining?.toLocaleString("en-US") ?? "unknown"}

  Per-call cost of the endpoints this repo uses:
    /tgm/flows                    1
    /tgm/flow-intelligence        1
    /tgm/dex-trades               1
    /token-screener               1
    /smart-money/perp-trades      5
    ------------------------------
    one "node demo.mjs" run       9 credits (5 calls: 4 x 1 + 1 x 5)

  Fused shut in src/nansen.mjs (never callable):
    /profiler/address/labels    100 (common) / 500 (premium)
`);
  return 0;
}

// exitCode rather than process.exit(): lets piped output finish writing.
process.exitCode = await main();
