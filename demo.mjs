#!/usr/bin/env node
/**
 * The whole idea in one command:
 *
 *   node demo.mjs PENGU
 *
 * Walks the same Nansen calls Swenai makes for a real trade decision, and ends
 * on the decision itself - whether the trade button would arm or disarm.
 *
 * Requires only Node 18+ and a NANSEN_API_KEY. No dependencies, no build step.
 */
import { readFileSync } from "node:fs";
import { Nansen, resolveToken } from "./src/nansen.mjs";

// ── tiny terminal helpers ────────────────────────────────────────────────────
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
const usd = (v) => {
  const a = Math.abs(v);
  const s = a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}K` : `$${Math.round(a)}`;
  return v < 0 ? `-${s}` : `+${s}`;
};
const signed = (v, text) => (v >= 0 ? C.green(text) : C.red(text));
const rule = (t = "") => console.log(C.dim(`\n${"─".repeat(72)}${t ? ` ${t} ` : ""}`));

// ── key ──────────────────────────────────────────────────────────────────────
function apiKey() {
  if (process.env.NANSEN_API_KEY) return process.env.NANSEN_API_KEY.trim();
  try {
    const env = readFileSync(new URL(".env", import.meta.url), "utf8");
    const m = env.match(/^NANSEN_API_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim();
  } catch { /* no .env file */ }
  console.error("\nNANSEN_API_KEY not found.\n  cp .env.example .env   then paste your key from https://app.nansen.ai/api\n");
  process.exit(1);
}

const SYMBOL = (process.argv[2] ?? "PENGU").toUpperCase();

console.log(C.bold(`\n  Swenai x Nansen - decision walkthrough for $${SYMBOL}`));
console.log(C.dim("  Nansen data does not render as a dashboard here. It decides.\n"));

const nansen = new Nansen(apiKey(), {
  onCall: (path, n) => console.log(C.dim(`    → call ${n}: ${path}`)),
});

// ── 1. resolve the token ─────────────────────────────────────────────────────
rule("1. RESOLVE");
const token = await resolveToken(SYMBOL);
if (!token) {
  console.log(`  No DEX market found for ${SYMBOL}. Try PENGU, PEPE, BONK, WIF or ETH.\n`);
  process.exit(0);
}
console.log(`  ${SYMBOL} on ${C.cyan(token.chain)} · $${token.priceUsd} · liquidity ${usd(token.liq)} · 24h vol ${usd(token.vol)}`);
console.log(C.dim(`  ${token.tokenAddress}`));

// ── 2. the naive read ────────────────────────────────────────────────────────
rule("2. THE NUMBER MOST TOOLS SHOW YOU");
const flow = await nansen.topHolderFlow(token.chain, token.tokenAddress).catch(() => null);
if (flow) {
  console.log(`  Top-100 holder flow, 24h: ${signed(flow.netflowUsd, C.bold(usd(flow.netflowUsd) + " net"))}`);
  console.log(C.dim(`    in ${usd(flow.inflowUsd)} / out ${usd(-flow.outflowUsd)}${flow.holders ? ` · ${flow.holders} holders` : ""}`));
  console.log(C.dim(`    Note: this is the TOP-100 HOLDER cohort. It is not "smart money" -`));
  console.log(C.dim(`    Nansen has a separate, far narrower smart-money label.`));
} else {
  console.log(C.dim("  No top-holder flow for this token."));
}

// ── 3. the honest read ───────────────────────────────────────────────────────
rule("3. WHO IS ACTUALLY ON EACH SIDE");
const cohort = await nansen.cohortFlow(token.chain, token.tokenAddress).catch(() => null);
if (cohort) {
  const colour = cohort.verdict === "smart accumulation" ? C.green
    : cohort.verdict === "retail bid, smart exit" ? C.amber : cohort.verdict === "smart distribution" ? C.red : C.dim;
  console.log(`  Verdict: ${colour(C.bold(cohort.verdict.toUpperCase()))}\n`);
  for (const c of cohort.cohorts.filter((x) => Math.abs(x.netUsd) >= 10_000).sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd))) {
    console.log(`    ${c.label.padEnd(18)} ${signed(c.netUsd, usd(c.netUsd).padStart(10))}${c.wallets ? C.dim(`  ${c.wallets} wallets`) : ""}`);
  }
  if (cohort.verdict === "retail bid, smart exit") {
    console.log(C.amber(`\n    Fresh money is buying while the smart cohorts sell.`));
    console.log(C.amber(`    A single net-flow number renders this as bullish. It is distribution.`));
  }
} else {
  console.log(C.dim("  No cohort split available for this token."));
}

// ── 4. whale trades ──────────────────────────────────────────────────────────
rule("4. THE LARGEST TRADES (these get pinned to candles on the chart)");
const whales = await nansen.whaleTrades(token.chain, token.tokenAddress).catch(() => null);
if (whales?.length) {
  const buys = whales.filter((w) => w.side === "buy").length;
  const top = [...whales].sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 5);
  console.log(`  ${whales.length} trades over $0 in the window · ${C.green(`${buys} buys`)} / ${C.red(`${whales.length - buys} sells`)}\n`);
  for (const w of top) {
    const when = new Date(w.ts * 1000).toISOString().slice(0, 16).replace("T", " ");
    console.log(`    ${when}  ${w.side === "buy" ? C.green("BUY ") : C.red("SELL")}  ${usd(w.valueUsd).padStart(9)}${w.labeled ? C.dim("  (labeled wallet)") : ""}`);
  }
  console.log(C.dim(`\n    Wallet label STRINGS are never displayed - Nansen's terms prohibit it.`));
  console.log(C.dim(`    The adapter reduces the label to a boolean so it cannot leak.`));
} else {
  console.log(C.dim("  No whale trades in the window."));
}

