// FROM: app/api/nansen-sweep/route.ts (live, Vercel cron every 20 min)
// Warms caches so user-facing analysis is instant, and snapshots flow history
// because /tgm/historical-* 404s on this plan - our snapshots ARE the history,
// and history cannot be backfilled after a signal has already fired.

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!process.env.NANSEN_API_KEY) return NextResponse.json({ skipped: "no key" });
  try {
    // 1. Universe: live-signal coins + trending + majors, deduped.
    const { data: openRows } = await supabaseAdmin
      .from("ta_setups")
      .select("symbol")
      .eq("source", "signal")
      .in("status", ["open", "filled"]);
    const universe = [...new Set([
      ...(openRows ?? []).map((r) => String(r.symbol).toUpperCase()),
      ...(await getTrendingSymbols(10).catch(() => [])).map((t) => t.symbol),
      "BTC", "ETH", "SOL", "HYPE",
    ])].filter((s) => /^[A-Z0-9]{2,12}$/.test(s));
    if (!universe.length) return NextResponse.json({ swept: 0, note: "empty universe" });

    // 2. Rotating cursor so every tick covers the NEXT slice (and the whole
    //    universe gets refreshed over the hour) instead of re-warming the top.
    let cursor = 0;
    try {
      const { data } = await supabaseAdmin.from("app_settings").select("value").eq("key", CURSOR_KEY).maybeSingle();
      cursor = Number(data?.value) || 0;
    } catch { /* first run */ }
    const slice: string[] = [];
    for (let i = 0; i < Math.min(PER_TICK, universe.length); i++) slice.push(universe[(cursor + i) % universe.length]);
    const nextCursor = (cursor + slice.length) % universe.length;
    try {
      await supabaseAdmin.from("app_settings").upsert({ key: CURSOR_KEY, value: String(nextCursor) }, { onConflict: "key" });
    } catch { /* cursor is an optimisation, not a requirement */ }

    // 3. Sweep the slice. Serialized on purpose: the smart-money family's
    //    observed rate limit is the tightest in the API (15/s).
    const swept: Array<{ symbol: string; verdict: string | null; netUsd: number | null }> = [];
    const snapshots: Array<Record<string, unknown>> = [];
    for (const sym of slice) {
      try {
        const q = FLOW_ALIAS[sym] ?? sym;
        const cand = (await resolveDexPools(q).catch(() => []))
          .filter((c) => c.liq >= 250_000 && c.tokenAddress)[0];
        if (!cand) { swept.push({ symbol: sym, verdict: null, netUsd: null }); continue; }
        const [cohort, flows] = await Promise.all([
          getCohortFlow(cand.chain, cand.tokenAddress!).catch(() => null),
          getTokenFlows(cand.chain, cand.tokenAddress!).catch(() => null),
        ]);
        swept.push({
          symbol: sym,
          verdict: cohort?.verdict ?? null,
          netUsd: flows ? Math.round(flows.netflowUsd) : null,
        });
        if (cohort || flows) {
          snapshots.push({
            symbol: sym,
            chain: cand.chain,
            token_address: cand.tokenAddress,
            score: {
              verdict: cohort?.verdict ?? null,
              smartNetUsd: cohort ? Math.round(cohort.smartNetUsd) : null,
              freshNetUsd: cohort ? Math.round(cohort.freshNetUsd) : null,
              netflowUsd: flows ? Math.round(flows.netflowUsd) : null,
              cohorts: cohort?.cohorts.map((c) => ({ k: c.key, net: Math.round(c.netUsd), w: c.wallets })) ?? null,
            },
          });
        }
      } catch { /* next symbol */ }
    }

    // 4. Refresh the divergence board once per tick (1 credit) so the hourly
    //    signal lane and the agent tool both read a warm list.
    const board = await getDivergenceBoard(10).catch(() => null);

    // 5. Persist snapshots - self-activating (missing table = silent no-op).
    let stored = 0;
    if (snapshots.length) {
      const { error } = await supabaseAdmin.from("nansen_snapshots").insert(snapshots);
      if (!error) stored = snapshots.length;
    }

    return NextResponse.json({
      swept: slice.length, cursor: nextCursor, universe: universe.length,
      stored, divergence: board?.length ?? 0, detail: swept,
    });
  } catch (e) {
    void logError("tool", "nansen-sweep-failed", e instanceof Error ? e : new Error(String(e)), {});
    return NextResponse.json({ error: "sweep failed" }, { status: 500 });
  }
}
