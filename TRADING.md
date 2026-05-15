# TRADING.md — Trading Journal & Market Research

> Living document. Updated after every trade, discovery, or lesson. This is how I get better.

---

## 📋 Table of Contents
1. [Strategy Overview](#strategy-overview)
2. [Market Research & Trends](#market-research--trends)
3. [Key Signals & Indicators](#key-signals--indicators)
4. [Trade Log](#trade-log)
5. [Lessons Learned](#lessons-learned)
6. [Risk Management Notes](#risk-management-notes)
7. [Watchlist & Notes on Specific Tokens](#watchlist--notes)

---

## Strategy Overview

**Type:** Momentum trading on established Solana tokens  
**Exchange:** Jupiter API v6 (DEX aggregator)  
**Capital:** $200 USDC starting  
**Mode:** DRY_RUN until explicitly switched off  

### Entry Criteria
- Liquidity > $1M (filters out rug-pulls and thin books)
- Token age > 24 hours (avoids launch volatility / honey pots)
- Strong buy volume in last 4 hours (confirming momentum, not fading)
- Price breaking above recent 4h resistance (breakout, not chasing)
- Positive social sentiment (community behind the move)

### Exit Criteria
- **Take profit:** +30%
- **Stop loss:** -15%
- **Portfolio stop:** -50% total drawdown ($100 loss = full halt)

### Position Sizing
- Max per trade: $20 (10%)
- Max simultaneous: 3 positions
- Never average down (a losing position doesn't become a better one)

---

## Market Research & Trends

*Last updated: 2026-03-26*

### Why Solana for Momentum Trading
- **400ms settlement** — Ethereum DEX takes 12-15 seconds; Solana confirms in under half a second. For momentum trades that last 30-90 seconds, this is the difference between catching the acceleration phase vs the confirmation phase. Practically, this means entries are higher quality on Solana even with the same strategy.
- **Pyth Network price feeds** update every 400ms vs 1-2 seconds on traditional oracles — giving earlier momentum detection.
- **No CEX friction** — no KYC delays, custody confirmation steps (which add 7-10 seconds on centralised exchanges).

### Current Solana DEX Landscape (March 2026)
- **Jupiter** remains the dominant aggregator — routes through Raydium, Orca, Meteora, and others for best price
- **Raydium** largest single DEX by volume on Solana
- **Pump.fun** tokens — very high risk, avoid (< 24h, low liquidity, memecoin volatility)
- **DexScreener** — best free tool for scanning momentum candidates; watch "Trending" tab for Solana

### Macro Trends to Watch
- Solana ecosystem activity tracks SOL price broadly — when SOL is bullish, altcoin momentum trades work better
- Volume spikes on major Solana tokens often precede broader ecosystem pumps
- Watch BTC/ETH for macro sentiment — trading against macro trend adds significant risk
- Funding rates on perp exchanges can signal overextended moves — useful for timing exits

### Data Sources
| Source | What It's Good For |
|--------|-------------------|
| DexScreener API | Token stats, liquidity, volume, age, price action |
| Birdeye | Token rankings by volume, holder data |
| Jupiter Price API | Real-time prices for swap sizing |
| DefiLlama | DEX volume rankings, ecosystem health |

---

## Key Signals & Indicators

### Volume-Based
- **4h buy volume surge** — look for 2-3x average 4h volume with buy-side dominance (>60% buys)
- **Volume + price divergence** — volume rising but price flat = accumulation, potential breakout incoming
- **Declining volume on pullback** — healthy consolidation before continuation

### Price Action
- **Resistance break** — price closing above a level that held for multiple candles
- **Higher lows** — trend structure confirming upward momentum
- **No sell walls on order book** — if Jupiter routes without large price impact, path of least resistance is up

### Red Flags (avoid)
- Volume spike with price flat = absorption / distribution (someone selling into demand)
- Token age < 24h regardless of volume
- Liquidity < $1M (1 big seller can crash it)
- Sudden liquidity removal = rug pull warning
- Dev wallet holding > 20% of supply
- Social sentiment suddenly turning negative mid-position = early exit signal

---

## Trade Log

*Format: date | token | entry price | exit price | P&L | reason for exit | notes*

| Date | Token | Symbol | Entry | Exit | P&L | Exit Reason | Notes |
|------|-------|--------|-------|------|-----|-------------|-------|
| — | — | — | — | — | — | No trades yet | DRY_RUN mode active |

---

## Lessons Learned

*Populated as we trade. Each lesson gets a date and context.*

### Pre-Launch (2026-03-26)
- **Infrastructure matters as much as strategy** — Solana's 400ms settlement vs Ethereum's 12-15s is not a minor detail. It's the difference between catching a move and chasing its aftermath. Always trade on the fastest viable infrastructure for your strategy type.
- **DRY_RUN first, always** — Never deploy real capital until you have at least 2-4 weeks of simulated P&L data. Backfill doesn't catch live execution issues (slippage, API delays, state bugs).
- **Filters prevent bad trades more than entries capture good ones** — The liquidity > $1M and age > 24h filters will reject a lot of tokens that look interesting. That's the point. One rug pull can erase 10 winners.
- **Portfolio stop is non-negotiable** — -50% portfolio stop ($100) is the hard ceiling. If it triggers, the bot halts and Conrad reviews before resuming. No override logic should ever bypass this.

---

## Risk Management Notes

### Position Sizing Rationale
- 10% max position ($20) means a full stop loss (-15% on position = -$3) is only 1.5% of portfolio. Need 33 consecutive stop losses to blow up — extremely unlikely.
- 3 simultaneous positions max = 30% of capital deployed at any time. 70% always in reserve.
- This is conservative sizing appropriate for a learning phase.

### Slippage
- Set at 1% default, 2% max.
- On tokens with $1M+ liquidity and a $20 position, slippage should be <0.1%. 1% is a safety buffer.
- If Jupiter quotes show >1% price impact, skip the trade — liquidity is thinner than it looks.

### Gas / Network Fees
- Solana transaction fees are ~$0.00025 per tx. Effectively zero.
- Priority fees during congestion can spike to $0.01-0.05. Still negligible on $20 positions.
- Factor: fees are not a meaningful cost at this position size.

### Drawdown Tracking
- Track running P&L against $200 baseline
- At $150 remaining (-25%): increase scrutiny, review recent trades
- At $100 remaining (-50%): full stop, review with Conrad before resuming

---

## Watchlist & Notes

*Tokens or projects being tracked but not currently traded.*

| Token | Symbol | Reason for Watching | Date Added | Notes |
|-------|--------|---------------------|------------|-------|
| — | — | — | — | Added as we discover candidates |

---

*This file is maintained by Neo. Last updated: 2026-03-26*
