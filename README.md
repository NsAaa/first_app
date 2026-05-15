# Solana Momentum Trading Bot

A production-grade momentum trading bot for Solana tokens. Scans DexScreener and Birdeye for high-momentum tokens, enters positions via Jupiter aggregator, and manages exits via stop loss / take profit.

## ⚠️ Risk Warning

This bot trades real money. Always start in `DRY_RUN=true` mode, verify the behaviour, and only set `DRY_RUN=false` when you're confident. The author provides no warranty.

---

## Strategy

**Buy signal (all must pass):**
- Liquidity > $1M
- Token age > 24 hours
- Strong buy volume in last 4-6 hours
- Price above recent high (resistance break)
- Positive price momentum

**Risk management:**
- Max position: $20 (10% of $200 capital)
- Max simultaneous positions: 3
- Stop loss: -15% per trade
- Take profit: +30% per trade
- Portfolio stop: -$100 total loss (50% drawdown)

---

## Setup

### 1. Install dependencies

```bash
cd /home/conrad/.openclaw/workspace/solana-bot
npm install
```

### 2. Configure `.env`

The `.env` file is pre-filled with your wallet keys. Add your Telegram bot token and chat ID:

```bash
# Get your bot token from @BotFather on Telegram
TELEGRAM_BOT_TOKEN=123456:ABC-DEF...

# Get your chat ID from @userinfobot on Telegram
TELEGRAM_CHAT_ID=123456789
```

**Optional:** Use a faster private RPC (recommended for live trading):
```bash
SOLANA_RPC_URL=https://your-helius-or-quicknode-endpoint
```

### 3. Build

```bash
npm run build
```

### 4. Test in dry-run mode

```bash
npm start
```

The bot defaults to `DRY_RUN=true` — it will scan and simulate trades but execute nothing real.

Watch logs:
```bash
tail -f logs/bot.log
tail -f logs/heartbeat.log
```

### 5. Go live

Once you're satisfied with dry-run behaviour:

```bash
# Edit .env:
DRY_RUN=false

# Build and start
npm run build
npm start
```

---

## PM2 (recommended for production)

```bash
# Install PM2 globally (if not already)
npm install -g pm2

# Build first
npm run build

# Start with PM2
pm2 start ecosystem.config.js

# View logs
pm2 logs solana-bot

# Monitor
pm2 monit

# Auto-start on reboot
pm2 startup
pm2 save

# Stop
pm2 stop solana-bot

# Restart after config change
pm2 restart solana-bot
```

---

## Systemd (alternative)

```bash
# Copy service file
sudo cp solana-bot.service /etc/systemd/system/

# Enable and start
sudo systemctl daemon-reload
sudo systemctl enable solana-bot
sudo systemctl start solana-bot

# Check status
sudo systemctl status solana-bot

# View logs
sudo journalctl -u solana-bot -f
```

---

## State Management

The bot persists state to `state.json`. On restart, it picks up where it left off:
- Open positions are reloaded
- P&L history is preserved
- Portfolio stop flag survives restarts

**To reset state completely:**
```bash
rm state.json
```

**To reset portfolio stop (after manual review):**
Edit `state.json` and set `"portfolioStopTriggered": false`.

---

## File Structure

```
solana-bot/
├── src/
│   ├── bot.ts          # Main daemon loop
│   ├── scanner.ts      # Market scanning (DexScreener + Birdeye)
│   ├── trader.ts       # Jupiter swap execution
│   ├── positions.ts    # Position tracking, SL/TP logic
│   ├── telegram.ts     # Telegram alert helpers
│   ├── state.ts        # State persistence
│   ├── config.ts       # All constants/config
│   └── logger.ts       # Winston logger
├── dist/               # Compiled JS (after npm run build)
├── logs/
│   ├── bot.log         # Main log
│   ├── error.log       # Errors only
│   └── heartbeat.log   # 5-minute heartbeats
├── state.json          # Persisted bot state (gitignored)
├── .env                # Secrets (gitignored)
├── .env.example        # Template
├── ecosystem.config.js # PM2 config
├── solana-bot.service  # systemd unit
└── tsconfig.json
```

---

## NPM Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript → dist/ |
| `npm start` | Build + run |
| `npm run dev` | Run with ts-node (no build needed) |
| `npm run watch` | Watch mode compilation |
| `npm run clean` | Remove dist/ |

---

## Data Sources

- **DexScreener**: Token pairs, liquidity, volume, price changes
- **Birdeye**: Top tokens by volume with liquidity filter
- **Jupiter Price API**: Real-time token prices
- **Jupiter Quote/Swap API**: Best-price swap execution

---

## Telegram Alerts

The bot sends alerts for:
- 📈 Position opened
- ✅ Take profit hit (+P&L)
- 🛑 Stop loss hit (-P&L)
- ❌ Position closed
- 🚨 Portfolio stop triggered
- ⚠️ Errors
- 💓 Heartbeat (every 5 min, if Telegram configured)

If `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are not set, all alerts are logged locally only.

---

## Troubleshooting

**Bot won't start:**
- Check `npm run build` compiles cleanly
- Ensure `.env` exists with `WALLET_PRIVATE_KEY_BASE64` set
- Check `logs/error.log` for details

**No trades being made:**
- Normal in slow markets — scanner applies strict filters
- Check logs for "No candidates found" vs actual errors
- Try lowering `MIN_LIQUIDITY_USD` in `config.ts` if you want more aggressive scanning

**RPC errors / rate limits:**
- Public Solana RPC is heavily rate-limited
- Get a free private RPC: https://app.helius.dev or https://app.quicknode.com
- Set `SOLANA_RPC_URL` in `.env`

**Portfolio stop active:**
- Review `state.json` for what triggered it
- Fix root cause, then set `portfolioStopTriggered: false` in `state.json`
- Restart bot
