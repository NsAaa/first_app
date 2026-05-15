import axios from 'axios';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  MIN_LIQUIDITY_USD,
  MIN_TOKEN_AGE_HOURS,
  MIN_BUY_VOLUME_4H_USD,
  MIN_VOLUME_24H_USD,
  NEW_TOKEN_MAX_AGE_HOURS,
  NEW_TOKEN_MIN_AGE_HOURS,
  NEW_TOKEN_MIN_LIQUIDITY_USD,
  NEW_TOKEN_MIN_VOLUME_24H_USD,
  NEW_TOKEN_MIN_BUY_VOLUME_4H_USD,
  MIN_BUY_SELL_RATIO,
  MIN_LIQUIDITY_MCAP_RATIO,
  MAX_NEW_TOKEN_MCAP_USD,
  MAX_PRICE_CHANGE_1H_PCT,
  MIN_VOLUME_TREND_RATIO,
  MIN_PRICE_CHANGE_24H_PCT,
  NEW_TOKEN_MIN_1H_CHANGE_PCT,
  NEW_TOKEN_MAX_DROP_FROM_6H_PCT,
  NEW_TOKEN_MIN_PULLBACK_PCT,
  NEW_TOKEN_MAX_PULLBACK_PCT,
  NEW_TOKEN_MIN_VOL_ACCEL_RATIO,
  SNIPER_MAX_AGE_HOURS,
  SNIPER_MIN_AGE_MINUTES,
  SNIPER_MIN_LIQUIDITY_USD,
  SNIPER_MIN_VOLUME_USD,
  SNIPER_MAX_MCAP_USD,
  SNIPER_MAX_5M_CHANGE_PCT,
  SCAN_MODE,
  DEXSCREENER_API,
  BIRDEYE_API_URL,
  USDC_MINT,
  SOL_MINT,
  SOLANA_RPC_URL,
  JUPITER_QUOTE_URL,
} from './config';
import logger from './logger';

// Tokens we never trade (stablecoins, wrapped SOL, LSTs, etc.)
const BLACKLISTED_MINTS = new Set([
  USDC_MINT,                                          // USDC
  SOL_MINT,                                           // Wrapped SOL
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',   // USDT
  'A9mUU4qviSctJVPJdBJWkb28deg915LYJKrzQ19ji3FM',   // USDCet
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',  // ETH (Wormhole)
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA',   // USDS
  'USDH1SM1ojwWUga67PGrgFWUHibbjqMvuMaDkRJTgkX',   // USDH
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',  // PYUSD (PayPal USD stablecoin)
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',   // mSOL
  '7dHbWXmci3dT8UFYWYZweBLXgycu7Y3iL6trKn1Y7ARj',  // stSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',   // bSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',  // jitoSOL
]);

// Stablecoin detection: skip any token with price very close to $1 (±5%)
function isPriceStable(priceUsd: number): boolean {
  return priceUsd > 0.95 && priceUsd < 1.05;
}

export interface TokenCandidate {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  volume4hUsd?: number;
  priceChange4h?: number;
  priceChange24h?: number;
  priceHigh4h?: number;
  createdAt?: number;  // unix ms
  ageHours?: number;   // computed token age
  isNewToken?: boolean; // true if age < NEW_TOKEN_MAX_AGE_HOURS
  buyTxCount?: number;  // number of buy transactions (rug signal)
  buySellRatio?: number; // buys/sells ratio (rug signal)
  score: number;       // momentum score (higher = better)
  source: string;
}

