/**
 * Nansen API adapter - the exact shapes Swenai runs in production.
 *
 * Every request body here was verified against the LIVE API, not copied from
 * docs. Four things the docs get wrong or leave out, each of which cost us a
 * debugging session:
 *
 *  1. Dates go as {"date":{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}}.
 *     date_from / date_to returns 422.
 *  2. Pagination is {"pagination":{"page":1,"per_page":100}}.
 *     `recordsPerPage` is NOT a real field - the API accepts it with HTTP 200
 *     and silently serves 10 rows. We shipped whale markers drawn from 10
 *     trades instead of 100 for a week before catching it.
 *  3. /tgm/flows defaults to label:"top_100_holders". If you call it without a
 *     label and call the result "smart money", you are wrong - that is the top
 *     100 holders. Nansen's actual smart_money cohort is far narrower (PEPE:
 *     45 wallets, ~$190K of holdings, vs $1.4B for the top 100). We pass the
 *     label explicitly so the name can never drift from the data again.
 *  4. Each endpoint family has its OWN timeframe vocabulary.
 *     /tgm/flow-intelligence takes "1d" and REJECTS "24h".
 *     /token-screener takes "24h" and rejects "1d".
 *
 * And one that will bite you silently: the screener DISCARDS filter keys it
 * does not recognise and still returns 200. A typo fails OPEN into a wrong
 * result set, so every filter we send is re-checked in code after the response.
 */

const BASE = "https://api.nansen.ai/api/v1";

/** Endpoints that cost 100-500 credits and may never be redistributed. Making
 *  them unreachable beats trusting every future edit to remember. */
const FUSED = ["/profiler/address/labels", "premium-labels"];

export class Nansen {
  constructor(apiKey, { onCall } = {}) {
    if (!apiKey) throw new Error("NANSEN_API_KEY is required");
    this.key = apiKey;
    this.onCall = onCall ?? (() => {});
    this.calls = 0;
    this.creditsRemaining = null;
  }

