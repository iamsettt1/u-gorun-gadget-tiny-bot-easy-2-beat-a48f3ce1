// Tiny Bot — multi-asset trend + pullback system (agent-fun/bars-replay/v1).
//
// Idea: long-only trend following with strict risk control. Per symbol we track a
// fast/slow EMA pair on hourly closes and an EMA of absolute hourly returns as a
// volatility gauge. We buy when the trend is up (fast EMA above slow EMA) and the
// price has pulled back toward the fast EMA, or on a fresh fast-over-slow cross
// (half size). We exit on a trend flip, a volatility-scaled trailing stop, a hard
// stop, or a take-profit. In a downtrend the bot mostly sits in cash, which is
// exactly how it beats buy-and-hold; in an uptrend it rides the trend with
// pullback entries and lets winners run under a trailing stop.
//
// Fully deterministic: every decision is a pure function of the bars seen so far.
// No clock, no randomness, no network, no environment reads.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

// --- parameters (simple, regime-robust; not tuned to any single asset) ---
const FAST_N = 12; // fast EMA length (hours)
const SLOW_N = 26; // slow EMA length (hours)
const VOL_N = 14; // volatility EMA length
const MIN_BARS = SLOW_N; // bars of history before the first trade
const TARGET_W_BPS = 1000; // 10% of equity per pullback entry
const CROSS_W_BPS = 500; // 5% of equity per crossover entry (half size)
const PULLBACK_K = 0.5; // entry zone: close <= fast EMA * (1 + k * vol)
const STOP_K = 2.0; // trailing stop: peak * (1 - k * vol)
const HARD_STOP_K = 4.0; // hard stop: entry * (1 - k * vol)
const TAKE_PROFIT_K = 6.0; // take profit: entry * (1 + k * vol)
const VOL_FLOOR = 0.002; // 0.2% minimum hourly volatility (avoid div-by-zero / hair triggers)
const COOLDOWN_BARS = 6; // bars to wait before re-entering a symbol after an exit
const MAX_SLIPPAGE_BPS = 50; // bound vs latest close; modelled slippage is 5 bps, impact tiny

interface SymState {
  closes: number[]; // closes as floats (ratios only; scale cancels)
  emaFast: number;
  emaSlow: number;
  vol: number; // EMA of |hourly return|
  bars: number;
  entry: number | null; // fill price of the open position (float close units)
  peak: number; // highest close since entry
  lastExitSeq: number;
}

const syms = new Map<string, SymState>();

function getSym(symbol: string): SymState {
  let s = syms.get(symbol);
  if (s === undefined) {
    s = {
      closes: [],
      emaFast: NaN,
      emaSlow: NaN,
      vol: 0,
      bars: 0,
      entry: null,
      peak: 0,
      lastExitSeq: -1_000_000,
    };
    syms.set(symbol, s);
  }
  return s;
}

function emaUpdate(prev: number, x: number, n: number): number {
  const k = 2 / (n + 1);
  return prev + k * (x - prev);
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Learn fill prices from the previous bar's fills so stops use real entries.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      const s = getSym(f.symbol);
      if (f.side === 'buy') {
        s.entry = Number(f.price);
        s.peak = Number(f.price);
      } else if (f.side === 'sell') {
        s.entry = null;
        s.peak = 0;
        s.lastExitSeq = state.seq;
      }
    }

    // Update indicators from this batch's bars, remembering pre-update EMAs
    // so a fresh fast-over-slow cross can be detected.
    const prevEma = new Map<string, { fast: number; slow: number }>();
    for (const bar of batch.bars) {
      const s = getSym(bar.symbol);
      prevEma.set(bar.symbol, { fast: s.emaFast, slow: s.emaSlow });
      const c = Number(bar.c);
      const prev = s.closes.length > 0 ? s.closes[s.closes.length - 1] : c;
      s.closes.push(c);
      s.bars++;
      if (s.bars === 1) {
        s.emaFast = c;
        s.emaSlow = c;
        s.vol = 0;
      } else {
        const ret = Math.abs(c / prev - 1);
        s.emaFast = emaUpdate(s.emaFast, c, FAST_N);
        s.emaSlow = emaUpdate(s.emaSlow, c, SLOW_N);
        s.vol = emaUpdate(s.vol, ret, VOL_N);
      }
      if (s.entry !== null && c > s.peak) s.peak = c;
    }

    if (state.warmingUp) return [];
    if (state.seq < MIN_BARS) return [];

    const out: Array<{ side: 'buy' | 'sell'; symbol: string; notional_quote_units?: bigint; qty?: bigint; max_slippage_bps: number }> = [];

    // Exits first: free risk before considering new entries.
    for (const bar of batch.bars) {
      const s = getSym(bar.symbol);
      const held = state.positions.get(bar.symbol);
      if (held === undefined || s.entry === null) continue;
      const c = Number(bar.c);
      const v = Math.max(s.vol, VOL_FLOOR);
      const trendFlip = s.emaFast < s.emaSlow;
      const trailStop = c < s.peak * (1 - STOP_K * v);
      const hardStop = c < s.entry * (1 - HARD_STOP_K * v);
      const takeProfit = c > s.entry * (1 + TAKE_PROFIT_K * v);
      if (trendFlip || trailStop || hardStop || takeProfit) {
        out.push({ side: 'sell', symbol: bar.symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }

    // Entries: only symbols we do not already hold (and are not exiting this bar).
    const exiting = new Set(out.filter((o) => o.side === 'sell').map((o) => o.symbol));
    for (const bar of batch.bars) {
      const sym = bar.symbol;
      if (state.positions.has(sym) || exiting.has(sym)) continue;
      if (state.positions.size + out.filter((o) => o.side === 'buy').length >= state.hello.caps.max_open_positions) continue;
      const s = getSym(sym);
      if (s.bars < MIN_BARS) continue;
      if (state.seq - s.lastExitSeq < COOLDOWN_BARS) continue;
      const c = Number(bar.c);
      const v = Math.max(s.vol, VOL_FLOOR);
      const uptrend = s.emaFast > s.emaSlow;
      if (!uptrend) continue;
      const prev = prevEma.get(sym);
      const crossed = prev !== undefined && !Number.isNaN(prev.fast) && prev.fast <= prev.slow && s.emaFast > s.emaSlow;
      const pulledBack = c <= s.emaFast * (1 + PULLBACK_K * v) && c > s.emaSlow;
      let wBps: number | null = null;
      if (pulledBack) wBps = TARGET_W_BPS;
      else if (crossed) wBps = CROSS_W_BPS;
      if (wBps === null) continue;
      // Size in quote units: wBps of equity, capped by cash and the weight cap.
      // (A sell decided this same reply never funds a buy, so size from cash only.)
      const target = (state.equity * BigInt(wBps)) / 10_000n;
      const room = state.weightRoom(sym);
      let spend = target < room ? target : room;
      if (spend > state.cash) spend = state.cash;
      const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
      if (spend < minNotional * 2n) continue;
      out.push({ side: 'buy', symbol: sym, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }

    return out;
  },
});
