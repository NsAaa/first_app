/**
 * Telegram Menu & Command Handler
 *
 * Listens for incoming messages/callbacks via long-polling.
 * Supports:
 *   /start, /menu   — show main menu
 *   /status         — portfolio summary
 *   /positions      — open positions with individual close buttons
 *   /history        — last 10 closed trades
 *   /pause          — pause new entries (monitor only)
 *   /resume         — resume scanning
 *   /mode           — show/switch scan mode
 *   /config         — show current settings
 *   /closeall       — close all positions
 *   <Solana CA>     — analyse token, offer to open
 *   /trade <CA> [tp=X] [sl=Y] — manual trade with custom TP/SL
 */

import axios from 'axios';
import fs from 'fs';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, DRY_RUN, SCAN_MODE,
  STOP_LOSS_PCT, TAKE_PROFIT_PCT, NEW_TOKEN_STOP_LOSS_PCT, NEW_TOKEN_TAKE_PROFIT_PCT,
  MAX_SIMULTANEOUS_POSITIONS, MAX_POSITION_SIZE_USD, DEXSCREENER_API } from './config';

// Runtime scan mode override (can be changed without restart)
let _scanModeOverride: string | null = null;
export function getActiveScanMode(): string { return _scanModeOverride ?? SCAN_MODE; }
import { getState, getOpenPositions } from './state';
import { closeAllPositions } from './positions';
import { sendMessage } from './telegram';
import logger from './logger';

const BASE = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
let _offset = 0;
let _paused = false;
let _pendingTrade: { mint: string; symbol: string; priceUsd: number; isNewToken: boolean } | null = null;

// ─── Limit Buy Orders ────────────────────────────────────────────────────────
export interface LimitBuyOrder {
  mint: string;
  symbol: string;
  limitPrice: number;    // buy when price drops to this level
  noTp?: boolean;
  noSl?: boolean;
  tpPct?: number;
  slPct?: number;
  forceEntry?: boolean;
  isNewToken?: boolean;
  createdAt: number;
}
let _limitBuyOrders: LimitBuyOrder[] = [];
export function getLimitBuyOrders(): LimitBuyOrder[] { return [..._limitBuyOrders]; }
export function removeLimitBuyOrder(mint: string): void {
  _limitBuyOrders = _limitBuyOrders.filter(o => o.mint !== mint);
}

export function isScanPaused(): boolean { return _paused; }

// ─── Inline keyboard helpers ──────────────────────────────────────────────────
function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '📊 Status', callback_data: 'status' }, { text: '💼 Positions', callback_data: 'positions' }],
      [{ text: '📈 History', callback_data: 'history' }, { text: '⚙️ Config', callback_data: 'config' }],
      [{ text: '⏸ Pause', callback_data: 'pause' }, { text: '▶️ Resume', callback_data: 'resume' }],
      [{ text: '🔄 Switch Mode', callback_data: 'mode' }, { text: '🎯 Sniper Mode', callback_data: 'sniper_toggle' }],
      [{ text: '🔒 Close All', callback_data: 'closeall_confirm' }],
    ]
  };
}

async function sendWithKeyboard(text: string, keyboard: any): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await axios.post(`${BASE}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true,
    }, { timeout: 10_000 });
  } catch (err: any) {
    logger.warn('[Menu] Failed to send keyboard message', { error: err?.message });
  }
}

async function answerCallback(callbackId: string, text?: string): Promise<void> {
  try {
    await axios.post(`${BASE}/answerCallbackQuery`, {
      callback_query_id: callbackId,
      text: text || '',
    }, { timeout: 5_000 });
  } catch (_) {}
}

async function editMessage(chatId: string, messageId: number, text: string, keyboard?: any): Promise<void> {
  try {
    await axios.post(`${BASE}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      reply_markup: keyboard,
      disable_web_page_preview: true,
    }, { timeout: 10_000 });
  } catch (_) {}
}

// ─── Command handlers ─────────────────────────────────────────────────────────
function buildStatusText(): string {
  const state = getState();
  const open = getOpenPositions();
  const sign = state.realizedPnlUsd >= 0 ? '+' : '';
  const mode = DRY_RUN ? '🧪 DRY RUN' : '⚡ LIVE';
  const scanStatus = _paused ? '⏸ Paused' : `▶️ ${SCAN_MODE}`;
  return `📊 <b>Bot Status</b>
${mode} | Scan: ${scanStatus}
💰 Capital: $${state.totalCapitalUsd.toFixed(2)}
📈 Realized P&L: ${sign}$${state.realizedPnlUsd.toFixed(2)}
💼 Open positions: ${open.length}/${MAX_SIMULTANEOUS_POSITIONS}`;
}