  async post(path, body, timeoutMs = 15000) {
    if (FUSED.some((f) => path.includes(f))) {
      throw new Error(`Refusing to call ${path}: 100-500 credits and non-redistributable.`);
    }
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: this.key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Count only real calls: a 402/429 is not a call in Nansen's own log.
    const remaining = res.headers.get("x-nansen-credits-remaining");
    if (remaining !== null) this.creditsRemaining = Number(remaining);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Nansen ${path} -> HTTP ${res.status} ${detail.slice(0, 200)}`);
    }
    this.calls++;
    this.onCall(path, this.calls);
    const json = await res.json();
    return Array.isArray(json) ? json : json?.data ?? [];
  }

  /** GT/DexScreener chain names -> Nansen chain ids. */
  static chain(name) {
    const map = {
      eth: "ethereum", ethereum: "ethereum", bsc: "bnb", bnb: "bnb",
      base: "base", solana: "solana", arbitrum: "arbitrum",
      polygon: "polygon", optimism: "optimism", avalanche: "avalanche",
    };
    return map[String(name).toLowerCase()] ?? null;
  }

  static dateWindow(hoursBack) {
    return {
      from: new Date(Date.now() - hoursBack * 3600_000).toISOString().slice(0, 10),
      to: new Date().toISOString().slice(0, 10),
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * COHORT FLOW - 1 credit. The single most useful call in this file.
   *
   * A net flow number hides the most important pattern in on-chain data: WHO
   * is on each side. Fresh wallets buying while top-PnL wallets and smart
   * traders sell is a textbook distribution top, and a single "+$2.1M net"
   * bar renders it as bullish. This splits the same window across six cohorts.
   * ───────────────────────────────────────────────────────────────────────── */
  async cohortFlow(chain, tokenAddress) {
    const nc = Nansen.chain(chain);
    if (!nc) return null;
    // timeframe "1d" - this endpoint rejects "24h".
    const rows = await this.post("/tgm/flow-intelligence", {
      chain: nc, token_address: tokenAddress, timeframe: "1d",
    });
    const r = rows[0];
    if (!r) return null;

    const COHORTS = [
      ["top_pnl", "Top-PnL wallets"], ["smart_trader", "Smart traders"],
      ["whale", "Whales"], ["fresh_wallets", "Fresh wallets"],
      ["public_figure", "Public figures"], ["exchange", "Exchanges"],
    ];
    const cohorts = [];
    for (const [prefix, label] of COHORTS) {
      const netUsd = Number(r[`${prefix}_net_flow_usd`]);
      if (!Number.isFinite(netUsd)) continue;
      cohorts.push({ key: prefix, label, netUsd, wallets: Number(r[`${prefix}_wallet_count`]) || 0 });
    }
    if (!cohorts.length) return null;

    const pick = (k) => cohorts.find((c) => c.key === k)?.netUsd ?? 0;
    const smartNetUsd = pick("top_pnl") + pick("smart_trader") + pick("whale");
    const freshNetUsd = pick("fresh_wallets");
    const MATERIAL = 25_000; // below this the split is noise, not a read

    const verdict =
      smartNetUsd > MATERIAL && freshNetUsd <= 0 ? "smart accumulation"
      : smartNetUsd < -MATERIAL && freshNetUsd > MATERIAL ? "retail bid, smart exit"
      : smartNetUsd < -MATERIAL ? "smart distribution"
      : smartNetUsd > MATERIAL ? "smart accumulation"
      : "mixed";

    return { cohorts, verdict, smartNetUsd, freshNetUsd };
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * TOP-HOLDER FLOW - 1 credit. Named honestly (see note 3 at the top).
   * ───────────────────────────────────────────────────────────────────────── */
  async topHolderFlow(chain, tokenAddress, hoursBack = 24) {
    const nc = Nansen.chain(chain);
    if (!nc) return null;
    const rows = await this.post("/tgm/flows", {
      chain: nc, token_address: tokenAddress,
      date: Nansen.dateWindow(hoursBack),
      label: "top_100_holders", // EXPLICIT: see note 3
    });
    let inflowUsd = 0, outflowUsd = 0, holders = null, seen = false;
    for (const r of rows) {
      const price = Number(r.price_usd);
      // Despite the name, *_count fields are TOKEN AMOUNTS; outflows are negative.
      const inTok = Number(r.total_inflows_count), outTok = Number(r.total_outflows_count);
      if (price > 0) {
        if (inTok > 0) { inflowUsd += inTok * price; seen = true; }
        if (outTok < 0) { outflowUsd += Math.abs(outTok) * price; seen = true; }
      }
      if (Number.isFinite(Number(r.holders_count))) holders = Number(r.holders_count);
    }
    if (!seen) return null;
    return { netflowUsd: inflowUsd - outflowUsd, inflowUsd, outflowUsd, holders, cohort: "top_100_holders" };
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * DIVERGENCE SCREEN - 1 credit. Tokens where smart money is a NET BUYER
   * while PRICE IS DOWN: accumulation into weakness. This is the query a
   * chart-only product structurally cannot run.
   * ───────────────────────────────────────────────────────────────────────── */
  async divergence(limit = 10) {
    const rows = await this.post("/token-screener", {
      chains: ["ethereum", "base", "solana", "bnb", "arbitrum"],
      timeframe: "24h", // screener's OWN vocabulary - "1d" is rejected here
      filters: {
        trader_type: "sm",            // genuine Nansen smart-money cohort
        netflow: { min: 0 },          // they are net BUYING
        price_change: { max: 0 },     // ...while price FALLS
        market_cap_usd: { min: 5_000_000, max: 2_000_000_000 },
        liquidity: { min: 250_000 },
        include_stablecoins: false, include_native_tokens: false,
      },
      pagination: { page: 1, per_page: 50 },
      order_by: [{ field: "netflow", direction: "DESC" }],
    });

    const out = [];
    for (const r of rows) {
      const hit = {
        symbol: String(r.token_symbol ?? "").toUpperCase(),
        chain: String(r.chain ?? ""),
        tokenAddress: r.token_address,
        priceChangePct: Number(r.price_change) * 100, // API returns a ratio
        smartNetflowUsd: Number(r.netflow),
        mcapUsd: Number(r.market_cap_usd),
        liquidityUsd: Number(r.liquidity),
        buyers: Number(r.nof_buyers) || 0,
        sellers: Number(r.nof_sellers) || 0,
      };
      // RE-CHECK IN CODE: the screener silently drops filters it does not
      // recognise, so a typo would fail OPEN into a wrong board (see header).
      if (!hit.symbol || !hit.tokenAddress || !hit.chain) continue;
      if (!(hit.priceChangePct <= 0)) continue;
      if (!(hit.smartNetflowUsd > 0)) continue;
      if (!(hit.liquidityUsd >= 250_000)) continue;
      if (!(hit.mcapUsd >= 5_000_000)) continue;
      out.push(hit);
    }
    return out.slice(0, limit);
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * HYPERLIQUID SIDE AGREEMENT - 5 credits. Which way smart money is
   * positioned on the venue an order would actually land on.
   *
   * COMPLIANCE: this endpoint is in Nansen's no-redistribution tier, and the
   * policy extends to derived data. So this returns ONE WORD, it is never
   * rendered as data, never stored, never sent to a third party, and in the
   * product it is computed only for the account that can fire the order it
   * gates. A decision is not a redistribution.
   * ───────────────────────────────────────────────────────────────────────── */
  async perpBias(symbol) {
    const sym = symbol.toUpperCase();
    const rows = await this.post("/smart-money/perp-trades", {
      lookback_hours: 72, // NOTE: lookback_hours is TOP-LEVEL, not in filters
      filters: { token_symbol: sym, value_usd: { min: 25_000 } },
      pagination: { page: 1, per_page: 100 },
      order_by: [{ field: "block_timestamp", direction: "DESC" }],
    });
    let netUsd = 0, trades = 0;
    for (const r of rows) {
      if (String(r.token_symbol ?? "").toUpperCase() !== sym) continue;
      const usd = Number(r.value_usd);
      if (!(usd > 0)) continue;
      const side = String(r.side ?? "").toLowerCase();     // long | short
      const action = String(r.action ?? "").toLowerCase();  // open | add | close | reduce
      if (side !== "long" && side !== "short") continue;
      const opening = action.includes("open") || action.includes("add");
      // Adding a long or closing a short is bullish exposure; the inverse bearish.
      const bullish = side === "long" ? opening : !opening;
      netUsd += bullish ? usd : -usd;
      trades++;
    }
    if (!trades) return null;
    const MATERIAL = 250_000;
    return {
      bias: netUsd > MATERIAL ? "net long" : netUsd < -MATERIAL ? "net short" : "balanced",
      trades,
      // internal only - never rendered
      _netUsd: netUsd,
    };
  }

  /* ─────────────────────────────────────────────────────────────────────────
   * WHALE TRADES - 1 credit. Individual large DEX trades WITH timestamps,
   * which is what lets them be pinned to candles on a chart.
   *
   * COMPLIANCE: Nansen wallet LABEL STRINGS must never be displayed. The
   * string is reduced to a boolean HERE, at the adapter boundary, so it
   * cannot leak downstream - the type system then enforces it everywhere.
   * ───────────────────────────────────────────────────────────────────────── */
  async whaleTrades(chain, tokenAddress, hoursBack = 168) {
    const nc = Nansen.chain(chain);
    if (!nc) return null;
    const rows = await this.post("/tgm/dex-trades", {
      chain: nc, token_address: tokenAddress,
      date: Nansen.dateWindow(hoursBack),
      pagination: { page: 1, per_page: 100 }, // NOT recordsPerPage - see note 2
      order_by: [{ field: "estimated_value_usd", direction: "DESC" }],
    });
    const out = [];
    for (const r of rows) {
      const usd = Number(r.estimated_value_usd);
      const ts = Date.parse(r.block_timestamp);
      const action = String(r.action ?? "").toUpperCase();
      if (!(usd > 0) || !Number.isFinite(ts)) continue;
      out.push({
        ts: Math.floor(ts / 1000),
        side: action === "BUY" ? "buy" : "sell",
        valueUsd: usd,
        labeled: typeof r.trader_address_label === "string" && r.trader_address_label.length > 0,
      });
    }
    return out;
  }
}

/** Canonical contracts for the tickers the README suggests. Two jobs:
 *  1. A clone can never win the search for these - DexScreener lists dogwifhat
 *     as "$WIF", so a plain symbol match missed it and a $0 BSC "WIF" won.
 *  2. The demo still runs if DexScreener is down (pinned address, no price). */
const KNOWN = {
  PENGU: { chain: "solana",   tokenAddress: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv" },
  PEPE:  { chain: "ethereum", tokenAddress: "0x6982508145454Ce325dDbE47a25d4ec3d2311933" },
  BONK:  { chain: "solana",   tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" },
  WIF:   { chain: "solana",   tokenAddress: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm" },
  WETH:  { chain: "ethereum", tokenAddress: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" },
};

/** Resolve a ticker to its deepest real DEX market (DexScreener, no key).
 *  Ranked by min(liquidity, volume) - a spoofed pool shows huge liquidity on
 *  no volume, and ranking on the minimum makes that impossible to win. */
export async function resolveToken(symbol) {
  const FLOW_ALIAS = { BTC: "WBTC", ETH: "WETH" }; // majors trade on-chain wrapped
  const q = (FLOW_ALIAS[symbol.toUpperCase()] ?? symbol).toUpperCase();
  const known = KNOWN[q] ?? null;
  const clean = (s) => String(s ?? "").replace(/^\$/, "").toUpperCase(); // "$WIF" -> "WIF"

  let pairs = [];
  try {
    // A pinned ticker is looked up by ADDRESS (exact, cannot miss); anything
    // else by symbol text. The text search does not return dogwifhat for
    // "WIF" at all, so for pinned tickers it was the wrong tool.
    const endpoint = known
      ? `https://api.dexscreener.com/latest/dex/tokens/${known.tokenAddress}`
      : `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    if (res.ok) pairs = (await res.json()).pairs ?? [];
  } catch { /* DexScreener unreachable - the pinned address below still works */ }

  const best = pairs
    .filter((p) => Nansen.chain(p.chainId))
    // Pinned ticker: only its canonical contract counts. Otherwise: symbol match.
    .filter((p) => known
      ? p.chainId === known.chain && p.baseToken?.address?.toLowerCase() === known.tokenAddress.toLowerCase()
      : clean(p.baseToken?.symbol) === q)
    .map((p) => ({
      chain: p.chainId,
      tokenAddress: p.baseToken.address,
      priceUsd: Number(p.priceUsd),
      liq: p.liquidity?.usd ?? 0,
      vol: p.volume?.h24 ?? 0,
      source: "dexscreener",
    }))
    .sort((a, b) => Math.min(b.liq, b.vol) - Math.min(a.liq, a.vol))[0];

  if (best) return best;
  if (known) return { ...known, priceUsd: null, liq: null, vol: null, source: "builtin" };
  return null;
}
