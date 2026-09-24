# Swenai × Nansen

**Nansen data never renders as a dashboard here. It makes decisions.**

It sources trade signals, overrules the chart, and disarms a live Hyperliquid
trade button on the same venue the order would land on.

This repo is the Nansen layer of [Swenai](https://getswenai.com), a production
crypto agent with real users. Everything below runs against the live API in one
command, with no dependencies and no build step.

---

## Run it in two minutes

```bash
git clone https://github.com/<you>/swenai-nansen && cd swenai-nansen
cp .env.example .env          # paste your key from https://app.nansen.ai/api
node demo.mjs PENGU
```

Node 18+ is the only requirement. There is nothing to install: no `npm install`,
no bundler, no framework. One run costs **5 Nansen credits**.

Try `node demo.mjs BONK`, `WIF`, `PEPE`, or `ETH`. The interesting output
appears on tokens that are actively being distributed.

---

## What the demo prints

Real output, PENGU, 2026-09-23:

```
2. THE NUMBER MOST TOOLS SHOW YOU
  Top-100 holder flow, 24h: +$801K net              ← reads bullish

3. WHO IS ACTUALLY ON EACH SIDE
  Verdict: RETAIL BID, SMART EXIT

    Fresh wallets         +$1.01M
    Exchanges              +$659K
    Whales                 -$239K   9 wallets
    Top-PnL wallets         +$65K   5 wallets

    Fresh money is buying while the smart cohorts sell.
    A single net-flow number renders this as bullish. It is distribution.

6. THE DECISION
  TRADE DISARMED for a long on PENGU:
    · cohort flow shows retail bidding into smart-money exits
```

That is the whole thesis. The number every tool shows you said accumulation.
The cohort split said the opposite, and the trade did not get placed.

---

## The four things Nansen decides

### 1. It contradicts the headline number

`/tgm/flow-intelligence` (1 credit) splits the *same* 24h window across six
wallet cohorts. Fresh wallets buying while top-PnL wallets and smart traders
sell is a textbook distribution top — and a single net-flow bar renders it as
bullish. In the product this is a strip on every analysis card, and the verdict
is an input to the trade judgment, not a decoration beside it.

### 2. It finds trades the chart cannot

`/token-screener` with `trader_type: "sm"`, `netflow: {min: 0}` and
`price_change: {max: 0}` asks a question no chart-based tool can: *where is
smart money buying while price falls?* Those hits feed a dedicated signal lane —
so Nansen **originates** signals rather than only filtering them. Each candidate
still has to clear the same five quality gates as every other lane: perp
listing, ≥2-touch structure, higher-timeframe alignment, news veto, flow veto.

### 3. It vetoes our own signals

Before any auto-generated signal is published, `/tgm/flows` must not contradict
it. A long into more than $250k of 24h net distribution never ships. The gate is
one-directional by design: a data gap passes, because a veto must never become a
dependency.

### 4. It disarms the trade button

This is the part that is not a dashboard.

Swenai executes on Hyperliquid. Nansen tracks smart-money perp activity **on
Hyperliquid**. So before arming a one-tap trade, we ask which way smart money is
positioned on the exact venue the order would land on. If they are on the other
side, the button refuses to arm:

> **Trade disarmed:** smart money on Hyperliquid is net short this coin, against
> your side. *Powered by Nansen API.*

You can override it. But the default is that the data stops your hand, on the
venue where it was observed.

---

## Compliance

Nansen's redistribution terms are strict, and most smart-money endpoints may not
be redistributed at all. That constraint is not an obstacle to this design — it
is the reason for it. **A decision is not a redistribution.**

| Data | Tier | What actually reaches a user | Why this is allowed |
|---|---|---|---|
| `/tgm/flows` | attribution | USD flow totals, labelled **"top holders"** | Shown with "Powered by Nansen API" and a link to nansen.ai |
| `/tgm/flow-intelligence` | attribution | Six cohort net-flow figures | Same attribution, shown adjacent to the data |
| `/tgm/dex-trades` | attribution | Trade markers on a chart: size, side, time | Attribution in the chart legend |
| `/token-screener` | attribution | A candidate list | Attribution on the surface that renders it |
| `/smart-money/perp-trades` | **no redistribution** | **Nothing.** One derived word gates a button | Never rendered, never stored, never sent to a third party, and computed only for the account that can fire the order it gates |
| `/profiler/address/labels` | prohibited | — | **Unreachable**: the adapter refuses the path outright (`FUSED` in `src/nansen.mjs`) |

Two rules are enforced in code rather than by convention:

- **Wallet label strings can never leak.** The label is reduced to a boolean at
  the adapter boundary, inside `nansen.mjs`. The string does not exist outside
  that file, so no downstream surface can print it by accident.
- **The 100–500 credit label endpoints are fused shut.** Calling one throws.
  A runaway agent loop cannot spend the credit balance.

---

## Four things the docs get wrong

Every request body here was verified against the live API. These cost us real
debugging time and are the reason this repo is worth reading:

1. **`recordsPerPage` is not a real field.** The API accepts it with **HTTP 200**
   and silently serves 10 rows. We shipped chart whale-markers drawn from 10
   trades instead of 100 for a week before catching it. The field is `per_page`.

2. **`/tgm/flows` defaults to `label: "top_100_holders"`.** Call it without a
   label and call the result "smart money", and you are wrong — we did exactly
   that, and fixed it. Nansen's real `smart_money` cohort is far narrower (PEPE:
   45 wallets, ~$190K of holdings, against $1.4B for the top 100). We now pass
   the label explicitly so the name can never drift from the data again.