// ─── Exponential Backoff ──────────────────────────────────────────────────────
async function fetchWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  baseDelayMs = 1000
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (err?.response?.status === 429) {
        const delay = baseDelayMs * Math.pow(2, attempt) + Math.random() * 500;
        logger.warn(`Rate limited, backing off ${Math.round(delay)}ms (attempt ${attempt + 1})`);
        await sleep(delay);
      } else if (attempt < maxRetries - 1) {
        const delay = baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Solana tokens to search — mix of established tokens + trending memecoins
// These are searched by ticker so DexScreener returns all pairs for each
const SEARCH_TICKERS = [
  // Established DeFi / blue chips
  'RAY', 'JUP', 'JTO', 'PYTH', 'ORCA', 'DRIFT', 'KMNO',
  'RENDER', 'HNT', 'MOBILE', 'ZEUS', 'W', 'TNSR', 'CLOUD',
  // Memecoins with staying power
  'BONK', 'WIF', 'POPCAT', 'BOME', 'MEW', 'FARTCOIN',
  'MOODENG', 'PNUT', 'GOAT', 'ACT', 'CHILLGUY',
  // Pump.fun survivors (tokens that lasted > 24h and gained traction)
  'TRUMP', 'MELANIA', 'VINE', 'SLERF', 'BODEN',
];

// ─── DexScreener Scanner ──────────────────────────────────────────────────────
async function fetchDexScreenerTrending(): Promise<TokenCandidate[]> {
  let pairs: any[] = [];

  // Search each ticker — DexScreener returns all pairs for matching tokens
  for (const ticker of SEARCH_TICKERS) {
    try {
      const resp = await fetchWithBackoff(() =>
        axios.get(`${DEXSCREENER_API}/search?q=${ticker}`, { timeout: 12_000 })
      );
      const tickerPairs: any[] = (resp.data?.pairs || []).filter((p: any) => p.chainId === 'solana');
      pairs.push(...tickerPairs);
    } catch (_) {}
    await sleep(200); // gentle pacing
  }

  const candidates: TokenCandidate[] = [];

  for (const pair of pairs) {
    try {
      if (pair.chainId !== 'solana') continue;
      if (!pair.baseToken?.address) continue;
      if (BLACKLISTED_MINTS.has(pair.baseToken.address)) continue; // skip stables/wsol

      const liquidity = pair.liquidity?.usd || 0;
      const volume24h = pair.volume?.h24 || 0;
      const priceUsd = parseFloat(pair.priceUsd || '0');
      const priceChange4h = pair.priceChange?.h6 || pair.priceChange?.h24 || 0; // use 6h as proxy
      const priceChange24h = pair.priceChange?.h24 || 0;

      // Age check — pair.pairCreatedAt is ms
      const createdAt = pair.pairCreatedAt || 0;
      const ageHours = createdAt ? (Date.now() - createdAt) / 3_600_000 : 9999;
      const isNewToken = ageHours < NEW_TOKEN_MAX_AGE_HOURS;

      if (liquidity < MIN_LIQUIDITY_USD) continue;
      if (ageHours < MIN_TOKEN_AGE_HOURS) continue; // too new (< 2h)
      if (volume24h < MIN_VOLUME_24H_USD) continue;
      if (priceChange4h <= 0) continue; // only upward momentum
      if (priceUsd <= 0) continue;
      if (isPriceStable(priceUsd)) continue; // skip stablecoins not caught by mint blacklist
      // Skip low-volatility tokens (BTC, cbBTC, WBTC etc.) — can't realistically hit TP
      if (Math.abs(priceChange24h) < MIN_PRICE_CHANGE_24H_PCT) continue;

      // Volume ratio (buy pressure proxy): high 1h volume relative to 24h
      const vol1h = pair.volume?.h1 || 0;
      const vol4h = pair.volume?.h6 || 0; // use 6h as proxy for 4h
      if (vol4h < MIN_BUY_VOLUME_4H_USD) continue;

      // ─── Anti-chasing filters ─────────────────────────────────────────────
      // Skip if already pumped hard in the last hour (we're buying the top)
      const priceChange1h = pair.priceChange?.h1 || 0;
      if (priceChange1h > MAX_PRICE_CHANGE_1H_PCT) continue;
      // Skip if 1h volume is fading vs hourly average (momentum dying)
      const hourlyAvgVol = volume24h / 24;
      if (hourlyAvgVol > 0 && vol1h < hourlyAvgVol * MIN_VOLUME_TREND_RATIO) continue;

      // ─── Rug checks for new tokens (2–24h old) ───────────────────────────
      const txnsBuys = pair.txns?.h24?.buys || pair.txns?.h6?.buys || 0;
      const txnsSells = pair.txns?.h24?.sells || pair.txns?.h6?.sells || 0;
      const buySellRatio = txnsSells > 0 ? txnsBuys / txnsSells : txnsBuys > 0 ? 99 : 1;
      const marketCap = pair.marketCap || pair.fdv || 0;
      const liquidityMcapRatio = marketCap > 0 ? liquidity / marketCap : 1;

      if (isNewToken) {
        // For new tokens, require healthy buy/sell ratio (not just bots buying for pump)
        if (buySellRatio < MIN_BUY_SELL_RATIO) continue;
        // Require liquidity ≥ 5% of market cap (low ratio = rug risk)
        if (marketCap > 0 && liquidityMcapRatio < MIN_LIQUIDITY_MCAP_RATIO) continue;
        // Cap market cap at $50M — filters out established tokens with young pairs
        // and keeps focus on genuinely small/new tokens with explosive potential
        if (marketCap > MAX_NEW_TOKEN_MCAP_USD) continue;
      }

      // Momentum score: weighted combination
      const liquidityScore = Math.min(liquidity / 1_000_000, 10); // cap at 10x
      const momentumScore = Math.min(priceChange4h / 5, 10);       // % change / 5, capped
      const volumeScore = Math.min(vol4h / MIN_BUY_VOLUME_4H_USD, 10);
      const recentVolSpike = vol1h > 0 && volume24h > 0 ? Math.min((vol1h / (volume24h / 24)) * 2, 10) : 0;
      // Bonus score for fresh tokens with strong signals
      const newTokenBonus = isNewToken ? Math.min(momentumScore * 0.5, 5) : 0;

      const score = liquidityScore + momentumScore * 2 + volumeScore + recentVolSpike + newTokenBonus;

      candidates.push({
        mint: pair.baseToken.address,
        symbol: pair.baseToken.symbol || 'UNKNOWN',
        name: pair.baseToken.name || pair.baseToken.symbol || 'UNKNOWN',
        priceUsd,
        liquidityUsd: liquidity,
        volume24hUsd: volume24h,
        volume4hUsd: vol4h,
        priceChange4h,
        priceChange24h,
        createdAt,
        ageHours,
        isNewToken,
        buyTxCount: txnsBuys,
        buySellRatio,
        score,
        source: 'dexscreener',
      });
    } catch (e) {
      // Skip bad pairs silently
    }
  }

  return candidates;
}

// ─── Birdeye Scanner ─────────────────────────────────────────────────────────
async function fetchBirdeyeTopTokens(): Promise<TokenCandidate[]> {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) {
    // Birdeye now requires an API key — skip silently if not configured
    return [];
  }
  const url = 'https://public-api.birdeye.so/defi/tokenlist?sort_by=v24hUSD&sort_type=desc&offset=0&limit=50&min_liquidity=1000000';
  try {
    const resp = await fetchWithBackoff(() =>
      axios.get(url, {
        timeout: 15_000,
        headers: { 'X-Chain': 'solana', 'X-API-KEY': apiKey },
      })
    );

    const tokens: any[] = resp.data?.data?.tokens || [];
    const candidates: TokenCandidate[] = [];

    for (const token of tokens) {
      try {
        if (!token.address) continue;
        if (BLACKLISTED_MINTS.has(token.address)) continue; // skip stables/wsol
        const priceUsd = token.price || 0;
        const liquidity = token.liquidity || 0;
        const volume24h = token.v24hUSD || 0;
        const priceChange24h = token.v24hChangePercent || 0;

        if (liquidity < MIN_LIQUIDITY_USD) continue;
        if (volume24h < MIN_VOLUME_24H_USD) continue;
        if (priceChange24h <= 0) continue;
        if (priceUsd <= 0) continue;
        if (isPriceStable(priceUsd)) continue; // skip stablecoins not caught by mint blacklist
        if (Math.abs(priceChange24h) < MIN_PRICE_CHANGE_24H_PCT) continue; // skip low volatility

        const score = Math.min(liquidity / 1_000_000, 5) +
                      Math.min(priceChange24h / 5, 10) +
                      Math.min(volume24h / 500_000, 5);

        candidates.push({
          mint: token.address,
          symbol: token.symbol || 'UNKNOWN',
          name: token.name || token.symbol || 'UNKNOWN',
          priceUsd,
          liquidityUsd: liquidity,
          volume24hUsd: volume24h,
          priceChange24h,
          score,
          source: 'birdeye',
        });
      } catch (e) {
        // Skip bad tokens silently
      }
    }
    return candidates;
  } catch (err: any) {
    logger.warn('Birdeye fetch failed (non-critical)', { error: err?.message });
    return [];
  }
}

