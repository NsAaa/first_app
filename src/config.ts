import dotenv from 'dotenv';
dotenv.config();

// ─── Wallet ───────────────────────────────────────────────────────────────────
export const WALLET_PRIVATE_KEY_BASE64 = process.env.WALLET_PRIVATE_KEY_BASE64 || '';
export const WALLET_PUBLIC_KEY = process.env.WALLET_PUBLIC_KEY || '5F8LCzTyzMb72QmbyzLrE1zkKr6nbqfA8udLV7WhfrEA';

// ─── RPC ──────────────────────────────────────────────────────────────────────
export const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// ─── Telegram ─────────────────────────────────────────────────────────────────
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

// ─── Mode ─────────────────────────────────────────────────────────────────────
export const DRY_RUN = process.env.DRY_RUN !== 'false'; // default true
// SCAN_MODE: 'established' | 'new' | 'both' | 'sniper'
// 'established' = only trade tokens 24h+ with $1M+ liquidity
// 'new'         = only trade new tokens 4-24h with relaxed filters
// 'both'        = established + new tiers
// 'sniper'      = brand new tokens 0-2h, trailing stop only, no fixed TP
export const SCAN_MODE = (process.env.SCAN_MODE || 'new') as 'established' | 'new' | 'both' | 'sniper';

// ─── Sniper Tier ──────────────────────────────────────────────────────────────
export const SNIPER_MAX_AGE_HOURS = 2;           // tokens under 2h old
export const SNIPER_MIN_AGE_MINUTES = 45;        // must be at least 45 min old (skip first chaotic candles)
export const SNIPER_MIN_LIQUIDITY_USD = 5_000;   // $5k minimum liquidity
export const SNIPER_MIN_VOLUME_USD = 5_000;      // $5k minimum volume
export const SNIPER_TRAIL_PCT = 0.10;            // 10% trailing stop from highest price seen
export const SNIPER_MAX_MCAP_USD = 10_000_000;   // max $10M mcap (true micro caps)
// Consolidation check: token must be "settling" not mid-pump or mid-dump
export const SNIPER_MAX_5M_CHANGE_PCT = 5;       // 5min price change must be < ±5% (consolidating)
export const SNIPER_CONSOLIDATION_WINDOW = 0.05; // price change threshold for consolidation

// ─── Capital & Risk ───────────────────────────────────────────────────────────
export const STARTING_CAPITAL_USD = 500;
export const MAX_POSITION_SIZE_USD = 20;             // $20 per trade
export const MAX_SIMULTANEOUS_POSITIONS = 6;         // 6 total (3 per tier max)
export const MAX_POSITIONS_PER_TIER = 3;             // max 3 established, max 3 new token
export const PORTFOLIO_STOP_LOSS_USD = 250;          // -50% of $500 starting capital

// ─── Execution ────────────────────────────────────────────────────────────────
export const SLIPPAGE_BPS = 100;               // 1% default
export const MAX_SLIPPAGE_BPS = 200;           // 2% max
export const JUPITER_QUOTE_URL = 'https://lite-api.jup.ag/swap/v1/quote';
export const JUPITER_SWAP_URL = 'https://lite-api.jup.ag/swap/v1/swap';
// Note: Jupiter price API requires paid key — using DexScreener + Birdeye instead

// ─── Price Data Sources ───────────────────────────────────────────────────────
export const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex';
export const BIRDEYE_API_URL = 'https://public-api.birdeye.so/defi/price';
// Get a free Birdeye API key at https://birdeye.so/api → set BIRDEYE_API_KEY in .env

// ─── Token Mints ──────────────────────────────────────────────────────────────
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

// ─── Scanner Filters (Established Tier) ──────────────────────────────────────
export const MIN_LIQUIDITY_USD = 1_000_000;    // $1M liquidity minimum
export const MIN_TOKEN_AGE_HOURS = 24;         // established tokens: 24h+ old
export const MIN_BUY_VOLUME_4H_USD = 100_000;  // minimum buy volume in 4h
export const MIN_VOLUME_24H_USD = 500_000;     // minimum 24h volume

// ─── Scanner Filters (New Token Tier) ────────────────────────────────────────
export const NEW_TOKEN_MAX_AGE_HOURS = 24;     // new tokens: 2-24h old
export const NEW_TOKEN_MIN_AGE_HOURS = 4;      // must be at least 4h old (gives pump-dump cycle time to complete)
export const NEW_TOKEN_MIN_LIQUIDITY_USD = 10_000;   // $10k liquidity (pump.fun tokens are thin)
export const NEW_TOKEN_MIN_VOLUME_24H_USD = 10_000;  // $10k volume minimum
export const NEW_TOKEN_MIN_BUY_VOLUME_4H_USD = 2_000; // $2k 4h buy volume

// ─── New Token Rug Checks ─────────────────────────────────────────────────────
export const MIN_BUY_TX_COUNT = 50;            // minimum unique buy transactions (low = whale-only = rug risk)
export const MIN_BUY_SELL_RATIO = 1.2;         // buys must outnumber sells by 20% for new tokens
export const MIN_LIQUIDITY_MCAP_RATIO = 0.01;  // liquidity must be ≥1% of market cap (pump.fun tokens are naturally thin)
export const MAX_NEW_TOKEN_MCAP_USD = 50_000_000; // new tokens must be <$50M mcap

