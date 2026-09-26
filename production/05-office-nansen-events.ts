// FROM: lib/nansen-watch.ts, lib/api/nansen.ts, lib/agent-run.ts and
// app/api/chat/route.ts (live on getswenai.com, the office shipped 2026-09-26)
//
// The office: the Ask screen is a voxel trading desk, and the Swenai robot walks
// to the station of every REAL tool the agent uses. The NANSEN station is only
// visited when a real Nansen read happens inside this answer: a request really
// going out, or real Nansen data coming back from the cache. Never from a timer,
// never because a tool with "smart money" in its name started.
//
// The office adds AT MOST ONE real, cached Nansen read of its own to each answer
// (on top of any reads the agent's tools make), in parallel with the answer and
// never fed into it. There is none for a
// rate-limited ask, with no key, during a cooldown or outside the office screen,
// and an empty token read does not fall back. Event labels are fixed strings: no
// rows, no wallet labels, no numbers ever reach the page through this channel.
//
// Reference only: imports from the app, not runnable standalone. Code between
// the section markers is verbatim; "// ..." marks lines left out.

/* ═══ lib/nansen-watch.ts (complete except its header comment) ═════════════ */

import { AsyncLocalStorage } from "node:async_hooks";

const watch = new AsyncLocalStorage<() => void>();

/** The adapter's hook: a real Nansen read is happening in the current async
 *  scope. A no-op outside a watched scope; never throws. */
export function nansenHappened(): void {
  const f = watch.getStore();
  if (f) { try { f(); } catch { /* the office is theatre, never an error */ } }
}

/**
 * Run `run` and call `onStart` AT MOST ONCE, and only when a Nansen read really
 * happens inside it (see the header). Nested scopes also notify the outer one.
 * The result (or rejection) of `run` passes through unchanged.
 */
export function withNansenStart<T>(run: () => Promise<T>, onStart: () => void): Promise<T> {
  const parent = watch.getStore();
  let fired = false;
  const hit = () => {
    if (parent) { try { parent(); } catch { /* theatre only */ } }
    if (fired) return;
    fired = true;
    try { onStart(); } catch { /* the office is theatre, never an error */ }
  };
  return watch.run(hit, run);
}

/* ═══ lib/api/nansen.ts: the only two places the signal fires ══════════════ */

let cooldownUntil = 0;
async function post<T>(path: string, body: Record<string, unknown>, timeoutMs = 10000): Promise<T | null> {
  const k = key();
  if (!k) return null;
  if (Date.now() < cooldownUntil) return null;
  // COST FUSE (2026-09-24): premium-label endpoints cost 150-500 credits per
  // call - 100x a normal read - and sit in Nansen's never-redistribute tier.
  // Make them structurally unreachable from this codebase rather than trusting
  // future callers to remember.
  if (path.includes("premium-labels") || JSON.stringify(body).includes("premium_labels")) return null;
  nansenHappened(); // office (lib/nansen-watch.ts): a real call is going out NOW
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: k },
      body: JSON.stringify(body),
      cache: "no-store", // caching happens at the wrapper layer, deliberately
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      void trackFail("nansen");
      if (res.status === 429 || res.status === 402 || res.status >= 500) cooldownUntil = Date.now() + 60_000;
      return null;
    }
    void trackCall("nansen");
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

// ...

async function cachedOrNull<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    const v = await fn();
    nansenHappened(); // office: real Nansen data reached this answer (a cache hit counts)
    return v;
  } catch (e) {
    if ((e as Error)?.message !== MISS) void e;
    return null;
  }
}

/* ═══ lib/api/nansen.ts: always-Nansen, the office's one cached read ══════ */

/* ── ALWAYS-NANSEN + OFFICE HONESTY (2026-09-25, office v2) ───────────────────
 * Joseph's rule for the office: "the robot always goes to NANSEN" - implemented
 * HONESTLY: every answer makes one REAL, cached Nansen read, and the robot only
 * visits the Nansen desk when that read really happens.
 *  - Never injected into the agent prompt: answers are unchanged by design.
 *  - Credit bound: at most ONE 1-credit read per answer, and both reads are
 *    cached (token flow intelligence 15 min per token, the market-wide pulse
 *    10 min - one global key, so <= 6 pulse credits/hour whatever the traffic).
 *  - Respects the cooldown and the cost fuse in post(): cooling down = no read
 *    and NO event.
 *  - The office event comes from lib/nansen-watch.ts: fired by post() right
 *    before a request really goes out, or when a read returns real (cached)
 *    Nansen data - never from a timer or a tool's name.
 *  ...
 */

/** True when a real Nansen call can go out right now (key set, not cooling down). */
export function nansenLive(): boolean {
  return !!key() && Date.now() >= cooldownUntil;
}

// ...