// ─── Resistance Break Check ───────────────────────────────────────────────────
// Check if current price is above recent 4h high (resistance break)
async function checkResistanceBreak(mint: string, currentPriceUsd: number): Promise<boolean> {
  try {
    // Use DexScreener token endpoint to get OHLCV data
    const url = `${DEXSCREENER_API}/tokens/${mint}`;
    const resp = await fetchWithBackoff(() =>
      axios.get(url, { timeout: 10_000 })
    );

    const pairs: any[] = resp.data?.pairs || [];
    if (pairs.length === 0) return false;

    // Get the pair with highest liquidity on Solana
    const solanaPairs = pairs.filter((p: any) => p.chainId === 'solana');
    if (solanaPairs.length === 0) return false;

    solanaPairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const best = solanaPairs[0];

    // Use price change h6 as a proxy for whether we're near highs
    const priceChange6h = best.priceChange?.h6 || 0;
    const priceChange1h = best.priceChange?.h1 || 0;

    // Resistance break: price is up 4h+ and recent 1h still positive
    return priceChange6h > 3 && priceChange1h > 0;
  } catch (err) {
    return false; // fail open — don't block on resistance check
  }
}

// ─── DexScreener New Token Scanner ───────────────────────────────────────────
// Uses token-profiles endpoint to discover freshly launched Solana tokens,
// then fetches pair data to apply momentum + rug filters.
async function fetchNewPairs(): Promise<TokenCandidate[]> {
  try {
    // Get latest token profiles (freshly listed tokens on DexScreener)
    const profileResp = await fetchWithBackoff(() =>
      axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 12_000 })
    );

    const profiles: any[] = Array.isArray(profileResp.data)
      ? profileResp.data
      : (profileResp.data?.data || []);

    const solanaAddresses = profiles
      .filter((p: any) => p.chainId === 'solana' && p.tokenAddress)
      .map((p: any) => p.tokenAddress)
      .slice(0, 20); // process top 20 profiles

    if (solanaAddresses.length === 0) return [];

    // Fetch pair data for each token in batches
    const candidates: TokenCandidate[] = [];

    for (const address of solanaAddresses) {
      try {
        if (BLACKLISTED_MINTS.has(address)) continue;

        const resp = await fetchWithBackoff(() =>
          axios.get(`${DEXSCREENER_API}/tokens/${address}`, { timeout: 10_000 })
        );

        const pairs: any[] = (resp.data?.pairs || []).filter((p: any) => p.chainId === 'solana');
        if (pairs.length === 0) continue;

        // Use the pair with highest liquidity
        pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const pair = pairs[0];

        const priceUsd = parseFloat(pair.priceUsd || '0');
        const liquidity = pair.liquidity?.usd || 0;
        const volume24h = pair.volume?.h24 || 0;
        const createdAt = pair.pairCreatedAt || 0;
        const ageHours = createdAt ? (Date.now() - createdAt) / 3_600_000 : 9999;
        const marketCap = pair.marketCap || pair.fdv || 0;

        // New token age window: 2-24h
        if (ageHours < NEW_TOKEN_MIN_AGE_HOURS || ageHours >= NEW_TOKEN_MAX_AGE_HOURS) continue;
        if (priceUsd <= 0 || isPriceStable(priceUsd)) continue;
        if (liquidity < NEW_TOKEN_MIN_LIQUIDITY_USD) continue;
        if (volume24h < NEW_TOKEN_MIN_VOLUME_24H_USD) continue;
        if (marketCap > MAX_NEW_TOKEN_MCAP_USD) continue;

        const priceChange4h = pair.priceChange?.h6 || pair.priceChange?.h24 || 0;
        if (priceChange4h <= 0) continue;

        const vol1h = pair.volume?.h1 || 0;
        const vol4h = pair.volume?.h6 || 0;
        if (vol4h < NEW_TOKEN_MIN_BUY_VOLUME_4H_USD) continue;

        // ─── Recovery filter — skip if actively dumping ───────────────────
        const priceChange1h = pair.priceChange?.h1 || 0;
        // Must be flat or rising in the last 1h (not mid-dump)
        if (priceChange1h < NEW_TOKEN_MIN_1H_CHANGE_PCT) continue;
        // Skip if pumped too hard in 1h (chasing the top)
        if (priceChange1h > MAX_PRICE_CHANGE_1H_PCT * 2) continue;
        // Skip if token has crashed >60% from its 6h high (heavy dump / rug)
        const priceChange6h = pair.priceChange?.h6 || 0;
        if (priceChange6h < -NEW_TOKEN_MAX_DROP_FROM_6H_PCT) continue;

        // Rug checks
        const txnsBuys = pair.txns?.h24?.buys || pair.txns?.h6?.buys || 0;
        const txnsSells = pair.txns?.h24?.sells || pair.txns?.h6?.sells || 0;
        const buySellRatio = txnsSells > 0 ? txnsBuys / txnsSells : txnsBuys > 0 ? 99 : 1;
        const liquidityMcapRatio = marketCap > 0 ? liquidity / marketCap : 1;

        if (buySellRatio < MIN_BUY_SELL_RATIO) continue;
        if (marketCap > 0 && liquidityMcapRatio < MIN_LIQUIDITY_MCAP_RATIO) continue;

        const momentumScore = Math.min(priceChange4h / 5, 10);
        const volumeScore = Math.min(vol4h / NEW_TOKEN_MIN_BUY_VOLUME_4H_USD, 10);
        const recentVolSpike = vol1h > 0 && volume24h > 0 ? Math.min((vol1h / (volume24h / 24)) * 2, 10) : 0;
        const freshnessBonus = Math.min((NEW_TOKEN_MAX_AGE_HOURS - ageHours) / NEW_TOKEN_MAX_AGE_HOURS * 5, 5);

        const score = momentumScore * 2 + volumeScore + recentVolSpike + freshnessBonus;

        candidates.push({
          mint: address,
          symbol: pair.baseToken?.symbol || 'UNKNOWN',
          name: pair.baseToken?.name || pair.baseToken?.symbol || 'UNKNOWN',
          priceUsd,
          liquidityUsd: liquidity,
          volume24hUsd: volume24h,
          volume4hUsd: vol4h,
          priceChange4h,
          createdAt,
          ageHours,
          isNewToken: true,
          buyTxCount: txnsBuys,
          buySellRatio,
          score,
          source: 'dexscreener-new',
        });

        await sleep(200); // gentle pacing
      } catch (_) {}
    }

    logger.debug(`New token scan: ${candidates.length} candidates (from ${solanaAddresses.length} profiles)`);
    return candidates;
  } catch (err: any) {
    logger.warn('New token scan failed', { error: err?.message });
    return [];
  }
}