function buildPositionsText(): { text: string; keyboard: any } {
  const open = getOpenPositions();
  const limitOrders = getLimitBuyOrders();
  if (open.length === 0 && limitOrders.length === 0) {
    return { text: '💼 <b>No open positions</b>\n\n💤 Bot is scanning for entries...', keyboard: { inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'positions' }, { text: '🏠 Menu', callback_data: 'menu' }]] } };
  }

  let text = '💼 <b>Open Positions</b>\n\n';
  const buttons: any[] = [];

  for (const p of open) {
    const cur = p.currentPriceUsd ?? p.entryPriceUsd;
    const pct = (cur - p.entryPriceUsd) / p.entryPriceUsd * 100;
    const unreal = (cur - p.entryPriceUsd) / p.entryPriceUsd * p.usdSpent;
    const emoji = pct >= 5 ? '🟢' : pct <= -5 ? '🔴' : '🟡';
    const sign = pct >= 0 ? '+' : '';
    const chartUrl = `https://dexscreener.com/solana/${p.tokenMint}`;
    const new_ = p.isNewToken ? '🆕' : '📊';
    const manualTag = p.isManual ? ' ✏️' : '';

    const tpDisplay = p.noTp ? 'none' : `${((p.takeProfitPrice - cur) / cur * 100).toFixed(1)}% away`;
    const slDisplay = p.noSl ? 'none' : `${((cur - p.stopLossPrice) / cur * 100).toFixed(1)}% away`;
    const limitSellLine = p.limitSellPrice ? `\n   📌 Limit sell: $${p.limitSellPrice.toFixed(8)}` : '';

    text += `${emoji} ${new_}${manualTag} <a href="${chartUrl}"><b>${p.tokenSymbol}</b></a>\n`;
    text += `   $${cur.toFixed(6)} | ${sign}${pct.toFixed(1)}% (${sign}$${unreal.toFixed(2)})\n`;
    text += `   🎯 TP ${tpDisplay} · 🛑 SL ${slDisplay}${limitSellLine}\n\n`;

    buttons.push([
      { text: `❌ Close ${p.tokenSymbol}`, callback_data: `close_${p.id}` },
      { text: `📌 Set Limit Sell`, callback_data: `setlimit_${p.id}` },
    ]);
  }

  if (limitOrders.length > 0) {
    text += `⏳ <b>Pending Limit Buys</b>\n`;
    for (const o of limitOrders) {
      text += `   ${o.symbol} — buy ≤ $${o.limitPrice.toFixed(8)}\n`;
      buttons.push([{ text: `❌ Cancel limit: ${o.symbol}`, callback_data: `cancellimit_${o.mint}` }]);
    }
    text += '\n';
  }

  buttons.push([{ text: '🔄 Refresh', callback_data: 'positions' }]);
  buttons.push([{ text: '🔒 Close All', callback_data: 'closeall_confirm' }, { text: '🏠 Menu', callback_data: 'menu' }]);
  return { text, keyboard: { inline_keyboard: buttons } };
}

function buildHistoryText(): string {
  const state = getState();
  const closed = state.positions
    .filter(p => p.status === 'closed' && p.closedAt)
    .sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0))
    .slice(0, 10);

  if (closed.length === 0) return '📈 <b>No closed trades yet</b>';

  let text = '📈 <b>Last 10 Trades</b>\n\n';
  for (const p of closed) {
    const pnl = p.pnlUsd || 0;
    const pct = p.pnlPct || 0;
    const sign = pnl >= 0 ? '+' : '';
    const emoji = pnl >= 0 ? '✅' : '❌';
    const reason = p.closeReason === 'take_profit' ? '🎯' : p.closeReason === 'stop_loss' ? '🛑' : '📋';
    text += `${emoji} <b>${p.tokenSymbol}</b> ${reason} ${sign}$${pnl.toFixed(2)} (${sign}${pct.toFixed(1)}%)\n`;
  }

  const wins = closed.filter(p => (p.pnlUsd || 0) > 0).length;
  text += `\n<i>${wins}/${closed.length} wins in last 10</i>`;
  return text;
}