/**
 * ONE real Nansen read per answer, run in PARALLEL with the answer and bounded
 * by `timeoutMs` (it never adds latency: callers do not await it for anything
 * the answer needs). A crypto subject with a liquid, price-matching DEX market
 * gets that token's flow intelligence (1 credit, 15 min cache); anything else
 * gets the market-wide smart-money pulse (1 credit, 10 min cache, shared with
 * the sweep and the signal lane). `onStart(label)` fires only when the read
 * really happens (lib/nansen-watch.ts). Returns which read ran, or null.
 *
 * CLONE GUARD (review 2026-09-25, finding 3): with a live price, any covered,
 * liquid pool within 25% of it qualifies. WITHOUT one, only the deepest liquid
 * pool does - walking down the list past an uncovered chain (HYPE's real pool
 * is on hyperevm) is how a same-symbol clone on base/ethereum got the credit.
 */
export async function alwaysNansenRead(
  subject: AlwaysNansenSubject,
  onStart: (label: string) => void,
  timeoutMs = 6000,
): Promise<"token" | "pulse" | null> {
  if (!nansenLive()) return null; // cooling down / no key: no read, no event - never faked
  const bounded = <T,>(p: Promise<T | null>, ms: number) =>
    Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);
  const t0 = Date.now();
  try {
    let cand: { chain: string; tokenAddress: string } | null = null;
    if (subject.symbol && subject.crypto) {
      const q = FLOW_ALIAS[subject.symbol.toUpperCase()] ?? subject.symbol;
      const pools = ((await bounded(resolveDexPools(q), Math.min(3000, timeoutMs))) ?? [])
        .filter((x) => x.liq >= 250_000 && !!x.tokenAddress);
      const live = subject.livePrice ?? 0;
      const c = live > 0
        ? pools.find((x) => nansenChain(x.chain) !== null && x.priceUsd > 0 && Math.abs(x.priceUsd - live) / live <= 0.25)
        : pools.slice(0, 1).find((x) => nansenChain(x.chain) !== null);
      if (c?.tokenAddress && !flowMissed(`${c.chain}:${c.tokenAddress}`)) cand = { chain: c.chain, tokenAddress: c.tokenAddress };
    }
    const left = Math.max(1000, timeoutMs - (Date.now() - t0));
    if (cand) {
      const { chain, tokenAddress } = cand;
      const k = `${chain}:${tokenAddress}`;
      let called = false, settledEmpty = false;
      const got = await withNansenStart(
        () => bounded(getCohortFlow(chain, tokenAddress).then((v) => { if (!v) settledEmpty = true; return v; }), left),
        () => { called = true; onStart("Token flow intelligence"); },
      );
      if (got) return "token";
      // a REAL call answered with nothing (not a timeout, not a throttle): skip this token for a while
      if (called && settledEmpty && nansenLive()) markFlowMiss(k);
      return null;
    }
    const board = await withNansenStart(() => bounded(getDivergenceBoard(10), left), () => onStart("Smart-money pulse"));
    return board ? "pulse" : null;
  } catch {
    return null;
  }
}

/* ═══ lib/agent-run.ts: an agent tool visits NANSEN only if it really reads ═ */

    const toolResults = await Promise.all(calls.map(async (tc) => {
      // ...
      emit(toolEvent(tc.function.name)); // AFTER the skip check: a skipped tool never reaches the office
      // ...
      // Nansen tools visit the Nansen desk only when a Nansen read REALLY
      // happens inside them (lib/nansen-watch.ts) - never just because they ran.
      const nansenE = opts.onEvent ? nansenToolEvent(tc.function.name) : null;
      const exec = () => runTool(tc.function.name, args, collected);
      const out = await withTimeout(nansenE ? withNansenStart(exec, () => emit(nansenE)) : exec(), toolMs, { error: "tool timed out" });
      return { id: tc.id, content: JSON.stringify(out).slice(0, 4000) };
    }));

/* ═══ app/api/chat/route.ts: wiring the read into the office event stream ══ */

  // ALWAYS-NANSEN (office v2, lib/api/nansen.ts alwaysNansenRead): every answer
  // makes ONE real, cached Nansen read, in PARALLEL (it never gates or feeds the
  // answer - nothing from it reaches the prompt), bounded by a short timeout,
  // and it reports to the office only when the read really happens. Skipped for
  // a rate-limited ask (no answer = no read, and no cost-DoS via the limiter).
  // OFFICE ONLY (ev:1): the read exists so the robot's Nansen visit is real;
  // the classic page has no robot, so it would spend credits nobody sees.
  if (!limitMessage && ev === 1) {
    const nansenP = (async () => {
      try {
        const qHead = question.split(/\n\n\[/)[0];
        const sym = extractTaSymbol(question) ?? namedUntrackedTicker(qHead);
        const cls = sym ? ASSET_MAP[sym]?.assetClass : undefined;
        // tracked crypto, or an untracked ticker (a DEX coin until proven otherwise)
        const crypto = !!sym && (cls === "crypto" || cls === undefined);
        await alwaysNansenRead({ symbol: sym, crypto, livePrice: nansenLivePrice }, (l) => office.emit({ s: "nansen", l }));
      } catch { /* the office is theatre, never an error */ }
    })();
    // keep the bounded read alive past a fast answer (it warms the cache either way)
    try { after(() => nansenP); } catch { /* outside a request scope: fire-and-forget */ }
  }
