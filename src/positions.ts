import { v4 as uuidv4 } from 'uuid';
import {
  STOP_LOSS_PCT,
  TAKE_PROFIT_PCT,
  NEW_TOKEN_STOP_LOSS_PCT,
  NEW_TOKEN_TAKE_PROFIT_PCT,
  PORTFOLIO_STOP_LOSS_USD,
  STARTING_CAPITAL_USD,
  MAX_POSITION_SIZE_USD,
  MAX_SIMULTANEOUS_POSITIONS,
  MAX_POSITIONS_PER_TIER,
  TOKEN_COOLDOWN_MS,
  NEAR_TP_THRESHOLD,
  NEAR_TP_TRAIL_PCT,
  HIGH_WATERMARK_ACTIVATE,
  HIGH_WATERMARK_TRAIL_PCT,
  SNIPER_TRAIL_PCT,
  DUMP_THRESHOLD_PCT,
  DUMP_LOOKBACK_CYCLES,
  DUMP_TREND_PCT,
  DRY_RUN,
} from './config';
import {
  getState,
  getOpenPositions,
  addPosition,
  closePosition,
  setPortfolioStop,
  isAlreadyTracking,
  setCooldown,
  isOnCooldown,
  getCooldownRemaining,
  Position,
} from './state';
import { buyToken, sellToken } from './trader';
import {
  alertPositionOpened,
  alertPositionClosed,
  alertStopLoss,
  alertTakeProfit,
  alertPortfolioStop,
} from './telegram';
import logger from './logger';
import type { TokenCandidate } from './scanner';