function buildConfigText(): string {
  const activeMode = _scanModeOverride ?? SCAN_MODE;
  return `⚙️ <b>Current Config</b>
Mode: ${DRY_RUN ? '🧪 DRY RUN' : '⚡ LIVE'} | Scan: ${activeMode}${_scanModeOverride ? ' (runtime override)' : ''}
Scan paused: ${_paused ? 'Yes ⏸' : 'No ▶️'}

<b>Established tier (24h+):</b>
  TP: +${(TAKE_PROFIT_PCT * 100).toFixed(0)}% | SL: -${(STOP_LOSS_PCT * 100).toFixed(0)}%

<b>New token tier (3-24h):</b>
  TP: +${(NEW_TOKEN_TAKE_PROFIT_PCT * 100).toFixed(0)}% | SL: -${(NEW_TOKEN_STOP_LOSS_PCT * 100).toFixed(0)}%

Position size: $${MAX_POSITION_SIZE_USD} per trade
Max positions: ${MAX_SIMULTANEOUS_POSITIONS} (3 per tier)`;
}

// ─── Token analysis ───────────────────────────────────────────────────────────
async function analyseToken(mint: string): Promise<void> {
  await sendMessage('🔍 Analysing token, please wait...');

  try {
    const resp = await axios.get(`${DEXSCREENER_API}/tokens/${mint}`, { timeout: 12_000 });
    const pairs = (resp.data?.pairs || []).filter((p: any) => p.chainId === 'solana');

    if (pairs.length === 0) {
      await sendMessage('❌ No Solana pairs found for this token. Check the address and try again.');
      return;
    }

    pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const pair = pairs[0];
    const symbol = pair.baseToken?.symbol || 'UNKNOWN';
    const priceUsd = parseFloat(pair.priceUsd || '0');
    const liquidity = pair.liquidity?.usd || 0;
    const volume24h = pair.volume?.h24 || 0;
    const marketCap = pair.marketCap || pair.fdv || 0;
    const createdAt = pair.pairCreatedAt || 0;
    const ageHours = createdAt ? (Date.now() - createdAt) / 3_600_000 : 9999;
    const pc24 = pair.priceChange?.h24 || 0;
    const pc1 = pair.priceChange?.h1 || 0;
    const buys = pair.txns?.h24?.buys || 0;
    const sells = pair.txns?.h24?.sells || 0;
    const bsRatio = sells > 0 ? (buys / sells).toFixed(2) : buys > 0 ? '∞' : '0';
    const isNewToken = ageHours >= 3 && ageHours < 24;
    const chartUrl = `https://dexscreener.com/solana/${mint}`;

    // Qualification checks
    const checks: string[] = [];
    let qualifies = true;

    if (priceUsd <= 0) { checks.push('❌ No price data'); qualifies = false; }
    if (ageHours < 3) { checks.push(`❌ Too new (${ageHours.toFixed(1)}h — min 3h)`); qualifies = false; }
    else if (ageHours < 24) checks.push(`✅ Age: ${ageHours.toFixed(1)}h (new tier)`);
    else checks.push(`✅ Age: ${ageHours.toFixed(0)}h (established)`);

    const minLiq = isNewToken ? 10_000 : 1_000_000;
    if (liquidity < minLiq) { checks.push(`❌ Liquidity too low ($${Math.round(liquidity).toLocaleString()} < $${minLiq.toLocaleString()})`); qualifies = false; }
    else checks.push(`✅ Liquidity: $${Math.round(liquidity).toLocaleString()}`);

    if (pc24 <= 0) { checks.push(`❌ Not trending up (${pc24.toFixed(1)}% 24h)`); qualifies = false; }
    else checks.push(`✅ 24h change: +${pc24.toFixed(1)}%`);

    const bsNum = sells > 0 ? buys / sells : 99;
    if (isNewToken && bsNum < 1.2) { checks.push(`⚠️ Low buy/sell ratio (${bsRatio})`); qualifies = false; }
    else checks.push(`✅ Buy/sell ratio: ${bsRatio}`);

    if (isNewToken && marketCap > 50_000_000) { checks.push(`❌ Market cap too high ($${(marketCap/1e6).toFixed(1)}M > $50M)`); qualifies = false; }

    const tpPct = isNewToken ? NEW_TOKEN_TAKE_PROFIT_PCT : TAKE_PROFIT_PCT;
    const slPct = isNewToken ? NEW_TOKEN_STOP_LOSS_PCT : STOP_LOSS_PCT;
    const tpPrice = priceUsd * (1 + tpPct);
    const slPrice = priceUsd * (1 - slPct);

    const tierLabel = isNewToken ? '🆕 New token tier' : '📊 Established tier';
    const verdict = qualifies ? '✅ <b>QUALIFIES for entry</b>' : '❌ <b>Does not qualify</b>';

    const text = `🔍 <b>Token Analysis: <a href="${chartUrl}">${symbol}</a></b>
${tierLabel}

💵 Price: $${priceUsd.toFixed(8)}
💧 Liquidity: $${Math.round(liquidity).toLocaleString()}
📊 Volume 24h: $${Math.round(volume24h).toLocaleString()}
🏦 Market Cap: ${marketCap > 0 ? '$' + (marketCap / 1e6).toFixed(2) + 'M' : 'N/A'}
⏱ Age: ${ageHours.toFixed(1)}h
📈 24h: ${pc24 > 0 ? '+' : ''}${pc24.toFixed(1)}% | 1h: ${pc1 > 0 ? '+' : ''}${pc1.toFixed(1)}%
🤝 Buys/Sells: ${bsRatio}

<b>Checks:</b>
${checks.join('\n')}

${verdict}
${qualifies ? `\n🎯 TP: $${tpPrice.toFixed(8)} (+${(tpPct * 100).toFixed(0)}%)\n🛑 SL: $${slPrice.toFixed(8)} (-${(slPct * 100).toFixed(0)}%)` : ''}`;

    const keyboard = qualifies ? {
      inline_keyboard: [
        [
          { text: '✅ Open (auto params)', callback_data: `open_auto_${mint}` },
          { text: '✏️ Custom TP/SL', callback_data: `open_custom_${mint}` },
        ],
        [{ text: '❌ Skip', callback_data: 'menu' }]
      ]
    } : {
      inline_keyboard: [[
        { text: '📋 Open anyway (manual)', callback_data: `open_custom_${mint}` },
        { text: '🏠 Menu', callback_data: 'menu' }
      ]]
    };

    // Store pending trade info for callback
    _pendingTrade = { mint, symbol, priceUsd, isNewToken };

    await sendWithKeyboard(text, keyboard);
  } catch (err: any) {
    logger.warn('[Menu] Token analysis failed', { error: err?.message });
    await sendMessage('❌ Failed to fetch token data. Check the address and try again.');
  }
}