// ─── Tiered TP/SL ────────────────────────────────────────────────────────────
// Established tokens (age ≥ 24h): slower moves, wider stops
export const STOP_LOSS_PCT = 0.15;             // -15%
export const TAKE_PROFIT_PCT = 0.30;           // +30%
// New tokens (2h–24h): faster moves, tighter exits
export const NEW_TOKEN_STOP_LOSS_PCT = 0.10;   // -10% (cut faster)
export const NEW_TOKEN_TAKE_PROFIT_PCT = 0.20; // +20% (take gains before dump)

// ─── Anti-Chasing Filters ─────────────────────────────────────────────────────
// Prevent buying the top — if a token has pumped too much recently, skip it.
export const MAX_PRICE_CHANGE_1H_PCT = 30;     // skip if up >30% in last 1h (already pumped)
export const MIN_VOLUME_TREND_RATIO = 0.3;     // 1h volume must be ≥30% of hourly average (fading momentum = skip)
// Minimum volatility — skip tokens that can't realistically hit TP
// BTC/cbBTC/WBTC rarely move >10% in 24h, so TP of 20-30% is unrealistic
export const MIN_PRICE_CHANGE_24H_PCT = 5;     // token must have moved ≥5% in last 24h (established tier only — blocks BTC/cbBTC, allows most alts)

// ─── New Token Recovery Filter ────────────────────────────────────────────────
// Ensures new tokens are in recovery/accumulation phase, not mid-dump.
export const NEW_TOKEN_MIN_1H_CHANGE_PCT = 0;   // 1h change must be ≥0% (not actively dumping)
export const NEW_TOKEN_MAX_DROP_FROM_6H_PCT = 60; // skip if down >60% from 6h high (rug/heavy dump)

// ─── New Token Entry Quality Filters ─────────────────────────────────────────
// Option 1: Require pullback from recent high before entry (avoid chasing tops)
export const NEW_TOKEN_MIN_PULLBACK_PCT = 5;    // token must have pulled back ≥5% from its recent peak
export const NEW_TOKEN_MAX_PULLBACK_PCT = 30;   // but not more than 30% (that's a dump, not a pullback)
// Option 2: Volume acceleration — current 1h volume must exceed hourly average
// (entering on rising volume = momentum building, not fading)
export const NEW_TOKEN_MIN_VOL_ACCEL_RATIO = 1.2; // 1h volume must be ≥1.2x the hourly average

// ─── Cooldown ─────────────────────────────────────────────────────────────────
export const TOKEN_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h cooldown after close (stop or TP)

// ─── Near-TP Trailing Stop ────────────────────────────────────────────────────
// Once price gets within NEAR_TP_THRESHOLD of take profit, activate trailing stop.
// If price then drops NEAR_TP_TRAIL_PCT from the peak, close and lock in gains.
export const NEAR_TP_THRESHOLD = 0.10;    // activate when within 10% of TP price (widened from 5%)
export const NEAR_TP_TRAIL_PCT = 0.04;    // close if price drops 4% from peak in near-TP zone

// ─── High Watermark Trailing Stop ────────────────────────────────────────────
// Once a position gains HIGH_WATERMARK_ACTIVATE, track peak and close if it
// drops HIGH_WATERMARK_TRAIL_PCT from that peak. Prevents giving back big gains.
export const HIGH_WATERMARK_ACTIVATE = 0.15;  // activate once position is up 15%
export const HIGH_WATERMARK_TRAIL_PCT = 0.06; // close if drops 6% from peak while activated

// ─── Dump / Liquidity Grab Detection ─────────────────────────────────────────
// If price drops DUMP_THRESHOLD % in a single monitor cycle (10s), exit immediately.
// Catches flash crashes and liquidity grabs before full SL is hit.
// NOTE: Only fires when position is already at a loss (below entry) to avoid false triggers.
export const DUMP_THRESHOLD_PCT = 0.08;   // 8% drop in one monitor cycle = dump exit (raised from 5% to reduce false triggers)
export const DUMP_LOOKBACK_CYCLES = 3;    // also exit if price down 10% over last 3 cycles (~30s)
export const DUMP_TREND_PCT = 0.10;       // 10% drop over lookback window triggers exit

// ─── Price Spike Guard ───────────────────────────────────────────────────────
// If fetched price is more than SPIKE_MULTIPLIER × entry price in a single
// monitor cycle, cross-validate before acting — protects against bad Jupiter /
// DexScreener quotes triggering phantom take-profits.
export const PRICE_SPIKE_MULTIPLIER = 10; // 10× entry price in one cycle = suspected glitch

// ─── Timing ───────────────────────────────────────────────────────────────────
export const SCAN_INTERVAL_MIN_MS = 10_000;    // 10 seconds
export const SCAN_INTERVAL_MAX_MS = 30_000;    // 30 seconds (random jitter)
export const POSITION_MONITOR_INTERVAL_MS = 3_000; // 3 seconds (was 10s — faster price checks for open positions)
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Paths ────────────────────────────────────────────────────────────────────
import path from 'path';
const ROOT = path.resolve(__dirname, '..');
export const STATE_FILE = path.join(ROOT, 'state.json');
export const HEARTBEAT_LOG = path.join(ROOT, 'logs', 'heartbeat.log');
export const LOGS_DIR = path.join(ROOT, 'logs');
