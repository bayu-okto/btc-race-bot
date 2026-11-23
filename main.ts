// BTC trend rider for make.fun "Race a BTC trading bot live for 24 hours".
//
// Strategy (long only, one asset CBBTC, one open position at most):
//   - Buy 100% of cash on the first tradeable bar, then hold.
//   - Trailing stop: sell everything when the close falls 2% below the highest
//     close seen since entry (the peak ratchets up while long).
//   - Re-enter (buy 100%) when the close makes a new high above the previous
//     peak (the high-water mark from before the stop-out) plus a small buffer.
//   - Nothing else trades. Few round trips, so the ~26 bps round-trip cost
//     (4 bps fee + 2 bps slippage + ~7 bps impact each way) is paid rarely.
//
// Why this shape: on 1-minute bars BTC is noisy (about 8 bps of 1-minute
// volatility in the dev window), so fast trend signals (EMA 8/21, Donchian)
// whipsaw dozens of times and bleed the 26 bps round-trip cost on every
// flip. The dev window rose 3.6% with a max drawdown under 2%, so a plain
// buy-and-hold nets about +$32; a 2% trailing stop keeps that whole gain on
// the dev window (it never triggers there) while capping a falling window
// near -2% instead of riding it to the bottom. The re-entry on a new high
// lets the bot ride a recovery instead of sitting in cash after one dip.
//
// Deterministic: no clock, no environment, no randomness. All decisions use
// only the bars the harness sends (closes) and the account it reports.
// Arithmetic on closes uses bigint cross-multiplication, so the same bars
// give the same orders on every run.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Trailing stop: exit when the close is this far below the peak since entry. */
const TRAIL_BPS = 200n; // 2%
/** Re-entry: buy when the close is this far above the previous peak. */
const REENTRY_BPS = 10n; // 0.1%
/** Slippage cap on every order, measured from the latest close (max 1-min move on dev: 72 bps). */
const MAX_SLIPPAGE_BPS = 200; // 2%
const BPS = 10_000n;

/** Highest close seen while long (the peak the trailing stop hangs from). */
let peak: bigint | null = null;

await runBars({
  onBatch(state: BarsState, batch) {
    if (state.warmingUp) return [];
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    const held = state.positions.get(SYMBOL);
    const orders: (BuyInput | SellInput)[] = [];

    if (held !== undefined) {
      // Long: ratchet the peak up, exit on the trailing stop.
      if (peak === null || close > peak) peak = close;
      // close < peak * (1 - TRAIL_BPS/10000)  <=>  close * 10000 < peak * (10000 - TRAIL_BPS)
      if (close * BPS < peak * (BPS - TRAIL_BPS)) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        // peak is kept as the high-water mark for the re-entry test.
      }
    } else {
      // Flat: enter on the first bar, or on a new high above the previous peak.
      if (peak === null) {
        // First bar: buy 100% of cash.
        const cash = state.cash;
        if (cash > 0n) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
          peak = close;
        }
      } else if (close * BPS > peak * (BPS + REENTRY_BPS)) {
        // New high above the old peak: re-enter, peak resets to this close.
        const cash = state.cash;
        if (cash > 0n) {
          orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS });
          peak = close;
        }
      }
    }
    return orders;
  },
});