// ─── Process incoming updates ─────────────────────────────────────────────────
async function processUpdate(update: any): Promise<void> {
  // Handle callback queries (button taps)
  if (update.callback_query) {
    const cb = update.callback_query;
    const data = cb.data as string;
    const chatId = cb.message?.chat?.id?.toString();
    const messageId = cb.message?.message_id;

    await answerCallback(cb.id);

    if (data === 'menu' || data === 'start') {
      await sendWithKeyboard('🤖 <b>Bot Control Panel</b>\nWhat would you like to do?', mainMenuKeyboard());

    } else if (data === 'status') {
      await editMessage(chatId, messageId, buildStatusText(), {
        inline_keyboard: [[{ text: '🔄 Refresh', callback_data: 'status' }, { text: '🏠 Menu', callback_data: 'menu' }]]
      });

    } else if (data === 'positions') {
      const { text, keyboard } = buildPositionsText();
      await editMessage(chatId, messageId, text, keyboard);

    } else if (data === 'history') {
      await editMessage(chatId, messageId, buildHistoryText(), {
        inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu' }]]
      });

    } else if (data === 'config') {
      await editMessage(chatId, messageId, buildConfigText(), {
        inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu' }]]
      });

    } else if (data === 'pause') {
      _paused = true;
      await editMessage(chatId, messageId, '⏸ <b>Scanning paused</b>\nBot will monitor open positions but not open new ones.', {
        inline_keyboard: [[{ text: '▶️ Resume', callback_data: 'resume' }, { text: '🏠 Menu', callback_data: 'menu' }]]
      });

    } else if (data === 'resume') {
      _paused = false;
      await editMessage(chatId, messageId, '▶️ <b>Scanning resumed</b>\nBot is actively looking for new entries.', {
        inline_keyboard: [[{ text: '⏸ Pause', callback_data: 'pause' }, { text: '🏠 Menu', callback_data: 'menu' }]]
      });

    } else if (data === 'mode') {
      const modes = ['both', 'established', 'new', 'sniper'];
      const current = SCAN_MODE;
      await editMessage(chatId, messageId,
        `🔄 <b>Scan Mode</b>\nCurrent: <b>${current}</b>\n\nModes:\n• <b>both</b> — established + new tokens\n• <b>established</b> — 24h+ tokens only\n• <b>new</b> — new tokens (4-24h)\n• <b>sniper</b> — brand new tokens &lt;2h, trailing stop only\n\n<i>Tap a mode to switch:</i>`, {
        inline_keyboard: [
          [
            { text: current === 'both' ? '✅ both' : 'both', callback_data: 'set_mode_both' },
            { text: current === 'established' ? '✅ established' : 'established', callback_data: 'set_mode_established' },
          ],
          [
            { text: current === 'new' ? '✅ new' : 'new', callback_data: 'set_mode_new' },
            { text: current === 'sniper' ? '✅ 🎯 sniper' : '🎯 sniper', callback_data: 'set_mode_sniper' },
          ],
          [{ text: '🏠 Menu', callback_data: 'menu' }]
        ]
      });

    } else if (data === 'sniper_toggle') {
      const current = SCAN_MODE;
      const newMode = current === 'sniper' ? 'new' : 'sniper';
      // Write to .env and notify — requires restart
      await editMessage(chatId, messageId,
        `🎯 <b>Sniper Mode</b>\n\nCurrently: <b>${current}</b>\n\nSniper mode targets brand new tokens (&lt;2h old) with a 10% trailing stop and no fixed TP. Lets winners run, cuts losses at 10% from peak.\n\n⚠️ This is high risk — expect more SL hits but hunting for big early movers.\n\n<i>Use the Mode menu to switch modes.</i>`, {
        inline_keyboard: [
          [
            { text: '🎯 Enable Sniper', callback_data: 'set_mode_sniper' },
            { text: '↩️ Back to New', callback_data: 'set_mode_new' },
          ],
          [{ text: '🏠 Menu', callback_data: 'menu' }]
        ]
      });

    } else if (data.startsWith('set_mode_')) {
      const newMode = data.replace('set_mode_', '') as any;
      _scanModeOverride = newMode;
      const modeEmoji: Record<string, string> = { sniper: '🎯', new: '🆕', established: '📊', both: '🔄' };
      await editMessage(chatId, messageId,
        `${modeEmoji[newMode] || '🔄'} <b>Mode switched to: ${newMode}</b>\n\n${newMode === 'sniper' ? '🎯 Sniper active — hunting tokens &lt;2h old with 10% trailing stop. No fixed TP.' : newMode === 'new' ? '🆕 New token mode — tokens 4-24h old.' : newMode === 'established' ? '📊 Established mode — tokens 24h+ old.' : '🔄 Both tiers active.'}\n\n<i>Takes effect on next scan cycle.</i>`, {
        inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'menu' }]]
      });
      logger.info(`[Menu] Scan mode changed to: ${newMode}`);

    } else if (data === 'closeall_confirm') {
      await editMessage(chatId, messageId, '⚠️ <b>Close All Positions?</b>\nThis will immediately close all open positions at market price.', {
        inline_keyboard: [
          [{ text: '✅ Yes, close all', callback_data: 'closeall_execute' }, { text: '❌ Cancel', callback_data: 'positions' }]
        ]
      });

    } else if (data === 'closeall_execute') {
      await editMessage(chatId, messageId, '🔒 Closing all positions...');
      await closeAllPositions('manual');
      await sendWithKeyboard('✅ <b>All positions closed</b>', mainMenuKeyboard());

    } else if (data.startsWith('close_')) {
      const posId = data.replace('close_', '');
      const open = getOpenPositions();
      const pos = open.find(p => p.id === posId);
      if (!pos) {
        await editMessage(chatId, messageId, '⚠️ Position not found — may have already closed.');
        return;
      }
      // Import and use executeClose via closeAllPositions filtered to one position
      const { getCurrentPrice } = await import('./scanner');
      const price = await getCurrentPrice(pos.tokenMint);
      if (price) {
        const { closePosition, setCooldown } = await import('./state');
        const { TOKEN_COOLDOWN_MS } = await import('./config');
        closePosition(pos.id, 'manual', price);
        setCooldown(pos.tokenMint, TOKEN_COOLDOWN_MS);
        const pnlUsd = (price - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent;
        const pnlPct = (price - pos.entryPriceUsd) / pos.entryPriceUsd * 100;
        const sign = pnlUsd >= 0 ? '+' : '';
        await editMessage(chatId, messageId,
          `✅ <b>${pos.tokenSymbol} closed</b>\n💰 P&L: ${sign}$${pnlUsd.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)`);
        logger.info(`[Menu] Manual close: ${pos.tokenSymbol} at $${price}`);
      } else {
        await editMessage(chatId, messageId, '❌ Could not fetch current price. Try again.');
      }

    } else if (data.startsWith('open_auto_')) {
      const mint = data.replace('open_auto_', '');
      if (_pendingTrade && _pendingTrade.mint === mint) {
        const { openPosition } = await import('./positions');
        const candidate = {
          mint: _pendingTrade.mint,
          symbol: _pendingTrade.symbol,
          name: _pendingTrade.symbol,
          priceUsd: _pendingTrade.priceUsd,
          liquidityUsd: 0,
          volume24hUsd: 0,
          isNewToken: _pendingTrade.isNewToken,
          score: 0,
          source: 'manual',
        };
        const opened = await openPosition(candidate as any);
        await editMessage(chatId, messageId,
          opened ? `✅ <b>Position opened: ${_pendingTrade.symbol}</b>` : '❌ Failed to open position — may be at max capacity or already tracking.');
        _pendingTrade = null;
      }

    } else if (data.startsWith('open_custom_')) {
      const mint = data.replace('open_custom_', '');
      await editMessage(chatId, messageId,
        `✏️ <b>Custom Trade</b>\n\nSend a command like:\n<code>/trade ${mint} tp=25 sl=8</code>\n\n• <b>tp=none</b> — no take profit\n• <b>sl=none</b> — no stop loss\n• <b>force</b> — bypass position limits\n• <b>reentry</b> — bypass cooldown\n• <b>limit=PRICE</b> — limit buy at target price`);

    } else if (data.startsWith('setlimit_')) {
      const posId = data.replace('setlimit_', '');
      const open = getOpenPositions();
      const pos = open.find(p => p.id === posId);
      if (!pos) {
        await editMessage(chatId, messageId, '⚠️ Position not found.');
        return;
      }
      await editMessage(chatId, messageId,
        `📌 <b>Set Limit Sell: ${pos.tokenSymbol}</b>\n\nSend the command:\n<code>/sell ${pos.tokenMint} at=PRICE</code>\n\nReplace PRICE with your target sell price in USD.\n<i>Current price: $${(pos.currentPriceUsd ?? pos.entryPriceUsd).toFixed(8)}</i>`);

    } else if (data.startsWith('cancellimit_')) {
      const mint = data.replace('cancellimit_', '');
      removeLimitBuyOrder(mint);
      await editMessage(chatId, messageId, '❌ Limit buy order cancelled.');
    }
    return;
  }

  // Handle text messages
  const msg = update.message;
  if (!msg || !msg.text) return;

  // Only respond to messages from the configured chat
  if (msg.chat?.id?.toString() !== TELEGRAM_CHAT_ID) return;

  const text = msg.text.trim();

  if (text === '/start' || text === '/menu') {
    await sendWithKeyboard('🤖 <b>Bot Control Panel</b>\nWhat would you like to do?', mainMenuKeyboard());

  } else if (text === '/status') {
    await sendMessage(buildStatusText());

  } else if (text === '/positions') {
    const { text: t, keyboard } = buildPositionsText();
    await sendWithKeyboard(t, keyboard);

  } else if (text === '/history') {
    await sendMessage(buildHistoryText());

  } else if (text === '/config') {
    await sendMessage(buildConfigText());

  } else if (text === '/pause') {
    _paused = true;
    await sendMessage('⏸ Scanning paused. Bot will monitor open positions but not open new ones. Send /resume to restart.');

  } else if (text === '/resume') {
    _paused = false;
    await sendMessage('▶️ Scanning resumed.');

  } else if (text === '/closeall') {
    await sendWithKeyboard('⚠️ <b>Close All Positions?</b>', {
      inline_keyboard: [[
        { text: '✅ Yes', callback_data: 'closeall_execute' },
        { text: '❌ Cancel', callback_data: 'menu' }
      ]]
    });

  } else if (text.startsWith('/trade ')) {
    // /trade <CA> [tp=X|tp=none] [sl=Y|sl=none] [force] [reentry] [limit=PRICE]
    const parts = text.split(/\s+/);
    const mint = parts[1];

    if (!mint || mint.length < 32) {
      await sendMessage(
        '❌ Invalid format. Use:\n' +
        '<code>/trade &lt;CA&gt; [tp=25] [sl=8] [force] [reentry] [limit=0.00123]</code>\n\n' +
        '• <b>tp=none</b> — no take profit (manual exit)\n' +
        '• <b>sl=none</b> — no stop loss (manual exit)\n' +
        '• <b>force</b> — bypass position count limits\n' +
        '• <b>reentry</b> — bypass cooldown\n' +
        '• <b>limit=PRICE</b> — wait for price to reach this level before buying'
      );
      return;
    }

    const tpRaw   = text.match(/tp=(\S+)/)?.[1];
    const slRaw   = text.match(/sl=(\S+)/)?.[1];
    const limitRaw = text.match(/limit=([\d.]+)/)?.[1];
    const forceEntry   = /\bforce\b/i.test(text);
    const skipCooldown = /\breentry\b/i.test(text);

    const noTp = tpRaw === 'none' || tpRaw === '0';
    const noSl = slRaw === 'none' || slRaw === '0';
    const tpPct = (!noTp && tpRaw) ? parseFloat(tpRaw) / 100 : null;
    const slPct = (!noSl && slRaw) ? parseFloat(slRaw) / 100 : null;
    const limitPrice = limitRaw ? parseFloat(limitRaw) : null;

    await sendMessage('🔍 Fetching token data...');
    try {
      const resp = await axios.get(`${DEXSCREENER_API}/tokens/${mint}`, { timeout: 12_000 });
      const pairs = (resp.data?.pairs || []).filter((p: any) => p.chainId === 'solana');
      if (!pairs.length) { await sendMessage('❌ Token not found on Solana.'); return; }
      pairs.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      const pair = pairs[0];
      const symbol = pair.baseToken?.symbol || 'UNKNOWN';
      const priceUsd = parseFloat(pair.priceUsd || '0');
      const ageHours = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3_600_000 : 9999;
      const isNewToken = ageHours < 24;

      const finalTpPct = tpPct ?? (isNewToken ? NEW_TOKEN_TAKE_PROFIT_PCT : TAKE_PROFIT_PCT);
      const finalSlPct = slPct ?? (isNewToken ? NEW_TOKEN_STOP_LOSS_PCT : STOP_LOSS_PCT);

      // ─── Limit buy: queue order, don't open immediately ───────────────────
      if (limitPrice !== null) {
        if (limitPrice >= priceUsd) {
          await sendMessage(`⚠️ Limit price $${limitPrice} is >= current price $${priceUsd.toFixed(8)}. Use a price <b>below</b> current for a limit buy.`);
          return;
        }
        _limitBuyOrders.push({
          mint, symbol, limitPrice, isNewToken,
          noTp, noSl,
          tpPct: noTp ? undefined : finalTpPct,
          slPct: noSl ? undefined : finalSlPct,
          forceEntry, createdAt: Date.now(),
        });
        const tpLabel = noTp ? 'none' : `+${(finalTpPct * 100).toFixed(0)}%`;
        const slLabel = noSl ? 'none' : `-${(finalSlPct * 100).toFixed(0)}%`;
        await sendMessage(
          `⏳ <b>Limit buy queued: ${symbol}</b>\n` +
          `📌 Will buy when price ≤ $${limitPrice}\n` +
          `💵 Current: $${priceUsd.toFixed(8)}\n` +
          `🎯 TP: ${tpLabel} | 🛑 SL: ${slLabel}\n` +
          `<i>Send /positions to view or cancel pending orders.</i>`
        );
        return;
      }

      // ─── Immediate open ───────────────────────────────────────────────────
      const { openPosition } = await import('./positions');
      const candidate = {
        mint, symbol, name: symbol, priceUsd,
        liquidityUsd: pair.liquidity?.usd || 0,
        volume24hUsd: pair.volume?.h24 || 0,
        isNewToken, ageHours,
        score: 99, source: 'manual',
        _overrideTpPct: noTp ? undefined : finalTpPct,
        _overrideSlPct: noSl ? undefined : finalSlPct,
        _noTp: noTp,
        _noSl: noSl,
        _forceEntry: forceEntry,
        _skipCooldown: skipCooldown,
        _isManual: true,
      };
      const opened = await openPosition(candidate as any);
      const tpLabel = noTp ? 'none (manual)' : `+${(finalTpPct * 100).toFixed(0)}%`;
      const slLabel = noSl ? 'none (manual)' : `-${(finalSlPct * 100).toFixed(0)}%`;
      const flags = [forceEntry && '⚡ force', skipCooldown && '🔄 reentry'].filter(Boolean).join(' ');
      await sendMessage(opened
        ? `✅ <b>Manual trade opened: ${symbol}</b>\n💵 Entry: $${priceUsd.toFixed(8)}\n🎯 TP: ${tpLabel} | 🛑 SL: ${slLabel}${flags ? '\n' + flags : ''}`
        : '❌ Failed to open — may be at max capacity, already tracking, or on cooldown. Add <code>force</code> / <code>reentry</code> to override.');
    } catch (err: any) {
      await sendMessage('❌ Error fetching token data: ' + err?.message);
    }

  } else if (text.startsWith('/sell ')) {
    // /sell <mint> at=PRICE  —  set limit sell on open position
    const parts = text.split(/\s+/);
    const mintOrSymbol = parts[1];
    const atMatch = text.match(/at=([\d.]+)/);

    if (!mintOrSymbol || !atMatch) {
      await sendMessage('❌ Format: <code>/sell &lt;mint&gt; at=PRICE</code>\nExample: /sell &lt;CA&gt; at=0.00001234');
      return;
    }

    const targetPrice = parseFloat(atMatch[1]);
    const open = getOpenPositions();
    const pos = open.find(p =>
      p.tokenMint === mintOrSymbol ||
      p.tokenSymbol.toLowerCase() === mintOrSymbol.toLowerCase()
    );

    if (!pos) {
      await sendMessage(`❌ No open position found for <b>${mintOrSymbol}</b>. Check /positions for exact mint addresses.`);
      return;
    }

    const { updatePosition } = await import('./state');
    updatePosition(pos.id, { limitSellPrice: targetPrice });
    const cur = pos.currentPriceUsd ?? pos.entryPriceUsd;
    const distPct = (targetPrice - cur) / cur * 100;
    const sign = distPct >= 0 ? '+' : '';
    await sendMessage(
      `📌 <b>Limit sell set: ${pos.tokenSymbol}</b>\n` +
      `🎯 Will close at $${targetPrice} (${sign}${distPct.toFixed(1)}% from current $${cur.toFixed(8)})\n` +
      `<i>Bot will auto-close when price reaches this level.</i>`
    );

  } else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) {
    // Looks like a Solana address — auto-analyse
    await analyseToken(text);
  }
}