3. **Every endpoint family has its own timeframe vocabulary.**
   `/tgm/flow-intelligence` takes `"1d"` and rejects `"24h"`.
   `/token-screener` takes `"24h"` and rejects `"1d"`.

4. **The screener fails open.** It discards filter keys it does not recognise
   and still returns 200 — a typo silently produces a wrong result set. Every
   filter we send is therefore re-checked in code against the returned rows.

Also: dates go as `{"date":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}}`, and on
`/smart-money/perp-trades`, `lookback_hours` is top-level, not inside `filters`.

---

## Files

| File | What it is |
|---|---|
| `src/nansen.mjs` | The adapter. Five endpoints, exact verified shapes, the compliance boundary, the cost fuse. |
| `demo.mjs` | The walkthrough above — resolve, naive read, honest read, whale trades, venue, decision, divergence screen. |
| `scripts/count-calls.mjs` | Prints your key's credit balance and per-endpoint cost. |
| `production/` | The **actual live code** from getswenai.com that consumes this adapter: the signal-lane veto, the Nansen-sourced divergence lane, the venue disarm gate, and the sweep cron. Reference only - these import from the app and are not runnable here. |

In production these same calls are cached (15–20 min), tallied, and fail safe:
any error returns null and the product behaves exactly as it did before Nansen
existed. Enrichment, never a dependency.

---

## Where this runs

- **Live product:** [getswenai.com](https://getswenai.com) — ask for analysis on
  any token and the cohort strip appears on the card.
- **Public track record:** [getswenai.com/track-record](https://getswenai.com/track-record)
  — every auto-generated signal, graded automatically against real candles, with
  losses and cancellations shown. The Nansen-sourced divergence lane is graded
  alongside the rest.

Built for the [Nansen Meridian Buildathon](https://www.nansen.ai), September 2026.

On-chain data powered by [Nansen API](https://www.nansen.ai).

MIT licensed.

---

## Why this repo is small

This is deliberately the **Nansen layer only**, not the whole product.

The full Swenai app needs Supabase, four LLM providers, a paid market-data
plan and fifteen environment variables — you would not get it running in ten
minutes, and it contains exchange-key handling that has no business being
public. So this repo is the part that matters for judging: the adapter, a
runnable demo, and the real production code that consumes it.

The product those files run inside is live at
[getswenai.com](https://getswenai.com). Ask it for analysis on any token and
the cohort strip in `src/nansen.mjs` appears on the card.