// ─── Check Portfolio Stop ─────────────────────────────────────────────────────
export function checkPortfolioStop(): boolean {
  const state = getState();
  if (state.portfolioStopTriggered) return true;

  const totalLoss = state.realizedPnlUsd;
  // Also count unrealized losses
  const openPositions = getOpenPositions();
  let unrealizedPnl = 0;
  for (const pos of openPositions) {
    if (pos.currentPriceUsd && pos.entryPriceUsd) {
      const pnl = (pos.currentPriceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent;
      unrealizedPnl += pnl;
    }
  }

  const totalPnl = totalLoss + unrealizedPnl;
  if (totalPnl <= -PORTFOLIO_STOP_LOSS_USD) {
    logger.error(`Portfolio stop triggered! Total P&L: $${totalPnl.toFixed(2)}`);
    return true;
  }

  return false;
}

// ─── Open a Position ──────────────────────────────────────────────────────────
export async function openPosition(candidate: TokenCandidate): Promise<boolean> {
  const state = getState();

  // Manual override flags (passed via _overrideXxx on candidate)
  const forceEntry    = !!(candidate as any)._forceEntry;    // skip position count limits
  const skipCooldown  = !!(candidate as any)._skipCooldown;  // skip cooldown check
  const noTp          = !!(candidate as any)._noTp;          // disable take profit
  const noSl          = !!(candidate as any)._noSl;          // disable stop loss
  const isManual      = !!(candidate as any)._isManual;      // opened via /trade

  // Guards
  if (state.portfolioStopTriggered) {
    logger.warn('Portfolio stop active — not opening new positions');
    return false;
  }
  if (!forceEntry && getOpenPositions().length >= MAX_SIMULTANEOUS_POSITIONS) {
    logger.debug('Max positions reached');
    return false;
  }

  // Per-tier position limit (max 3 established, max 3 new token)
  if (!forceEntry) {
    const openByTier = getOpenPositions().filter(p =>
      candidate.isNewToken ? (p as any).isNewToken : !(p as any).isNewToken
    );
    if (openByTier.length >= MAX_POSITIONS_PER_TIER) {
      logger.debug(`Max positions reached for ${candidate.isNewToken ? 'new token' : 'established'} tier`);
      return false;
    }
  }
  if (isAlreadyTracking(candidate.mint)) {
    logger.debug(`Already tracking ${candidate.symbol}`);
    return false;
  }
  if (!skipCooldown && isOnCooldown(candidate.mint)) {
    const remainingMin = Math.ceil(getCooldownRemaining(candidate.mint) / 60_000);
    logger.debug(`${candidate.symbol} is on cooldown for ${remainingMin} more minutes`);
    return false;
  }
  if (state.totalCapitalUsd < MAX_POSITION_SIZE_USD) {
    logger.warn('Insufficient capital for new position');
    return false;
  }

  logger.info(`Opening position: ${candidate.symbol} @ $${candidate.priceUsd}`, {
    score: candidate.score.toFixed(2),
    liquidity: candidate.liquidityUsd,
    ageHours: candidate.ageHours?.toFixed(1) ?? 'unknown',
    isNewToken: candidate.isNewToken ?? false,
    buySellRatio: candidate.buySellRatio?.toFixed(2) ?? 'n/a',
  });

  const result = await buyToken(candidate.mint, MAX_POSITION_SIZE_USD);

  if (!result.success || !result.amountToken) {
    logger.error(`Failed to buy ${candidate.symbol}: ${result.error}`);
    return false;
  }

  // Use the scanner's priceUsd (from DexScreener) as the ground-truth entry price.
  // The trader's result.priceUsd is usdSpent/rawTokenAmount which is incorrect for
  // tokens with many decimals (e.g. RAY has 6 decimals, so rawAmount is ~35M).
  const entryPriceUsd = candidate.priceUsd;

  // Tiered TP/SL: new tokens get tighter exits; manual trades can override
  const slPct = (candidate as any)._overrideSlPct ?? (candidate.isNewToken ? NEW_TOKEN_STOP_LOSS_PCT : STOP_LOSS_PCT);
  const tpPct = (candidate as any)._overrideTpPct ?? (candidate.isNewToken ? NEW_TOKEN_TAKE_PROFIT_PCT : TAKE_PROFIT_PCT);
  // noSl/noTp: set prices to extremes so they never trigger automatically
  const stopLossPrice   = noSl ? 0               : entryPriceUsd * (1 - slPct);
  const takeProfitPrice = noTp ? Number.MAX_VALUE : entryPriceUsd * (1 + tpPct);

  const tpLabel = noTp ? 'none (manual)' : `+${(tpPct*100).toFixed(0)}%`;
  const slLabel = noSl ? 'none (manual)' : `-${(slPct*100).toFixed(0)}%`;
  const tierLabel = candidate.isNewToken
    ? `new token (${candidate.ageHours?.toFixed(1)}h old) — TP ${tpLabel} / SL ${slLabel}`
    : `established token — TP ${tpLabel} / SL ${slLabel}`;
  logger.info(`Position tier: ${tierLabel}`);

  const isSniper = candidate.source === 'sniper';

  const position: Position = {
    id: uuidv4(),
    tokenMint: candidate.mint,
    tokenSymbol: candidate.symbol,
    tokenName: candidate.name,
    entryPrice: result.solSpent! / result.amountToken,
    entryPriceUsd,
    entryTime: Date.now(),
    amountToken: result.amountToken,
    solSpent: result.solSpent!,
    usdSpent: result.usdSpent!,
    stopLossPrice,
    takeProfitPrice,
    currentPrice: result.solSpent! / result.amountToken,
    currentPriceUsd: entryPriceUsd,
    isNewToken: candidate.isNewToken ?? false,
    isSniper,
    isManual,
    noTp: noTp || undefined,
    noSl: noSl || undefined,
    status: 'open',
  };

  addPosition(position);

  await alertPositionOpened({
    symbol: candidate.symbol,
    mint: candidate.mint,
    entryPriceUsd,
    usdSpent: result.usdSpent!,
    stopLossPrice,
    takeProfitPrice,
    isNewToken: candidate.isNewToken,
    ageHours: candidate.ageHours,
    isSniper,
    dryRun: DRY_RUN,
  } as any);

  logger.info(`Position opened successfully: ${candidate.symbol}`, {
    id: position.id,
    entry: entryPriceUsd,
    sl: stopLossPrice,
    tp: takeProfitPrice,
  });

  return true;
}

// ─── Monitor Open Positions ───────────────────────────────────────────────────
export async function monitorPositions(getCurrentPrice: (mint: string) => Promise<number | null>): Promise<void> {
  const openPositions = getOpenPositions();
  if (openPositions.length === 0) return;

  logger.debug(`Monitoring ${openPositions.length} open positions`);

  for (const pos of openPositions) {
    try {
      const priceUsd = await getCurrentPrice(pos.tokenMint);
      if (priceUsd === null) {
        logger.warn(`Could not get price for ${pos.tokenSymbol}, skipping`);
        continue;
      }

      const pnlPct = (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * 100;
      logger.debug(`${pos.tokenSymbol}: $${priceUsd.toFixed(6)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`);

      // Update current price in state
      const { updatePosition } = await import('./state');

      // ─── Dump / Liquidity Grab Detection ───────────────────────────────────
      // Maintains a rolling price history. Exits early if:
      //   a) Price dropped >5% in a single cycle (flash crash / rug)
      //   b) Price dropped >8% over the last 3 cycles (~30s trend dump)
      const history = [...(pos.priceHistory ?? []), priceUsd].slice(-5); // keep last 5
      updatePosition(pos.id, { priceHistory: history });

      // Dump detection only fires when position is at a loss (below entry).
      // This prevents false triggers on profitable positions where price wiggles are normal.
      const isAtLoss = priceUsd < pos.entryPriceUsd;

      if (isAtLoss && history.length >= 2) {
        const prevPrice = history[history.length - 2];
        const singleCycleDrop = (prevPrice - priceUsd) / prevPrice;

        if (singleCycleDrop >= DUMP_THRESHOLD_PCT) {
          // Cross-validate: fetch price a second time before acting — protects against DexScreener glitches
          logger.warn(`${pos.tokenSymbol} potential dump: ${(singleCycleDrop*100).toFixed(1)}% drop detected — cross-validating...`);
          await new Promise(r => setTimeout(r, 2_000)); // wait 2s
          const confirmedPrice = await getCurrentPrice(pos.tokenMint);
          if (!confirmedPrice) {
            logger.warn(`${pos.tokenSymbol} — could not confirm dump, skipping exit`);
          } else {
            const confirmedDrop = (prevPrice - confirmedPrice) / prevPrice;
            if (confirmedDrop >= DUMP_THRESHOLD_PCT * 0.7) {
              // Confirmed — use confirmed price for exit
              logger.warn(`${pos.tokenSymbol} DUMP CONFIRMED — dropped ${(confirmedDrop*100).toFixed(1)}% ($${prevPrice.toFixed(6)} → $${confirmedPrice.toFixed(6)})`);
              const pnlUsd = (confirmedPrice - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent;
              const confirmedPnlPct = (confirmedPrice - pos.entryPriceUsd) / pos.entryPriceUsd * 100;
              await alertStopLoss({ symbol: pos.tokenSymbol, mint: pos.tokenMint, pnlUsd, pnlPct: confirmedPnlPct, dryRun: DRY_RUN });
              await executeClose(pos, 'stop_loss', confirmedPrice);
              continue;
            } else {
              logger.info(`${pos.tokenSymbol} — dump NOT confirmed (confirmed price $${confirmedPrice.toFixed(6)}, likely data glitch). Continuing.`);
              // Update price history with confirmed price to avoid re-triggering
              updatePosition(pos.id, { currentPriceUsd: confirmedPrice, priceHistory: [...history.slice(0,-1), confirmedPrice] });
            }
          }
        }
      }

      if (isAtLoss && history.length >= DUMP_LOOKBACK_CYCLES) {
        const oldestInWindow = history[history.length - DUMP_LOOKBACK_CYCLES];
        const trendDrop = (oldestInWindow - priceUsd) / oldestInWindow;

        if (trendDrop >= DUMP_TREND_PCT) {
          logger.warn(`${pos.tokenSymbol} TREND DUMP — dropped ${(trendDrop*100).toFixed(1)}% over ${DUMP_LOOKBACK_CYCLES} cycles ($${oldestInWindow.toFixed(6)} → $${priceUsd.toFixed(6)})`);
          const pnlUsd = (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent;
          await alertStopLoss({ symbol: pos.tokenSymbol, mint: pos.tokenMint, pnlUsd, pnlPct, dryRun: DRY_RUN });
          await executeClose(pos, 'stop_loss', priceUsd);
          continue;
        }
      }

      // ─── Near-TP Trailing Stop ──────────────────────────────────────────────
      // Activates when price is within NEAR_TP_THRESHOLD (5%) of take profit.
      // Tracks peak price; if it drops NEAR_TP_TRAIL_PCT (3%) from peak → close.
      const distanceToTp = (pos.takeProfitPrice - priceUsd) / pos.takeProfitPrice;
      const inNearTpZone = distanceToTp <= NEAR_TP_THRESHOLD && priceUsd < pos.takeProfitPrice;

      if (inNearTpZone) {
        const currentPeak = pos.peakPriceUsd ?? priceUsd;
        const newPeak = Math.max(currentPeak, priceUsd);

        if (newPeak > currentPeak) {
          updatePosition(pos.id, { currentPriceUsd: priceUsd, peakPriceUsd: newPeak });
          logger.info(`${pos.tokenSymbol} in near-TP zone — new peak $${newPeak.toFixed(6)} (${((newPeak/pos.entryPriceUsd-1)*100).toFixed(1)}%)`);
        } else {
          updatePosition(pos.id, { currentPriceUsd: priceUsd });
        }

        const dropFromPeak = (newPeak - priceUsd) / newPeak;
        if (dropFromPeak >= NEAR_TP_TRAIL_PCT) {
          logger.info(`${pos.tokenSymbol} near-TP trailing stop triggered — dropped ${(dropFromPeak*100).toFixed(1)}% from peak $${newPeak.toFixed(6)}`);
          const pnlUsd = (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent;

          await alertTakeProfit({
            symbol: pos.tokenSymbol,
            mint: pos.tokenMint,
            pnlUsd,
            pnlPct,
            dryRun: DRY_RUN,
          });

          await executeClose(pos, 'take_profit', priceUsd);
          continue;
        }
      } else {
        // ─── High Watermark Trailing Stop ────────────────────────────────────
        // Once position is up HIGH_WATERMARK_ACTIVATE (15%), track peak.
        // If price drops HIGH_WATERMARK_TRAIL_PCT (6%) from that peak → close.
        const gainPct = (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd;
        if (gainPct >= HIGH_WATERMARK_ACTIVATE) {
          const currentPeak = pos.peakPriceUsd ?? priceUsd;
          const newPeak = Math.max(currentPeak, priceUsd);
          updatePosition(pos.id, { currentPriceUsd: priceUsd, peakPriceUsd: newPeak });

          const dropFromPeak = (newPeak - priceUsd) / newPeak;
          if (dropFromPeak >= HIGH_WATERMARK_TRAIL_PCT) {
            logger.info(`${pos.tokenSymbol} high-watermark stop — dropped ${(dropFromPeak*100).toFixed(1)}% from peak $${newPeak.toFixed(6)} (position was +${(gainPct*100).toFixed(1)}%)`);
            const pnlUsd = (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent;
            await alertTakeProfit({
              symbol: pos.tokenSymbol,
              mint: pos.tokenMint,
              pnlUsd,
              pnlPct,
              dryRun: DRY_RUN,
            });
            await executeClose(pos, 'take_profit', priceUsd);
            continue;
          }
        } else {
          updatePosition(pos.id, { currentPriceUsd: priceUsd });
        }
      }

      // ─── Sniper trailing stop ─────────────────────────────────────────────
      // For sniper positions: no fixed TP, just trail 10% from highest price seen.
      if (pos.isSniper) {
        const peak = pos.peakPriceUsd ?? priceUsd;
        const newPeak = Math.max(peak, priceUsd);
        updatePosition(pos.id, { peakPriceUsd: newPeak, currentPriceUsd: priceUsd });

        const dropFromPeak = (newPeak - priceUsd) / newPeak;
        if (dropFromPeak >= SNIPER_TRAIL_PCT) {
          const pnlUsd = (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent;
          const isProfit = pnlUsd >= 0;
          logger.info(`🎯 Sniper trailing stop: ${pos.tokenSymbol} — peak $${newPeak.toFixed(8)} → now $${priceUsd.toFixed(8)} (${(dropFromPeak*100).toFixed(1)}% drop) | P&L: ${isProfit?'+':''}$${pnlUsd.toFixed(2)}`);

          if (isProfit) {
            await alertTakeProfit({ symbol: pos.tokenSymbol, mint: pos.tokenMint, pnlUsd, pnlPct, dryRun: DRY_RUN });
          } else {
            await alertStopLoss({ symbol: pos.tokenSymbol, mint: pos.tokenMint, pnlUsd, pnlPct, dryRun: DRY_RUN });
          }
          await executeClose(pos, isProfit ? 'take_profit' : 'stop_loss', priceUsd);
          continue;
        }
        continue; // sniper positions skip normal SL/TP checks
      }

      // Check limit sell (manual target price — takes priority over SL/TP)
      if (pos.limitSellPrice && priceUsd >= pos.limitSellPrice) {
        const pnlUsd = (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent;
        logger.info(`🎯 Limit sell triggered for ${pos.tokenSymbol}: $${priceUsd.toFixed(8)} >= $${pos.limitSellPrice.toFixed(8)} | P&L: ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)}`);
        await executeClose(pos, 'take_profit', priceUsd);
        continue;
      }

      // Check stop loss (skipped if noSl flag set)
      if (!pos.noSl && priceUsd <= pos.stopLossPrice) {
        logger.warn(`Stop loss triggered for ${pos.tokenSymbol}: $${priceUsd.toFixed(6)} <= $${pos.stopLossPrice.toFixed(6)}`);

        await alertStopLoss({
          symbol: pos.tokenSymbol,
          mint: pos.tokenMint,
          pnlUsd: (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent,
          pnlPct,
          dryRun: DRY_RUN,
        });

        await executeClose(pos, 'stop_loss', priceUsd);
        continue;
      }

      // Check take profit (skipped if noTp flag set)
      if (!pos.noTp && priceUsd >= pos.takeProfitPrice) {
        logger.info(`Take profit triggered for ${pos.tokenSymbol}: $${priceUsd.toFixed(6)} >= $${pos.takeProfitPrice.toFixed(6)}`);

        await alertTakeProfit({
          symbol: pos.tokenSymbol,
          mint: pos.tokenMint,
          pnlUsd: (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent,
          pnlPct,
          dryRun: DRY_RUN,
        });

        await executeClose(pos, 'take_profit', priceUsd);
        continue;
      }

      // Check portfolio stop
      if (checkPortfolioStop()) {
        logger.error('Portfolio stop reached — closing all positions');
        const totalPnl = getState().realizedPnlUsd;
        await alertPortfolioStop({ totalLossUsd: totalPnl, dryRun: DRY_RUN });
        setPortfolioStop();
        await executeClose(pos, 'portfolio_stop', priceUsd);
      }
    } catch (err: any) {
      logger.error(`Error monitoring position ${pos.tokenSymbol}`, { error: err?.message });
    }
  }
}

// ─── Execute Close ────────────────────────────────────────────────────────────
async function executeClose(
  pos: Position,
  reason: Position['closeReason'],
  priceUsd: number
): Promise<void> {
  const sellResult = await sellToken(pos.tokenMint, pos.amountToken, priceUsd);

  const actualPriceUsd = sellResult.usdReceived && pos.amountToken > 0
    ? sellResult.usdReceived / pos.amountToken
    : priceUsd;

  const closed = closePosition(pos.id, reason, actualPriceUsd);
  if (!closed) return;

  // Set cooldown so we don't immediately re-enter the same token
  setCooldown(pos.tokenMint, TOKEN_COOLDOWN_MS);
  logger.info(`Cooldown set for ${pos.tokenSymbol} — won't re-enter for 6h`);

  const reasonLabel = reason === 'stop_loss' ? '🛑 Stop Loss'
    : reason === 'take_profit' ? '🎯 Take Profit'
    : reason === 'portfolio_stop' ? '🚨 Portfolio Stop'
    : '📋 Manual';

  await alertPositionClosed({
    symbol: pos.tokenSymbol,
    mint: pos.tokenMint,
    entryPriceUsd: pos.entryPriceUsd,
    exitPriceUsd: actualPriceUsd,
    pnlUsd: closed.pnlUsd || 0,
    pnlPct: closed.pnlPct || 0,
    reason: reasonLabel,
    dryRun: DRY_RUN,
  });

  logger.info(`Position closed: ${pos.tokenSymbol}`, {
    reason,
    pnl: `${(closed.pnlPct || 0).toFixed(1)}%`,
    pnlUsd: (closed.pnlUsd || 0).toFixed(2),
  });
}

// ─── Close All Positions (emergency) ─────────────────────────────────────────
export async function closeAllPositions(reason: Position['closeReason'] = 'manual'): Promise<void> {
  const open = getOpenPositions();
  logger.warn(`Closing all ${open.length} open positions (reason: ${reason})`);

  for (const pos of open) {
    try {
      const { getCurrentPrice } = await import('./scanner');
      const price = await getCurrentPrice(pos.tokenMint);
      if (price) {
        await executeClose(pos, reason, price);
      }
    } catch (err: any) {
      logger.error(`Failed to close ${pos.tokenSymbol}`, { error: err?.message });
    }
  }
}
