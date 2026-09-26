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
 * Exit code 0 when every Nansen call succeeded, 1 when any failed or no key.
 */
import { Nansen, resolveToken, loadApiKey, explainError } from "./src/nansen.mjs";

// ── tiny terminal helpers ────────────────────────────────────────────────────
const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  amber: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};
/** A size: liquidity, volume, market cap, one trade. No sign. */
const amt = (v) => {
  const a = Math.abs(v);
  return a >= 1e6 ? `$${(a / 1e6).toFixed(2)}M` : a >= 1e3 ? `$${Math.round(a / 1e3)}K` : `$${Math.round(a)}`;
};
/** A net flow. Signed, because the direction is the information. */
const net = (v) => `${v < 0 ? "-" : "+"}${amt(v)}`;
const signed = (v, text) => (v >= 0 ? C.green(text) : C.red(text));
const rule = (t = "") => console.log(C.dim(`\n${"─".repeat(72)}${t ? ` ${t} ` : ""}`));

const SYMBOL = (process.argv[2] ?? "PENGU").toUpperCase();

async function main() {
  // ── key ────────────────────────────────────────────────────────────────────
  const key = loadApiKey(new URL(".env", import.meta.url));
  if (!key) {
    console.error("\nNANSEN_API_KEY not found.");
    console.error("  Set it in this terminal (see README, Try it), or: cp .env.example .env");
    console.error("  and paste your key after the =. Get a key at https://app.nansen.ai/api\n");
    return 1;
  }
  const keySource = String(process.env.NANSEN_API_KEY ?? "").replace(/["'\s]/g, "")
    ? "the NANSEN_API_KEY environment variable (it overrides .env)"
    : "the .env file";

  console.log(C.bold(`\n  Swenai x Nansen - decision walkthrough for $${SYMBOL}`));
  console.log(C.dim("  Nansen data does not render as a dashboard here. It decides.\n"));

  const nansen = new Nansen(key, {
    onCall: (path, n) => console.log(C.dim(`    → call ${n}: ${path}`)),
  });

  // Every Nansen call goes through ask(): it returns [value, error] so each
  // section can tell "Nansen has no data" apart from "the call failed".
  const failures = [];
  const ask = async (fn) => {
    try { return [await fn(), null]; } catch (err) { failures.push(err); return [null, err]; }
  };
  const failLine = (err) => {
    const e = explainError(err);
    console.log(C.red(`  Call failed: ${e.what}. Likely cause: ${e.cause}.`));
  };
  // With zero successful calls every section would read "no data" and the
  // decision would be made on nothing. Stop and say why instead.
  const stop = (err) => {
    const e = explainError(err);
    console.error(C.red(C.bold(`\n  NANSEN API ERROR: ${e.what}`)));
    if (e.said) console.error(`    Nansen said: ${e.said}`);
    console.error(`    Likely cause: ${e.cause}.`);
    if (e.keyProblem) {
      console.error(C.dim(`    The key was read from ${keySource}.`));
      console.error(C.dim(`    Check the key and its credits at https://app.nansen.ai/api`));
    }
    console.error(C.dim(`    No decision printed: without Nansen data it would be a guess.\n`));
    return 1;
  };
  // A rejected key (401), no credits (402), a rate limit (429) or no
  // connection at all mean the same thing on every endpoint: if nothing has
  // worked yet, stop at the first. A timeout or a 403/5xx can be one
  // endpoint's problem, so those let the other calls run.
  const fatal = (err) => err && nansen.calls === 0
    && ([401, 402, 429].includes(err.status) || (!err.status && err.name !== "TimeoutError"));

  // ── 1. resolve the token ───────────────────────────────────────────────────
  rule("1. RESOLVE");
  const token = await resolveToken(SYMBOL);
  if (!token) {
    console.log(`  No DEX market found for ${SYMBOL}. Try PENGU, PEPE, BONK, WIF or ETH.\n`);
    return 0;
  }
  const market = token.priceUsd ? ` · $${token.priceUsd} · liquidity ${amt(token.liq)} · 24h vol ${amt(token.vol)}` : C.dim(" · (market data unavailable, using the pinned address)");
  console.log(`  ${SYMBOL} on ${C.cyan(token.chain)}${market}`);
  console.log(C.dim(`  ${token.tokenAddress}${token.source === "builtin" ? "  (pinned canonical address)" : ""}`));

  // ── 2. the naive read ──────────────────────────────────────────────────────
  rule("2. THE NUMBER MOST TOOLS SHOW YOU");
  const [flow, flowErr] = await ask(() => nansen.topHolderFlow(token.chain, token.tokenAddress));
  if (fatal(flowErr)) return stop(flowErr);
  if (flow) {
    console.log(`  Top-100 holder flow, 24h: ${signed(flow.netflowUsd, C.bold(net(flow.netflowUsd) + " net"))}`);
    console.log(C.dim(`    in ${amt(flow.inflowUsd)} / out ${amt(flow.outflowUsd)}${flow.holders ? ` · ${flow.holders} holders` : ""}`));
    console.log(C.dim(`    Note: this is the TOP-100 HOLDER cohort. It is not "smart money" -`));
    console.log(C.dim(`    Nansen has a separate, far narrower smart-money label.`));
  } else if (flowErr) {
    failLine(flowErr);
  } else {
    console.log(C.dim("  No top-holder flow for this token."));
  }

  // ── 3. the honest read ─────────────────────────────────────────────────────
  rule("3. WHO IS ACTUALLY ON EACH SIDE");
  const [cohort, cohortErr] = await ask(() => nansen.cohortFlow(token.chain, token.tokenAddress));
  if (fatal(cohortErr)) return stop(cohortErr);
  if (cohort) {
    const colour = cohort.verdict === "smart accumulation" ? C.green
      : cohort.verdict === "retail bid, smart exit" ? C.amber : cohort.verdict === "smart distribution" ? C.red : C.dim;
    console.log(`  Verdict: ${colour(C.bold(cohort.verdict.toUpperCase()))}\n`);
    for (const c of cohort.cohorts.filter((x) => Math.abs(x.netUsd) >= 10_000).sort((a, b) => Math.abs(b.netUsd) - Math.abs(a.netUsd))) {
      console.log(`    ${c.label.padEnd(18)} ${signed(c.netUsd, net(c.netUsd).padStart(10))}${c.wallets ? C.dim(`  ${c.wallets} wallets`) : ""}`);
    }
    if (cohort.verdict === "retail bid, smart exit") {
      console.log(C.amber(`\n    Fresh money is buying while the smart cohorts sell.`));
      console.log(C.amber(`    A single net-flow number renders this as bullish. It is distribution.`));
    }
  } else if (cohortErr) {
    failLine(cohortErr);
  } else {
    console.log(C.dim("  No cohort split available for this token."));
  }

  // ── 4. whale trades ────────────────────────────────────────────────────────
  rule("4. THE LARGEST TRADES (these get pinned to candles on the chart)");
  const [whales, whalesErr] = await ask(() => nansen.whaleTrades(token.chain, token.tokenAddress));
  if (fatal(whalesErr)) return stop(whalesErr);
  if (whales?.length) {
    const buys = whales.filter((w) => w.side === "buy").length;
    const top = [...whales].sort((a, b) => b.valueUsd - a.valueUsd).slice(0, 5);
    // One API page holds 100 rows, requested largest first. A full page is
    // the top 100 by size, not every trade in the window.
    const scope = whales.length >= 100 ? `The ${whales.length} largest DEX trades of the last 7 days` : `${whales.length} DEX trades in the last 7 days`;
    console.log(`  ${scope} · ${C.green(`${buys} buys`)} / ${C.red(`${whales.length - buys} sells`)}\n`);
    for (const w of top) {
      const when = new Date(w.ts * 1000).toISOString().slice(0, 16).replace("T", " ");
      console.log(`    ${when}  ${w.side === "buy" ? C.green("BUY ") : C.red("SELL")}  ${amt(w.valueUsd).padStart(9)}${w.labeled ? C.dim("  (labeled wallet)") : ""}`);
    }
    console.log(C.dim(`\n    Wallet label STRINGS are never displayed - Nansen's terms prohibit it.`));
    console.log(C.dim(`    The adapter reduces the label to a boolean so it cannot leak.`));
  } else if (whalesErr) {
    failLine(whalesErr);
  } else {
    console.log(C.dim("  No whale trades in the window."));
  }

  // ── 5. the venue ───────────────────────────────────────────────────────────
  rule("5. THE VENUE THE ORDER WOULD LAND ON");
  const [bias, biasErr] = await ask(() => nansen.perpBias(SYMBOL));
  if (fatal(biasErr)) return stop(biasErr);
  if (bias) {
    const colour = bias.bias === "net long" ? C.green : bias.bias === "net short" ? C.red : C.dim;
    console.log(`  Smart-money positioning on Hyperliquid, ${SYMBOL}, last 72h: ${colour(C.bold(bias.bias))}.`);
    console.log(C.dim(`  (${bias.trades} qualifying trades. This is a no-redistribution endpoint:`));
    console.log(C.dim(`   it produces ONE WORD that gates a button, and is never shown as data.)`));
  } else if (biasErr) {
    failLine(biasErr);
  } else {
    console.log(C.dim(`  ${SYMBOL} has no Hyperliquid perp activity in the window.`));
  }

  // Four calls in and not one succeeded: there is nothing to decide on.
  if (nansen.calls === 0 && failures.length) return stop(failures[0]);

  // ── 6. the decision ────────────────────────────────────────────────────────
  rule("6. THE DECISION");
  const reasons = []; // the case tested is a long
  if (cohort?.verdict === "retail bid, smart exit") reasons.push("cohort flow shows retail bidding into smart-money exits");
  if (cohort?.verdict === "smart distribution") reasons.push("smart cohorts are net distributing");
  const venueShort = bias?.bias === "net short";
  if (venueShort) reasons.push(`smart money on Hyperliquid is net short ${SYMBOL}`);
  const gateFailures = [cohortErr && "cohort", biasErr && "Hyperliquid"].filter(Boolean);

  if (reasons.length) {
    console.log(`  ${C.amber(C.bold("TRADE DISARMED"))} for a long on ${SYMBOL}:`);
    for (const r of reasons) console.log(C.amber(`    · ${r}`));
    if (venueShort) {
      // Only the Hyperliquid read disarms the live button (production/03).
      console.log(C.dim(`\n  In the product the button refuses to arm and states the Hyperliquid reason.`));
      console.log(C.dim(`  You can override it - but it is your call, not the agent's.`));
    } else {
      console.log(C.dim(`\n  The live app shows this cohort verdict on the TA card and weighs it in the`));
      console.log(C.dim(`  trade judgment, but does not disarm the button on it: only the Hyperliquid`));
      console.log(C.dim(`  read (section 5) does. This demo is stricter than the live button.`));
    }
  } else if (gateFailures.length) {
    console.log(`  ${C.amber(C.bold("NO DECISION"))} for a long on ${SYMBOL}.`);
    console.log(C.amber(`    The ${gateFailures.join(" and ")} check failed, so "no objection" would be a guess.`));
  } else {
    console.log(`  ${C.green(C.bold("NO NANSEN OBJECTION"))} to a long on ${SYMBOL}.`);
    console.log(C.dim(`  Flow does not contradict the side, so in the product the trade button arms.`));
    console.log(C.dim(`  The entry, stop and target still come from the chart read, not from Nansen.`));
  }

  // ── 7. and the screen a chart cannot run ───────────────────────────────────
  rule("7. WHAT A CHART CANNOT SEE: smart money buying while price falls");
  const [div, divErr] = await ask(() => nansen.divergence(6));
  if (div?.length) {
    console.log("");
    for (const d of div) {
      console.log(`    ${d.symbol.padEnd(10)} ${C.dim(d.chain.padEnd(9))} price ${C.red(`${d.priceChangePct.toFixed(1)}%`)}   smart money ${C.green(net(d.smartNetflowUsd))}   ${C.dim(`mcap ${amt(d.mcapUsd)}`)}`);
    }
    console.log(C.dim(`\n    These are candidates, not trades. In Swenai they feed a signal lane`));
    console.log(C.dim(`    where each one must still clear the same five quality gates.`));
  } else if (divErr) {
    failLine(divErr);
  } else {
    console.log(C.dim("  Nothing passes the divergence screen right now."));
  }

  rule();
  const failed = failures.length ? C.red(`  ·  ${failures.length} failed`) : "";
  console.log(`  ${C.bold(`${nansen.calls} Nansen API calls`)} this run${failed}${nansen.creditsRemaining !== null ? C.dim(`  ·  ${nansen.creditsRemaining.toLocaleString("en-US")} credits remaining`) : ""}`);
  console.log(C.dim("  On-chain data powered by Nansen API · https://www.nansen.ai\n"));
  return failures.length ? 1 : 0;
}

// exitCode rather than process.exit(): lets piped output finish writing.
process.exitCode = await main();
