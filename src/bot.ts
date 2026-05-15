/**
 * Solana Momentum Trading Bot — Main Daemon
 *
 * Lifecycle:
 *   1. Load state from disk
 *   2. Start position monitor (every 10s)
 *   3. Start market scanner (every 10-30s with jitter)
 *   4. Start heartbeat logger (every 5 min)
 *   5. Never exit unless SIGTERM/SIGINT or unrecoverable error
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import path from 'path';

import {
  SCAN_INTERVAL_MIN_MS,
  SCAN_INTERVAL_MAX_MS,
  POSITION_MONITOR_INTERVAL_MS,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_LOG,
  LOGS_DIR,
  DRY_RUN,
  MAX_SIMULTANEOUS_POSITIONS,
  PORTFOLIO_STOP_LOSS_USD,
  STARTING_CAPITAL_USD,
} from './config';
import { loadState, getState, getOpenPositions } from './state';
import { scanForCandidates, getCurrentPrice } from './scanner';
import { openPosition, monitorPositions, closeAllPositions, checkPortfolioStop } from './positions';
import { alertError, alertHeartbeat } from './telegram';
import { startMenuListener, isScanPaused, getLimitBuyOrders, removeLimitBuyOrder } from './menu';
import logger from './logger';

// ─── Ensure logs directory ─────────────────────────────────────────────────
if (!fs.existsSync(LOGS_DIR)) {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}
// ─── Limit Buy Order Checker ─────────────────────────────────────────────
async function checkLimitBuyOrders(): Promise<void> {
  const orders = getLimitBuyOrders();
  if (orders.length === 0) return;
  for (const order of orders) {
    try {
      const currentPrice = await getCurrentPrice(order.mint);
      if (currentPrice === null) continue;
      if (currentPrice > order.limitPrice) continue;
      logger.info(`📌 Limit buy triggered: ${order.symbol} @ $${currentPrice.toFixed(8)} (limit: $${order.limitPrice})`);
      removeLimitBuyOrder(order.mint);
      const candidate = { mint: order.mint, symbol: order.symbol, name: order.symbol, priceUsd: currentPrice, liquidityUsd: 0, volume24hUsd: 0, isNewToken: order.isNewToken ?? true, ageHours: 12, score: 99, source: "manual", _overrideTpPct: order.noTp ? undefined : order.tpPct, _overrideSlPct: order.noSl ? undefined : order.slPct, _noTp: order.noTp, _noSl: order.noSl, _forceEntry: order.forceEntry, _skipCooldown: true, _isManual: true };
      const { sendMessage } = await import("./telegram");
      const opened = await openPosition(candidate as any);
      if (opened) { const tpLabel = order.noTp ? "none" : `+${((order.tpPct ?? 0) * 100).toFixed(0)}%`; const slLabel = order.noSl ? "none" : `-${((order.slPct ?? 0) * 100).toFixed(0)}%`; await sendMessage(`✅ <b>Limit buy executed: ${order.symbol}</b>\n💵 Entry: $${currentPrice.toFixed(8)}\n🎯 TP: ${tpLabel} | 🛑 SL: ${slLabel}`); } else { await sendMessage(`⚠️ Limit buy triggered for <b>${order.symbol}</b> but failed to open.`); }
    } catch (err: any) { logger.warn(`Limit buy check failed for ${order.symbol}`, { error: err?.message }); }
  }
}

// ─── State ─────────────────────────────────────────────────────────────────
// ─── State ─────────────────────────────────────────────────────────────────
let isRunning = true;
let startTime = Date.now();

function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

function randomJitter(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ─── Heartbeat ────────────────────────────────────────────────────────────
async function writeHeartbeat(): Promise<void> {
  const state = getState();
  const uptime = formatUptime(Date.now() - startTime);
  const open = getOpenPositions();
  const now = new Date().toISOString();

  const entry = [
    `[${now}] HEARTBEAT`,
    `  Uptime: ${uptime}`,
    `  Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`,
    `  Open positions: ${open.length}/${MAX_SIMULTANEOUS_POSITIONS}`,
    `  Capital: $${state.totalCapitalUsd.toFixed(2)}`,
    `  Realized P&L: $${state.realizedPnlUsd >= 0 ? '+' : ''}${state.realizedPnlUsd.toFixed(2)}`,
    `  Portfolio stop: ${state.portfolioStopTriggered ? 'TRIGGERED' : 'ok'}`,
    '',
  ].join('\n');

  try {
    fs.appendFileSync(HEARTBEAT_LOG, entry, 'utf-8');
  } catch (err) {
    logger.warn('Failed to write heartbeat log', { err });
  }

  // Also send to Telegram (only if configured, handled inside alertHeartbeat)
  await alertHeartbeat({
    uptime,
    openPositions: open.length,
    realizedPnlUsd: state.realizedPnlUsd,
    totalCapitalUsd: state.totalCapitalUsd,
    dryRun: DRY_RUN,
    positions: open.map(p => ({
      symbol: p.tokenSymbol,
      entryPriceUsd: p.entryPriceUsd,
      currentPriceUsd: p.currentPriceUsd ?? p.entryPriceUsd,
      usdSpent: p.usdSpent,
      takeProfitPrice: p.takeProfitPrice,
      stopLossPrice: p.stopLossPrice,
    })),
  }).catch(() => {});

  logger.info(`Heartbeat — uptime: ${uptime}, positions: ${open.length}, P&L: $${state.realizedPnlUsd.toFixed(2)}`);
}

// ─── Scanner Loop ──────────────────────────────────────────────────────────
async function runScanCycle(): Promise<void> {
  if (!isRunning) return;

  const state = getState();
  if (state.portfolioStopTriggered) {
    logger.warn('Portfolio stop active — skipping scan');
    return;
  }

  if (isScanPaused()) {
    logger.debug('Scan paused by user — skipping');
    return;
  }

  if (getOpenPositions().length >= MAX_SIMULTANEOUS_POSITIONS) {
    logger.debug('Max positions open, skipping scan');
    return;
  }

  try {
    const candidates = await scanForCandidates();

    if (candidates.length === 0) {
      logger.debug('No candidates found this cycle');
      return;
    }

    logger.info(`Found ${candidates.length} candidates, evaluating top...`);

    // Try opening a position with the best candidate
    // (only one per scan cycle to avoid overexposure)
    for (const candidate of candidates.slice(0, 5)) {
      if (!isRunning) break;
      const opened = await openPosition(candidate);
      if (opened) break; // one trade per scan cycle
    }
  } catch (err: any) {
    logger.error('Scan cycle error', { error: err?.message });
    await alertError(`Scan error: ${err?.message}`).catch(() => {});
  }
}

// ─── Position Monitor Loop ────────────────────────────────────────────────
async function runMonitorCycle(): Promise<void> {
  if (!isRunning) return;

  try {
    await monitorPositions(getCurrentPrice);
    await checkLimitBuyOrders();

    // Check portfolio stop after monitoring
    if (checkPortfolioStop() && !getState().portfolioStopTriggered) {
      const { setPortfolioStop } = await import('./state');
      setPortfolioStop();
      const state = getState();
      const { alertPortfolioStop } = await import('./telegram');
      await alertPortfolioStop({
        totalLossUsd: state.realizedPnlUsd,
        dryRun: DRY_RUN,
      });
      logger.error('PORTFOLIO STOP TRIGGERED — halting new trades');
    }
  } catch (err: any) {
    logger.error('Monitor cycle error', { error: err?.message });
  }
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal} — shutting down gracefully...`);
  isRunning = false;

  try {
    await closeAllPositions('manual');
  } catch (err) {
    logger.error('Error during shutdown close', { err });
  }

  logger.info('Bot stopped.');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', async (err) => {
  logger.error('Uncaught exception', { error: err?.message, stack: err?.stack });
  await alertError('Uncaught exception — bot may be unstable', err?.message).catch(() => {});
  // Don't exit — try to recover
});
process.on('unhandledRejection', async (reason: any) => {
  logger.error('Unhandled rejection', { reason: reason?.message || String(reason) });
  await alertError('Unhandled promise rejection', String(reason)).catch(() => {});
  // Don't exit — log and continue
});

// ─── Main ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  logger.info('═══════════════════════════════════════════');
  logger.info('  Solana Momentum Trading Bot starting up');
  logger.info(`  Mode: ${DRY_RUN ? '🧪 DRY RUN (no real trades)' : '⚡ LIVE TRADING'}`);
  logger.info('═══════════════════════════════════════════');

  // Load persisted state
  loadState();
  const state = getState();
  logger.info('State loaded', {
    openPositions: getOpenPositions().length,
    realizedPnl: state.realizedPnlUsd,
    capital: state.totalCapitalUsd,
  });

  if (state.portfolioStopTriggered) {
    logger.error('⛔ Portfolio stop is ACTIVE from previous session. Set portfolioStopTriggered=false in state.json to resume.');
    await alertError('Bot started but portfolio stop is ACTIVE from previous session. Manual reset required.').catch(() => {});
  }

  if (DRY_RUN) {
    logger.info('DRY RUN mode: all trades are simulated. Set DRY_RUN=false in .env to go live.');
  }

  // Initial heartbeat
  await writeHeartbeat();

  // ─── Start position monitor (fixed interval) ───────────────────────────
  const monitorLoop = async () => {
    while (isRunning) {
      await runMonitorCycle();
      await new Promise(r => setTimeout(r, POSITION_MONITOR_INTERVAL_MS));
    }
  };

  // ─── Start scanner (random jitter interval) ───────────────────────────
  const scanLoop = async () => {
    // Initial delay: stagger from monitor
    await new Promise(r => setTimeout(r, 5_000));
    while (isRunning) {
      await runScanCycle();
      const delay = randomJitter(SCAN_INTERVAL_MIN_MS, SCAN_INTERVAL_MAX_MS);
      logger.debug(`Next scan in ${(delay / 1000).toFixed(1)}s`);
      await new Promise(r => setTimeout(r, delay));
    }
  };

  // ─── Heartbeat timer ──────────────────────────────────────────────────
  const heartbeatLoop = async () => {
    await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL_MS));
    while (isRunning) {
      await writeHeartbeat();
      await new Promise(r => setTimeout(r, HEARTBEAT_INTERVAL_MS));
    }
  };

  // Run all loops concurrently (menu listener runs independently)
  startMenuListener().catch(err => logger.error('[Menu] Fatal error', { error: err?.message }));

  await Promise.all([
    monitorLoop(),
    scanLoop(),
    heartbeatLoop(),
  ]);
}

main().catch(async (err) => {
  logger.error('Fatal error in main()', { error: err?.message, stack: err?.stack });
  await alertError('Bot CRASHED — fatal error in main()', err?.message).catch(() => {});
  process.exit(1);
});
