import fs from 'fs';
import path from 'path';
import { STATE_FILE } from './config';
import logger from './logger';

export interface Position {
  id: string;
  tokenMint: string;
  tokenSymbol: string;
  tokenName: string;
  entryPrice: number;           // price in SOL at entry
  entryPriceUsd: number;        // price in USD at entry
  entryTime: number;            // unix ms
  amountToken: number;          // token amount held
  solSpent: number;             // SOL spent to buy
  usdSpent: number;             // USD equivalent spent
  stopLossPrice: number;        // absolute stop loss price (USD)
  takeProfitPrice: number;      // absolute take profit price (USD)
  currentPrice?: number;        // last known price
  currentPriceUsd?: number;
  peakPriceUsd?: number;        // highest price seen while in near-TP zone (for trailing stop)
  priceHistory?: number[];      // last N prices for dump detection (capped at 5)
  isNewToken?: boolean;         // whether this is a new token tier trade
  isSniper?: boolean;           // whether this is a sniper tier trade (trailing stop only, no fixed TP)
  isManual?: boolean;           // opened via /trade command
  noTp?: boolean;               // no take profit — manual exit only
  noSl?: boolean;               // no stop loss — manual exit only
  limitSellPrice?: number;      // auto-close when price reaches this level
  status: 'open' | 'closed';
  closedAt?: number;
  closeReason?: 'stop_loss' | 'take_profit' | 'manual' | 'portfolio_stop';
  pnlUsd?: number;
  pnlPct?: number;
}

export interface BotState {
  startedAt: number;
  totalCapitalUsd: number;
  realizedPnlUsd: number;
  positions: Position[];
  portfolioStopTriggered: boolean;
  lastScanAt?: number;
  cooldowns: Record<string, number>; // tokenMint → timestamp when cooldown expires
  version: number;
}

const DEFAULT_STATE: BotState = {
  startedAt: Date.now(),
  totalCapitalUsd: 200,
  realizedPnlUsd: 0,
  positions: [],
  portfolioStopTriggered: false,
  cooldowns: {},
  version: 1,
};

let _state: BotState = { ...DEFAULT_STATE };

export function loadState(): BotState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      _state = { ...DEFAULT_STATE, ...JSON.parse(raw) };
      // Clear stale price history on every restart — prevents cross-session false dump triggers
      _state.positions = _state.positions.map(p => ({ ...p, priceHistory: [] }));
      logger.info(`State loaded from ${STATE_FILE}`, {
        positions: _state.positions.filter(p => p.status === 'open').length,
        realizedPnl: _state.realizedPnlUsd,
      });
    } else {
      logger.info('No state file found, starting fresh');
      _state = { ...DEFAULT_STATE, startedAt: Date.now() };
      saveState();
    }
  } catch (err) {
    logger.error('Failed to load state, starting fresh', { err });
    _state = { ...DEFAULT_STATE, startedAt: Date.now() };
  }
  return _state;
}

export function saveState(): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2), 'utf-8');
  } catch (err) {
    logger.error('Failed to save state', { err });
  }
}

export function getState(): BotState {
  return _state;
}

export function getOpenPositions(): Position[] {
  return _state.positions.filter(p => p.status === 'open');
}

export function addPosition(pos: Position): void {
  _state.positions.push(pos);
  saveState();
}

export function updatePosition(id: string, updates: Partial<Position>): void {
  const idx = _state.positions.findIndex(p => p.id === id);
  if (idx >= 0) {
    _state.positions[idx] = { ..._state.positions[idx], ...updates };
    saveState();
  }
}

export function closePosition(id: string, reason: Position['closeReason'], priceUsd: number): Position | null {
  const idx = _state.positions.findIndex(p => p.id === id);
  if (idx < 0) return null;

  const pos = _state.positions[idx];
  const pnlUsd = (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent;
  const pnlPct = (priceUsd - pos.entryPriceUsd) / pos.entryPriceUsd * 100;

  _state.positions[idx] = {
    ...pos,
    status: 'closed',
    closedAt: Date.now(),
    closeReason: reason,
    currentPriceUsd: priceUsd,
    pnlUsd,
    pnlPct,
  };

  _state.realizedPnlUsd += pnlUsd;
  _state.totalCapitalUsd += pnlUsd;
  saveState();
  return _state.positions[idx];
}

export function setPortfolioStop(): void {
  _state.portfolioStopTriggered = true;
  saveState();
}

export function updateLastScan(): void {
  _state.lastScanAt = Date.now();
  saveState();
}

export function isAlreadyTracking(tokenMint: string): boolean {
  return _state.positions.some(p => p.tokenMint === tokenMint && p.status === 'open');
}

export function setCooldown(tokenMint: string, durationMs: number): void {
  if (!_state.cooldowns) _state.cooldowns = {};
  _state.cooldowns[tokenMint] = Date.now() + durationMs;
  saveState();
}

export function isOnCooldown(tokenMint: string): boolean {
  if (!_state.cooldowns) return false;
  const expiresAt = _state.cooldowns[tokenMint];
  if (!expiresAt) return false;
  return Date.now() < expiresAt;
}

export function getCooldownRemaining(tokenMint: string): number {
  if (!_state.cooldowns) return 0;
  const expiresAt = _state.cooldowns[tokenMint];
  if (!expiresAt) return 0;
  return Math.max(0, expiresAt - Date.now());
}
