// FROM: lib/fast-ta.ts and components/ChatView.tsx (live)
// The disarm. Computed ONLY for an account that can fire the order it gates -
// /smart-money/perp-trades is no-redistribution tier and the policy extends to
// derived data. The one word is shown only to the owner, in the disarm banner,
// is kept in the owner's own chat history, and is never sent to a third party.
//
// The read runs through nansenStep (quoted first), so the office robot visits
// the NANSEN desk only if the read really happens (see 05-office-nansen-events.ts).
// In the live file the disarm sits inside the TA card's Jev decision-check block,
// which is left out here. The last section is the card's button: an opposing
// read replaces "Trade on Hyperliquid" with the reason, plus an override.
//
// Reference only: imports from the app, not runnable standalone. Code between
// the section markers is verbatim; "// ..." marks lines left out.

/* ═══ lib/fast-ta.ts ═════════════════════════════════════════════════════ */

/** Nansen reads: the desk is visited only when a read REALLY happens inside
 *  `run` (lib/nansen-watch.ts: a request actually going out, or real cached
 *  data coming back) - a cooldown, missing key, uncovered chain or slow cache
 *  miss reports nothing. `run` must START the reads (a thunk, not a promise). */
const nansenStep = <T,>(run: () => Promise<T>, step: (e: OfficeEvent) => void, e: OfficeEvent) =>
  withNansenStart(run, () => step(e));

// ...

      // HYPERLIQUID SIDE AGREEMENT (2026-09-24): if this coin has an HL perp,
      // ask Nansen which way smart money is positioned ON THAT VENUE, and let
      // it gate the trade button. Verdict only - the data is never rendered.
      // OWNER-ONLY (2026-09-24 compliance pass): /smart-money/perp-trades is
      // in Nansen's NO-REDISTRIBUTION tier, and their guide extends that to
      // DERIVED data. So this verdict is computed only for an account that can
      // actually fire the order it gates, never serialized to anyone else, and
      // never sent to a third party. It gates a button; it is not content.
      if (ctx.ownerView && taCard.hlMaxLev !== null && taCard.entryLo !== null && taCard.sl !== null && taCard.tps.length > 0) {
        const bias = await nansenStep(() => Promise.race([
          getPerpBias(sym).catch(() => null),
          new Promise<null>((r) => setTimeout(() => r(null), 5000)),
        ]).catch(() => null), step, STEP.nansenBias);
        if (bias && bias.bias !== "balanced") {
          const side = taCard.tps[0] >= (taCard.entryHi ?? taCard.entryLo ?? 0) ? "long" : "short";
          taCard.perpBias = {
            bias: bias.bias,
            opposes: (side === "long" && bias.bias === "net short") || (side === "short" && bias.bias === "net long"),
          };
        }
      }

/* ═══ components/ChatView.tsx: the button ════════════════════════════════ */

          ) : card.perpBias?.opposes && !sheet ? (
            // DISARMED (2026-09-24): smart money on the execution venue is
            // positioned against this trade. The button states why instead of
            // firing - a refusal with a reason beats a click you regret.
            <div className="space-y-2">
              <div className="rounded-lg bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
                Trade disarmed: smart money on Hyperliquid is {card.perpBias.bias} this coin, against your {side.toUpperCase()}. Powered by Nansen API.
              </div>
              <button onClick={() => setSheet(true)} className="text-[11px] text-tv-muted underline hover:text-tv-text">
                Override and trade anyway
              </button>
              {sheet && <div className="text-[10px] text-tv-muted">Overridden - the order below is yours, not the agent&apos;s.</div>}
            </div>
          ) : !sheet ? (
            <button onClick={() => setSheet(true)} className="h-9 w-full rounded-lg bg-tv-accent text-[13px] font-semibold text-white transition-opacity hover:opacity-90 sm:w-auto sm:px-6">
              {card.orderType === "parked limit" || card.orderType === "breakout stop" ? "Park this order on Hyperliquid" : "Trade on Hyperliquid"}
            </button>
          // ...
