/**
 * Manual close-all script.
 * Fetches current prices from DexScreener and closes all open positions in state.json.
 * Run with: node scripts/close-all.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const STATE_FILE = path.join(__dirname, '..', 'state.json');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'solana-bot/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getPrice(mint) {
  try {
    const data = await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const pairs = (data.pairs || []).filter(p => p.chainId === 'solana');
    if (!pairs.length) return null;
    pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const price = parseFloat(pairs[0].priceUsd || '0');
    return price > 0 ? price : null;
  } catch (e) {
    return null;
  }
}

async function main() {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  const open = state.positions.filter(p => p.status === 'open');

  if (open.length === 0) {
    console.log('No open positions to close.');
    return;
  }

  console.log(`Closing ${open.length} positions...\n`);

  for (const pos of open) {
    const price = await getPrice(pos.tokenMint);
    if (!price) {
      console.log(`⚠️  Could not get price for ${pos.tokenSymbol} — skipping`);
      continue;
    }

    const pnlUsd = (price - pos.entryPriceUsd) / pos.entryPriceUsd * pos.usdSpent;
    const pnlPct = (price - pos.entryPriceUsd) / pos.entryPriceUsd * 100;

    const idx = state.positions.findIndex(p => p.id === pos.id);
    state.positions[idx] = {
      ...pos,
      status: 'closed',
      closedAt: Date.now(),
      closeReason: 'manual',
      currentPriceUsd: price,
      pnlUsd,
      pnlPct,
    };

    state.realizedPnlUsd += pnlUsd;
    state.totalCapitalUsd += pnlUsd;
    state.lastUpdated = new Date().toISOString();

    const sign = pnlUsd >= 0 ? '+' : '';
    console.log(`✅ ${pos.tokenSymbol}: entry $${pos.entryPriceUsd} → exit $${price.toFixed(6)} | P&L: ${sign}$${pnlUsd.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%)`);
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  console.log(`\n💰 Total realized P&L: $${state.realizedPnlUsd.toFixed(2)}`);
  console.log(`📊 Capital: $${state.totalCapitalUsd.toFixed(2)}`);
  console.log('\nState saved. Restart the bot to pick up changes.');
}

main().catch(console.error);
