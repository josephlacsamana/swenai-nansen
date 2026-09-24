// FROM: app/api/signals-gen/route.ts (live)
// Nansen SOURCES signals here rather than only filtering them: the screener
// finds smart money buying into weakness, then those candidates face the SAME
// five quality gates as every other lane. On-chain proposes, TA disposes.

    // DIVERGENCE LANE (2026-09-24, Nansen-SOURCED rather than Nansen-vetoed):
    // Nansen's screener finds tokens where smart money is a net BUYER while
    // price is DOWN - accumulation into weakness, the one query a chart-only
    // product cannot run. Those candidates then face the SAME deterministic
    // zone engine and the same five gates as every other lane: on-chain flow
    // proposes, our TA disposes, so a "whales are buying" story never becomes
    // a signal without a structural setup behind it.
    if (!occupied.has("divergence")) {
      const candidates: ScannedSetup[] = [];
      const board = (await getDivergenceBoard(10).catch(() => [])) ?? [];
      for (const hit of board) {
        if (hit.symbol === "BTC" || openSyms.has(hit.symbol)) continue;
        try {
          if (ASSET_MAP[hit.symbol]) {
            const a = await getAsset(hit.symbol, "4h").catch(() => null);
            if (a && a.candles.length >= 40) candidates.push(...buildSetups(a.candles, a.price, { symbol: hit.symbol, universe: "major", tf: "4h", price: a.price }));
          } else {
            const cand = (await resolveDexPools(hit.symbol).catch(() => [])).filter((c) => c.liq >= 250_000 && c.vol >= 100_000)[0];
            if (cand) {
              const net = gtNetwork(cand.chain);
              const cs = await getPoolCandlesOrNull(net, cand.pool, "1h").catch(() => null);
              if (cs && cs.length >= 40) candidates.push(...buildSetups(cs, cand.priceUsd, { symbol: hit.symbol, universe: "memecoin", tf: "1h", price: cand.priceUsd, network: net, pool: cand.pool, tokenAddress: cand.tokenAddress ?? undefined }));
            }
          }
        } catch { /* next divergence hit */ }
      }
      // Longs only: the whole thesis of this lane is smart money BUYING.
      const best = await firstEligible(candidates.filter((c) => c.side === "long"), rejected);
      if (best) await emit("divergence", best); else skipped.push("divergence");
    }