// ─── Long-poll loop ───────────────────────────────────────────────────────────
export async function startMenuListener(): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    logger.info('[Menu] Telegram not configured — menu disabled');
    return;
  }

  logger.info('[Menu] Starting Telegram menu listener');

  // Set bot commands
  try {
    await axios.post(`${BASE}/setMyCommands`, {
      commands: [
        { command: 'menu', description: 'Show control panel' },
        { command: 'status', description: 'Portfolio status' },
        { command: 'positions', description: 'Open positions' },
        { command: 'history', description: 'Last 10 trades' },
        { command: 'pause', description: 'Pause new entries' },
        { command: 'resume', description: 'Resume scanning' },
        { command: 'closeall', description: 'Close all positions' },
        { command: 'config', description: 'Current settings' },
      ]
    });
  } catch (_) {}

  while (true) {
    try {
      const resp = await axios.get(`${BASE}/getUpdates`, {
        params: { offset: _offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
        timeout: 35_000,
      });

      const updates = resp.data?.result || [];
      for (const update of updates) {
        _offset = update.update_id + 1;
        await processUpdate(update).catch(err =>
          logger.warn('[Menu] Error processing update', { error: err?.message })
        );
      }
    } catch (err: any) {
      if (!err?.message?.includes('timeout')) {
        logger.warn('[Menu] Poll error', { error: err?.message });
      }
      await new Promise(r => setTimeout(r, 3_000));
    }
  }
}
