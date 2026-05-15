import axios from 'axios';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } from './config';
import logger from './logger';

const TELEGRAM_BASE = 'https://api.telegram.org';

function isConfigured(): boolean {
  return !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
}

async function sendMessage(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<void> {
  if (!isConfigured()) {
    logger.info('[Telegram] Not configured — local log only:', { text });
    return;
  }

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await axios.post(
        `${TELEGRAM_BASE}/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        },
        { timeout: 10_000 }
      );
      return; // success
    } catch (err: any) {
      if (attempt === maxRetries) {
        logger.warn('[Telegram] Failed to send message after 3 attempts', {
          error: err?.message,
          text: text.slice(0, 100),
        });
      } else {
        const delay = attempt * 2000; // 2s, 4s
        logger.debug(`[Telegram] Send failed (attempt ${attempt}), retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
}

export async function alertPositionOpened(params: {
  symbol: string;
  mint: string;
  entryPriceUsd: number;
  usdSpent: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  isNewToken?: boolean;
  ageHours?: number;
  dryRun: boolean;
}): Promise<void> {
  const { symbol, mint, entryPriceUsd, usdSpent, stopLossPrice, takeProfitPrice, isNewToken, ageHours, dryRun } = params;
  const tag = dryRun ? '🧪 [DRY RUN] ' : '';
  const chartUrl = `https://dexscreener.com/solana/${mint}`;
  const isSniper = (params as any).isSniper;
  const tierLabel = isSniper
    ? `🎯 Sniper (${ageHours?.toFixed(1)}h old)`
    : isNewToken ? `🆕 New token (${ageHours?.toFixed(1)}h old)` : '📊 Established token';

  let exitInfo: string;
  if (isSniper) {
    exitInfo = `🎯 Trailing Stop: 10% from peak (no fixed TP — lets winners run)`;
  } else {
    const slPct = ((entryPriceUsd - stopLossPrice) / entryPriceUsd * 100).toFixed(0);
    const tpPct = ((takeProfitPrice - entryPriceUsd) / entryPriceUsd * 100).toFixed(0);
    exitInfo = `🛑 Stop Loss: $${stopLossPrice.toFixed(6)} (-${slPct}%)\n🎯 Take Profit: $${takeProfitPrice.toFixed(6)} (+${tpPct}%)`;
  }

  const msg = `${tag}📈 <b>Position Opened</b>
🪙 <a href="${chartUrl}">${symbol}</a> — <code>${mint}</code>
${tierLabel}
💵 Entry: $${entryPriceUsd.toFixed(6)}
💰 Size: $${usdSpent.toFixed(2)}
${exitInfo}`;
  logger.info(`[Telegram] Position opened: ${symbol}`);
  await sendMessage(msg);
}

export async function alertPositionClosed(params: {
  symbol: string;
  mint: string;
  entryPriceUsd: number;
  exitPriceUsd: number;
  pnlUsd: number;
  pnlPct: number;
  reason: string;
  dryRun: boolean;
}): Promise<void> {
  const { symbol, mint, entryPriceUsd, exitPriceUsd, pnlUsd, pnlPct, reason, dryRun } = params;
  const tag = dryRun ? '🧪 [DRY RUN] ' : '';
  const emoji = pnlUsd >= 0 ? '✅' : '❌';
  const pnlSign = pnlUsd >= 0 ? '+' : '';
  const chartUrl = `https://dexscreener.com/solana/${mint}`;
  const msg = `${tag}${emoji} <b>Position Closed</b>
🪙 <a href="${chartUrl}">${symbol}</a>
📊 Reason: ${reason}
💵 Entry: $${entryPriceUsd.toFixed(6)} → Exit: $${exitPriceUsd.toFixed(6)}
💰 P&L: ${pnlSign}$${pnlUsd.toFixed(2)} (${pnlSign}${pnlPct.toFixed(1)}%)`;
  logger.info(`[Telegram] Position closed: ${symbol}, P&L: ${pnlSign}${pnlPct.toFixed(1)}%`);
  await sendMessage(msg);
}

export async function alertStopLoss(params: {
  symbol: string;
  mint: string;
  pnlUsd: number;
  pnlPct: number;
  dryRun: boolean;
}): Promise<void> {
  const { symbol, mint, pnlUsd, pnlPct, dryRun } = params;
  const tag = dryRun ? '🧪 [DRY RUN] ' : '';
  const msg = `${tag}🛑 <b>Stop Loss Hit</b>
🪙 ${symbol} (<code>${mint.slice(0, 8)}...</code>)
📉 Loss: $${pnlUsd.toFixed(2)} (${pnlPct.toFixed(1)}%)`;
  logger.warn(`[Telegram] Stop loss hit: ${symbol}, loss: ${pnlPct.toFixed(1)}%`);
  await sendMessage(msg);
}

export async function alertTakeProfit(params: {
  symbol: string;
  mint: string;
  pnlUsd: number;
  pnlPct: number;
  dryRun: boolean;
}): Promise<void> {
  const { symbol, mint, pnlUsd, pnlPct, dryRun } = params;
  const tag = dryRun ? '🧪 [DRY RUN] ' : '';
  const msg = `${tag}🎯 <b>Take Profit Hit</b>
🪙 ${symbol} (<code>${mint.slice(0, 8)}...</code>)
📈 Profit: +$${pnlUsd.toFixed(2)} (+${pnlPct.toFixed(1)}%)`;
  logger.info(`[Telegram] Take profit hit: ${symbol}, profit: +${pnlPct.toFixed(1)}%`);
  await sendMessage(msg);
}

export async function alertPortfolioStop(params: {
  totalLossUsd: number;
  dryRun: boolean;
}): Promise<void> {
  const { totalLossUsd, dryRun } = params;
  const tag = dryRun ? '🧪 [DRY RUN] ' : '';
  const msg = `${tag}🚨 <b>PORTFOLIO STOP TRIGGERED</b>
💸 Total Loss: $${Math.abs(totalLossUsd).toFixed(2)}
⛔ Bot has stopped trading. Manual review required.`;
  logger.error(`[Telegram] Portfolio stop triggered! Total loss: $${Math.abs(totalLossUsd).toFixed(2)}`);
  await sendMessage(msg);
}

export async function alertError(message: string, details?: string): Promise<void> {
  const msg = `⚠️ <b>Bot Error</b>
${message}${details ? '\n<pre>' + details.slice(0, 300) + '</pre>' : ''}`;
  logger.error(`[Telegram] Error alert: ${message}`);
  await sendMessage(msg);
}

let _lastTelegramHeartbeat = 0;
const TELEGRAM_HEARTBEAT_MIN_INTERVAL_MS = 60 * 60 * 1000; // 1 hour between Telegram heartbeats

export async function alertHeartbeat(params: {
  uptime: string;
  openPositions: number;
  realizedPnlUsd: number;
  totalCapitalUsd: number;
  dryRun: boolean;
  positions?: Array<{
    symbol: string;
    entryPriceUsd: number;
    currentPriceUsd: number;
    usdSpent: number;
    takeProfitPrice: number;
    stopLossPrice: number;
  }>;
}): Promise<void> {
  const { uptime, openPositions, realizedPnlUsd, totalCapitalUsd, dryRun, positions } = params;
  const tag = dryRun ? '[DRY RUN] ' : '';
  const pnlSign = realizedPnlUsd >= 0 ? '+' : '';

  let posLines = '';
  if (positions && positions.length > 0) {
    posLines = '\n\n<b>Open Positions:</b>';
    for (const p of positions) {
      const pnlPct = (p.currentPriceUsd - p.entryPriceUsd) / p.entryPriceUsd * 100;
      const unrealizedUsd = (p.currentPriceUsd - p.entryPriceUsd) / p.entryPriceUsd * p.usdSpent;
      const pSign = pnlPct >= 0 ? '+' : '';
      const emoji = pnlPct >= 5 ? '🟢' : pnlPct <= -5 ? '🔴' : '🟡';
      const tpDist = ((p.takeProfitPrice - p.currentPriceUsd) / p.currentPriceUsd * 100).toFixed(1);
      const slDist = ((p.currentPriceUsd - p.stopLossPrice) / p.currentPriceUsd * 100).toFixed(1);
      posLines += `\n${emoji} <b>${p.symbol}</b>: $${p.currentPriceUsd.toFixed(4)} (${pSign}${pnlPct.toFixed(1)}% / ${pSign}$${unrealizedUsd.toFixed(2)})`;
      posLines += `\n   🎯 TP ${tpDist}% away · 🛑 SL ${slDist}% away`;
    }
  } else if (openPositions === 0) {
    posLines = '\n\n💤 No open positions — scanning for entries';
  }

  const msg = `💓 ${tag}<b>Heartbeat</b>
⏱ Uptime: ${uptime}
💰 Capital: $${totalCapitalUsd.toFixed(2)} | P&L: ${pnlSign}$${realizedPnlUsd.toFixed(2)}${posLines}`;

  if (!isConfigured()) return;

  const now = Date.now();
  const hourElapsed = now - _lastTelegramHeartbeat >= TELEGRAM_HEARTBEAT_MIN_INTERVAL_MS;

  // Always send every hour so you know the bot is alive, regardless of positions
  if (hourElapsed) {
    await sendMessage(msg);
    _lastTelegramHeartbeat = now;
  }
}

export { sendMessage };