// ─── Sniper Scanner ───────────────────────────────────────────────────────────
// Targets brand new tokens (0-2h old) — no fixed TP, trailing stop only.
// Very aggressive — expects lots of SL hits but hunting for explosive early movers.
async function fetchSniperCandidates(): Promise<TokenCandidate[]> {
  try {
    const profileResp = await fetchWithBackoff(() =>
      axios.get('https://api.dexscreener.com/token-profiles/latest/v1', { timeout: 12_000 })
    );

    const profiles: any[] = Array.isArray(profileResp.data)
      ? profileResp.data
      : (profileResp.data?.data || []);

    const solanaAddresses = profiles
      .filter((p: any) => p.chainId === 'solana' && p.tokenAddress)
      .map((p: any) => p.tokenAddress)
      .slice(0, 30);

    if (solanaAddresses.length === 0) return [];

    const candidates: TokenCandidate[] = [];

    for (const address of solanaAddresses) {
      try {
        if (BLACKLISTED_MINTS.has(address)) continue;

        const resp = await fetchWithBackoff(() =>
          axios.get(`${DEXSCREENER_API}/tokens/${address}`, { timeout: 10_000 })
        );

        const pairs: any[] = (resp.data?.pairs || []).filter((p: any) => p.chainId === 'solana');
        if (pairs.length === 0) continue;

        pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
        const pair = pairs[0];

        const priceUsd = parseFloat(pair.priceUsd || '0');
        const liquidity = pair.liquidity?.usd || 0;
        const volume24h = pair.volume?.h24 || 0;
        const createdAt = pair.pairCreatedAt || 0;
        const ageHours = createdAt ? (Date.now() - createdAt) / 3_600_000 : 9999;
        const marketCap = pair.marketCap || pair.fdv || 0;
        const priceChange1h = pair.priceChange?.h1 || 0;

        // Sniper filters
        if (ageHours > SNIPER_MAX_AGE_HOURS) continue;            // must be <2h old
        if (priceUsd <= 0 || isPriceStable(priceUsd)) continue;
        if (liquidity < SNIPER_MIN_LIQUIDITY_USD) continue;
        if (volume24h < SNIPER_MIN_VOLUME_USD) continue;
        if (marketCap > SNIPER_MAX_MCAP_USD) continue;
        if (priceChange1h < 0) continue;                           // must be trending up on 1h

        // ─── Option 1: Pullback filter ────────────────────────────────────
        // Require a 5-30% pullback in the last 5 min — entering the dip, not the top
        const priceChange5m = pair.priceChange?.m5 || 0;
        const hasPulledBackSniper = priceChange5m < 0 && Math.abs(priceChange5m) >= NEW_TOKEN_MIN_PULLBACK_PCT;
        const notCrashingSniper = Math.abs(priceChange5m) <= NEW_TOKEN_MAX_PULLBACK_PCT;
        if (!hasPulledBackSniper || !notCrashingSniper) continue;

        // ─── Option 2: Volume acceleration ────────────────────────────────
        // 1h volume must be above average — entering on rising interest, not fading
        const vol1hSniper = pair.volume?.h1 || 0;
        const hourlyAvgSniper = volume24h / Math.max(ageHours, 1);
        if (vol1hSniper < hourlyAvgSniper * NEW_TOKEN_MIN_VOL_ACCEL_RATIO) continue;

        const txnsBuys = pair.txns?.h1?.buys || pair.txns?.h24?.buys || 0;
        const txnsSells = pair.txns?.h1?.sells || pair.txns?.h24?.sells || 0;
        const buySellRatio = txnsSells > 0 ? txnsBuys / txnsSells : txnsBuys > 0 ? 99 : 1;

        // Basic rug check — need more buys than sells
        if (buySellRatio < 1.0) continue;

        const momentumScore = Math.min(priceChange1h / 10, 10);
        const volumeScore = Math.min(volume24h / SNIPER_MIN_VOLUME_USD, 10);
        const freshnessBonus = Math.max(0, (SNIPER_MAX_AGE_HOURS - ageHours) / SNIPER_MAX_AGE_HOURS * 10);

        const score = momentumScore * 3 + volumeScore + freshnessBonus;

        candidates.push({
          mint: address,
          symbol: pair.baseToken?.symbol || 'UNKNOWN',
          name: pair.baseToken?.name || pair.baseToken?.symbol || 'UNKNOWN',
          priceUsd,
          liquidityUsd: liquidity,
          volume24hUsd: volume24h,
          priceChange4h: priceChange1h,
          createdAt,
          ageHours,
          isNewToken: true,
          buyTxCount: txnsBuys,
          buySellRatio,
          score,
          source: 'sniper',
        });

        await sleep(200);
      } catch (_) {}
    }

    logger.debug(`Sniper scan: ${candidates.length} candidates found`);
    return candidates;
  } catch (err: any) {
    logger.warn('Sniper scan failed', { error: err?.message });
    return [];
  }
}

