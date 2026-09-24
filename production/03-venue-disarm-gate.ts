// FROM: lib/fast-ta.ts (live)
// The disarm. Computed ONLY for an account that can fire the order it gates -
// /smart-money/perp-trades is no-redistribution tier and the policy extends to
// derived data, so this one word never reaches anyone else.

      // HYPERLIQUID SIDE AGREEMENT (2026-09-24): if this coin has an HL perp,
      // ask Nansen which way smart money is positioned ON THAT VENUE, and let
      // it gate the trade button. Verdict only - the data is never rendered.
      // OWNER-ONLY (2026-09-24 compliance pass): /smart-money/perp-trades is
      // in Nansen's NO-REDISTRIBUTION tier, and their guide extends that to
      // DERIVED data. So this verdict is computed only for an account that can
      // actually fire the order it gates, never serialized to anyone else, and
      // never sent to a third party. It gates a button; it is not content.
      if (ctx.ownerView && taCard.hlMaxLev !== null && taCard.entryLo !== null && taCard.sl !== null && taCard.tps.length > 0) {
        const bias = await Promise.race([
          getPerpBias(sym).catch(() => null),
          new Promise<null>((r) => setTimeout(() => r(null), 5000)),
        ]).catch(() => null);
        if (bias && bias.bias !== "balanced") {
          const side = taCard.tps[0] >= (taCard.entryHi ?? taCard.entryLo ?? 0) ? "long" : "short";
          taCard.perpBias = {
            bias: bias.bias,
            opposes: (side === "long" && bias.bias === "net short") || (side === "short" && bias.bias === "net long"),
          };
        }
      }
