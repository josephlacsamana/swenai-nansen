// FROM: app/api/signals-gen/route.ts (live, runs hourly on getswenai.com)
// Gate #5 is the Nansen veto: for DEX-listed candidates (untracked coins in the
// trending and divergence lanes, the only ones built with a token contract), a
// long into heavy on-chain distribution never becomes a published signal. The
// BTC and bluechip lanes and tracked coins carry no contract and skip it. Note
// it fails open: a data gap PASSES, because a veto must never become a
// dependency.
// Reference only: imports from the app, not runnable standalone. The code is
// verbatim; the docstring below is trimmed of internal notes, and it predates
// gate #5 (hence "four").

/** SIGNALS v2 LANE GATES (2026-09-22). [internal notes trimmed]
 * Four deterministic gates every lane candidate must clear; user-requested TA
 * is untouched. Returns null on pass, else the rejection reason (logged in the
 * cron response for the record). */
async function laneGate(s: ScannedSetup): Promise<string | null> {
  // 1. TRADEABLE: must be listed on a real perp venue (Bybit/Binance/HL via CG
  //    derivatives). Micro-price contracts list under multiplier/kilo prefixes
  //    (1000BONK, 10000SATS, 1MBABYDOGE, Hyperliquid's kBONK) - all count for
  //    their base coin (loophole audit 2026-09-23).
  try {
    let listed = false;
    for (const pre of ["", "1000", "10000", "1M", "K"]) {
      if ((await venuesListing(`${pre}${s.symbol}`)).length > 0) { listed = true; break; }
    }
    if (!listed) return "no-perp-listing";
  } catch { return "no-perp-listing"; } // can't verify tradeable = not a signal
  // 2. STRUCTURE: one-touch zones dominated the losers - lanes demand >=2 touches.
  if ((s.zone_touches ?? 0) < 2) return "one-touch-zone";
  // 3. HTF ALIGNMENT: no longs under the daily SMA20, no shorts above it.
  //    Best-effort - a data gap skips the check rather than emptying the lane.
  try {
    let closes: number[] | null = null;
    if (s.network && s.pool) {
      const cs = await getPoolCandlesOrNull(s.network, s.pool, "1D");
      closes = cs && cs.length >= 20 ? cs.map((c) => c.close) : null;
    } else {
      const a = await getAsset(s.symbol, "1D").catch(() => null);
      closes = a && a.candles.length >= 20 ? a.candles.map((c) => c.close) : null;
    }
    if (closes) {
      const sma20 = closes.slice(-20).reduce((x, y) => x + y, 0) / 20;
      const px = closes[closes.length - 1];
      if (s.side === "long" && px < sma20) return "htf-downtrend";
      if (s.side === "short" && px > sma20) return "htf-uptrend";
    }
  } catch { /* best-effort */ }
  // 4. NEWS VETO from our own feed: a DUMP-impact story on the coin inside 24h
  //    vetoes a long, PUMP vetoes a short. Deterministic, no LLM. Loophole
  //    audit 2026-09-23: macro shocks are never asset-tagged to alts, but the
  //    whole market trades as BTC's beta - a fresh BTC DUMP story (12h) also
  //    vetoes any alt LONG.
  try {
    const cutoff = Date.now() - 24 * 3600_000;
    for (const n of await getNewsForAsset(s.symbol)) {
      if (n.timestamp < cutoff) continue;
      if (s.side === "long" && n.marketImpact === "DUMP") return "news-dump-veto";
      if (s.side === "short" && n.marketImpact === "PUMP") return "news-pump-veto";
    }
    if (s.side === "long" && s.symbol !== "BTC") {
      const btcCut = Date.now() - 12 * 3600_000;
      for (const n of await getNewsForAsset("BTC")) {
        if (n.timestamp >= btcCut && n.marketImpact === "DUMP") return "btc-dump-veto";
      }
    }
  } catch { /* best-effort */ }
  // 5. SMART MONEY (N1, Nansen): on-chain holder flow must not contradict the
  //    side. A long into >$250k of 24h net distribution (or a short into that
  //    much accumulation) is fighting the whales - skip it. Data gap = pass
  //    (the gate is a veto, never a dependency).
  try {
    if (s.tokenAddress && s.network) {
      const flows = await getTokenFlows(s.network, s.tokenAddress).catch(() => null);
      if (flows) {
        if (s.side === "long" && flows.netflowUsd < -250_000) return "sm-distribution-veto";
        if (s.side === "short" && flows.netflowUsd > 250_000) return "sm-accumulation-veto";
      }
    }
  } catch { /* best-effort */ }
  return null;
}

/** Walk candidates best-first, return the first that clears every gate. */
async function firstEligible(cands: ScannedSetup[], rejected: Array<{ symbol: string; reason: string }>): Promise<ScannedSetup | null> {
  for (const s of cands.sort((x, y) => score(y) - score(x)).slice(0, 6)) {
    const why = await laneGate(s);
    if (!why) return s;
    rejected.push({ symbol: s.symbol, reason: why });
  }
  return null;
}

