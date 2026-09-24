#!/usr/bin/env node
/** Prints the key's credit balance and what each endpoint we use costs. */
import { readFileSync } from "node:fs";
import { Nansen } from "../src/nansen.mjs";

const key = process.env.NANSEN_API_KEY?.trim()
  ?? readFileSync(new URL("../.env", import.meta.url), "utf8").match(/^NANSEN_API_KEY\s*=\s*(.+)$/m)?.[1]?.trim();
if (!key) { console.error("NANSEN_API_KEY not set (cp .env.example .env)"); process.exit(1); }

const n = new Nansen(key);
// One cheap call just to read the credit headers.
await n.cohortFlow("ethereum", "0x6982508145454ce325ddbe47a25d4ec3d2311933").catch(() => null);

console.log(`
  Credits remaining: ${n.creditsRemaining?.toLocaleString("en-US") ?? "unknown"}

  Per-call cost of the endpoints this repo uses:
    /tgm/flows                    1
    /tgm/flow-intelligence        1
    /tgm/dex-trades               1
    /token-screener               1
    /smart-money/perp-trades      5
    ------------------------------
    one `node demo.mjs` run       9 credits (5 calls: 4 x 1 + 1 x 5)

  Fused shut in src/nansen.mjs (never callable):
    /profiler/address/labels    100 (common) / 500 (premium)
`);