// ── 5. the venue ─────────────────────────────────────────────────────────────
rule("5. THE VENUE THE ORDER WOULD LAND ON");
const bias = await nansen.perpBias(SYMBOL).catch(() => null);
if (bias) {
  const colour = bias.bias === "net long" ? C.green : bias.bias === "net short" ? C.red : C.dim;
  console.log(`  Smart money on Hyperliquid is ${colour(C.bold(bias.bias))} ${SYMBOL} over 72h.`);
  console.log(C.dim(`  (${bias.trades} qualifying trades. This is a no-redistribution endpoint:`));
  console.log(C.dim(`   it produces ONE WORD that gates a button, and is never shown as data.)`));
} else {
  console.log(C.dim(`  ${SYMBOL} has no Hyperliquid perp activity in the window.`));
}

// ── 6. the decision ──────────────────────────────────────────────────────────
rule("6. THE DECISION");
const wouldLong = true; // a long is the case worth testing
const reasons = [];
if (cohort?.verdict === "retail bid, smart exit") reasons.push("cohort flow shows retail bidding into smart-money exits");
if (cohort?.verdict === "smart distribution") reasons.push("smart cohorts are net distributing");
if (bias?.bias === "net short") reasons.push(`smart money on Hyperliquid is net short ${SYMBOL}`);

if (reasons.length) {
  console.log(`  ${C.amber(C.bold("TRADE DISARMED"))} for a long on ${SYMBOL}:`);
  for (const r of reasons) console.log(C.amber(`    · ${r}`));
  console.log(C.dim(`\n  In the product the button refuses to arm and states this reason.`));
  console.log(C.dim(`  You can override it - but it is your call, not the agent's.`));
} else {
  console.log(`  ${C.green(C.bold("NO NANSEN OBJECTION"))} to a long on ${SYMBOL}.`);
  console.log(C.dim(`  Flow does not contradict the side. In the product the trade button arms,`));
  console.log(C.dim(`  and the plan still has to clear the chart engine and the Jev check.`));
}

// ── 7. and the screen a chart cannot run ─────────────────────────────────────
rule("7. WHAT A CHART CANNOT SEE: smart money buying while price falls");
const div = await nansen.divergence(6).catch(() => null);
if (div?.length) {
  console.log("");
  for (const d of div) {
    console.log(`    ${d.symbol.padEnd(10)} ${C.dim(d.chain.padEnd(9))} price ${C.red(`${d.priceChangePct.toFixed(1)}%`)}   smart money ${C.green(usd(d.smartNetflowUsd))}   ${C.dim(`mcap ${usd(d.mcapUsd)}`)}`);
  }
  console.log(C.dim(`\n    These are candidates, not trades. In Swenai they feed a signal lane`));
  console.log(C.dim(`    where each one must still clear the same five quality gates.`));
} else {
  console.log(C.dim("  Nothing passes the divergence screen right now."));
}

rule();
console.log(`  ${C.bold(`${nansen.calls} Nansen API calls`)} this run${nansen.creditsRemaining !== null ? C.dim(`  ·  ${nansen.creditsRemaining.toLocaleString("en-US")} credits remaining`) : ""}`);
console.log(C.dim("  On-chain data powered by Nansen API · https://www.nansen.ai\n"));