// ─── Main Scan ────────────────────────────────────────────────────────────────
export async function scanForCandidates(): Promise<TokenCandidate[]> {
  // Use runtime override if set via menu, otherwise fall back to config
  let activeMode = SCAN_MODE;
  try {
    const { getActiveScanMode } = await import('./menu');
    activeMode = getActiveScanMode() as any;
  } catch (_) {}

  logger.debug(`Scanning for momentum candidates (mode: ${activeMode})...`);

  const all: TokenCandidate[] = [];

  if (activeMode === 'established' || activeMode === 'both') {
    const [dexCandidates, birdCandidates] = await Promise.allSettled([
      fetchDexScreenerTrending(),
      fetchBirdeyeTopTokens(),
    ]);
    if (dexCandidates.status === 'fulfilled') all.push(...dexCandidates.value);
    else logger.warn('DexScreener established scan failed', { error: dexCandidates.reason?.message });
    if (birdCandidates.status === 'fulfilled') all.push(...birdCandidates.value);
  }

  if (activeMode === 'new' || activeMode === 'both') {
    const newResult = await fetchNewPairs().catch(err => {
      logger.warn('New token scan failed', { error: err?.message });
      return [] as TokenCandidate[];
    });
    all.push(...newResult);
    logger.debug(`New token scan contributed ${newResult.length} candidates`);
  }

  if (activeMode === 'sniper') {
    const sniperResult = await fetchSniperCandidates().catch(err => {
      logger.warn('Sniper scan failed', { error: err?.message });
      return [] as TokenCandidate[];
    });
    all.push(...sniperResult);
    logger.debug(`Sniper scan contributed ${sniperResult.length} candidates`);
  }

  // Deduplicate by mint, keeping highest score
  const byMint = new Map<string, TokenCandidate>();
  for (const c of all) {
    const existing = byMint.get(c.mint);
    if (!existing || c.score > existing.score) {
      byMint.set(c.mint, c);
    }
  }

  // Sort by score descending
  const sorted = Array.from(byMint.values()).sort((a, b) => b.score - a.score);

  // Take top 20 for resistance check (to limit API calls)
  const top = sorted.slice(0, 20);

  logger.info(`Scan complete: ${top.length} candidates (from ${all.length} raw results)`);
  return top;
}

// ─── Token Decimals Cache ─────────────────────────────────────────────────────
// Fetched once per token via Helius RPC; used to convert Jupiter quote outAmount
const _decimalsCache = new Map<string, number>();
let _rpcConnection: Connection | null = null;

function getRpcConnection(): Connection {
  if (!_rpcConnection) {
    _rpcConnection = new Connection(process.env.SOLANA_RPC_URL || SOLANA_RPC_URL, 'confirmed');
  }
  return _rpcConnection;
}

async function getTokenDecimals(mint: string): Promise<number> {
  if (_decimalsCache.has(mint)) return _decimalsCache.get(mint)!;
  try {
    const conn = getRpcConnection();
    const info = await conn.getParsedAccountInfo(new PublicKey(mint));
    const decimals = (info.value?.data as any)?.parsed?.info?.decimals;
    if (typeof decimals === 'number') {
      _decimalsCache.set(mint, decimals);
      return decimals;
    }
  } catch (_) {}
  return 9; // safe fallback — most Solana memecoins use 6 or 9
}

// ─── Get Current Price ────────────────────────────────────────────────────────
// Primary: Jupiter Quote API (real-time swap price — same as actual trades, no cache lag)
// Fallback: DexScreener REST (15-30s lag but broad coverage)
// Fallback 2: Birdeye (requires BIRDEYE_API_KEY in .env)
export async function getCurrentPrice(mint: string): Promise<number | null> {
  // 1. Jupiter Quote (primary — genuinely real-time, no REST cache lag)
  // Quote $1 of USDC → token; price = $1 / tokens_received
  try {
    const USDC_QUOTE_AMOUNT = 1_000_000; // $1 of USDC (6 decimals)
    const decimals = await getTokenDecimals(mint);
    const params = new URLSearchParams({
      inputMint: USDC_MINT,
      outputMint: mint,
      amount: USDC_QUOTE_AMOUNT.toString(),
      slippageBps: '50',
    });
    const resp = await axios.get(`${JUPITER_QUOTE_URL}?${params}`, { timeout: 4_000 });
    const outAmount = parseInt(resp.data?.outAmount || '0');
    if (outAmount > 0) {
      const tokenAmount = outAmount / Math.pow(10, decimals);
      const price = 1 / tokenAmount; // $1 buys X tokens → $1/X = price per token
      if (price > 0 && price < 1_000_000) return price;
    }
  } catch (_) {}

  // 2. DexScreener (fallback — has 15-30s REST cache lag but broad token coverage)
  try {
    const resp = await axios.get(`${DEXSCREENER_API}/tokens/${mint}`, { timeout: 5_000 });
    const pairs: any[] = resp.data?.pairs || [];
    const solana = pairs.filter((p: any) => p.chainId === 'solana');
    if (solana.length > 0) {
      solana.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const price = parseFloat(solana[0].priceUsd || '0');
      if (price > 0) return price;
    }
  } catch (_) {}

  // 3. Birdeye (fallback — only if API key is configured)
  const birdeyeKey = process.env.BIRDEYE_API_KEY;
  if (birdeyeKey) {
    try {
      const resp = await axios.get(`${BIRDEYE_API_URL}?address=${mint}`, {
        timeout: 5_000,
        headers: { 'X-Chain': 'solana', 'X-API-KEY': birdeyeKey },
      });
      const price = resp.data?.data?.value;
      if (price && price > 0) return price;
    } catch (_) {}
  }

  return null;
}
