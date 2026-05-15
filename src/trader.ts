import axios from 'axios';
import {
  Connection,
  Keypair,
  VersionedTransaction,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  SOLANA_RPC_URL,
  WALLET_PRIVATE_KEY_BASE64,
  JUPITER_QUOTE_URL,
  JUPITER_SWAP_URL,
  DEXSCREENER_API,
  SLIPPAGE_BPS,
  MAX_SLIPPAGE_BPS,
  SOL_MINT,
  USDC_MINT,
  DRY_RUN,
  MAX_POSITION_SIZE_USD,
} from './config';
import logger from './logger';

let _connection: Connection | null = null;
let _keypair: Keypair | null = null;

function getConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  }
  return _connection;
}

function getKeypair(): Keypair {
  if (!_keypair) {
    if (!WALLET_PRIVATE_KEY_BASE64) {
      throw new Error('WALLET_PRIVATE_KEY_BASE64 not set in .env');
    }
    const secretKey = Buffer.from(WALLET_PRIVATE_KEY_BASE64, 'base64');
    _keypair = Keypair.fromSecretKey(secretKey);
  }
  return _keypair;
}

// ─── SOL Price ────────────────────────────────────────────────────────────────
let _solPriceCache: { price: number; fetchedAt: number } | null = null;

export async function getSolPrice(): Promise<number> {
  // Cache for 30 seconds
  if (_solPriceCache && Date.now() - _solPriceCache.fetchedAt < 30_000) {
    return _solPriceCache.price;
  }

  // Primary: derive price from Jupiter quote (1 SOL → USDC)
  try {
    const params = new URLSearchParams({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: (1 * LAMPORTS_PER_SOL).toString(), // 1 SOL in lamports
      slippageBps: '50',
    });
    const resp = await axios.get(`${JUPITER_QUOTE_URL}?${params}`, { timeout: 8_000 });
    const outAmount = parseInt(resp.data?.outAmount || '0');
    const price = outAmount / 1_000_000; // USDC has 6 decimals
    if (price > 0) {
      _solPriceCache = { price, fetchedAt: Date.now() };
      return price;
    }
  } catch (_) {}

  // Fallback: DexScreener SOL/USDC pair
  try {
    const resp = await axios.get(
      `${DEXSCREENER_API}/tokens/${SOL_MINT}`,
      { timeout: 8_000 }
    );
    const pairs: any[] = resp.data?.pairs || [];
    const solana = pairs.filter((p: any) => p.chainId === 'solana');
    solana.sort((a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
    const price = parseFloat(solana[0]?.priceUsd || '0');
    if (price > 0) {
      _solPriceCache = { price, fetchedAt: Date.now() };
      return price;
    }
  } catch (_) {}

  // Last resort: use cached value if available
  if (_solPriceCache) return _solPriceCache.price;
  throw new Error('Unable to fetch SOL price');
}

// ─── Wallet Balance ───────────────────────────────────────────────────────────
export async function getWalletBalances(): Promise<{ solBalance: number; solBalanceUsd: number }> {
  const conn = getConnection();
  const keypair = getKeypair();

  const lamports = await conn.getBalance(keypair.publicKey);
  const solBalance = lamports / LAMPORTS_PER_SOL;
  const solPrice = await getSolPrice();
  const solBalanceUsd = solBalance * solPrice;

  return { solBalance, solBalanceUsd };
}

// ─── Jupiter Quote ────────────────────────────────────────────────────────────
interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
}

async function getJupiterQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  slippageBps: number = SLIPPAGE_BPS
): Promise<JupiterQuote> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountLamports.toString(),
    slippageBps: slippageBps.toString(),
    onlyDirectRoutes: 'false',
  });

  const resp = await axios.get(`${JUPITER_QUOTE_URL}?${params}`, { timeout: 15_000 });

  if (!resp.data || resp.data.error) {
    throw new Error(`Jupiter quote error: ${resp.data?.error || 'unknown'}`);
  }

  return resp.data;
}

// ─── Jupiter Swap ─────────────────────────────────────────────────────────────
async function executeJupiterSwap(quote: JupiterQuote): Promise<string> {
  const keypair = getKeypair();
  const conn = getConnection();

  const swapResp = await axios.post(
    JUPITER_SWAP_URL,
    {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toString(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: 'auto',
    },
    { timeout: 30_000 }
  );

  if (!swapResp.data?.swapTransaction) {
    throw new Error('No swap transaction in Jupiter response');
  }

  // Deserialize and sign
  const txBuf = Buffer.from(swapResp.data.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([keypair]);

  // Send with retry
  let lastErr: any;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 3,
      });

      // Confirm
      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
      await conn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        'confirmed'
      );

      logger.info(`Swap confirmed: ${sig}`);
      return sig;
    } catch (err: any) {
      lastErr = err;
      logger.warn(`Swap attempt ${attempt + 1} failed: ${err?.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 2000));
    }
  }

  throw lastErr;
}

// ─── Buy Token ────────────────────────────────────────────────────────────────
export interface BuyResult {
  success: boolean;
  txSignature?: string;
  amountToken?: number;
  solSpent?: number;
  usdSpent?: number;
  priceUsd?: number;
  error?: string;
  dryRun: boolean;
}

export async function buyToken(
  tokenMint: string,
  usdAmount: number
): Promise<BuyResult> {
  const effectiveUsd = Math.min(usdAmount, MAX_POSITION_SIZE_USD);

  logger.info(`${DRY_RUN ? '[DRY RUN] ' : ''}Buying token`, {
    mint: tokenMint,
    usdAmount: effectiveUsd,
  });

  try {
    const solPrice = await getSolPrice();
    const solAmount = effectiveUsd / solPrice;
    const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);

    if (DRY_RUN) {
      // Simulate: get quote but don't execute
      const quote = await getJupiterQuote(SOL_MINT, tokenMint, lamports);
      const outAmount = parseInt(quote.outAmount);
      const priceUsd = effectiveUsd / outAmount;

      logger.info(`[DRY RUN] Would buy ${outAmount} tokens for $${effectiveUsd.toFixed(2)}`, {
        tokenMint,
        priceImpact: quote.priceImpactPct,
      });

      return {
        success: true,
        txSignature: `DRY_RUN_${Date.now()}`,
        amountToken: outAmount,
        solSpent: solAmount,
        usdSpent: effectiveUsd,
        priceUsd,
        dryRun: true,
      };
    }

    // Real execution
    const quote = await getJupiterQuote(SOL_MINT, tokenMint, lamports);

    const priceImpact = parseFloat(quote.priceImpactPct);
    if (priceImpact > 2) {
      throw new Error(`Price impact too high: ${priceImpact.toFixed(2)}% (max 2%)`);
    }

    const txSig = await executeJupiterSwap(quote);
    const outAmount = parseInt(quote.outAmount);
    const priceUsd = effectiveUsd / outAmount;

    return {
      success: true,
      txSignature: txSig,
      amountToken: outAmount,
      solSpent: solAmount,
      usdSpent: effectiveUsd,
      priceUsd,
      dryRun: false,
    };
  } catch (err: any) {
    logger.error('Buy failed', { tokenMint, error: err?.message });
    return { success: false, error: err?.message, dryRun: DRY_RUN };
  }
}

// ─── Sell Token ───────────────────────────────────────────────────────────────
export interface SellResult {
  success: boolean;
  txSignature?: string;
  solReceived?: number;
  usdReceived?: number;
  error?: string;
  dryRun: boolean;
}

export async function sellToken(
  tokenMint: string,
  tokenAmount: number,
  currentPriceUsd: number
): Promise<SellResult> {
  logger.info(`${DRY_RUN ? '[DRY RUN] ' : ''}Selling token`, {
    mint: tokenMint,
    tokenAmount,
    estimatedUsd: (currentPriceUsd * tokenAmount).toFixed(4),
  });

  try {
    const solPrice = await getSolPrice();

    if (DRY_RUN) {
      const estimatedUsd = currentPriceUsd * tokenAmount;
      const estimatedSol = estimatedUsd / solPrice;
      logger.info(`[DRY RUN] Would sell ${tokenAmount} tokens for ~$${estimatedUsd.toFixed(4)}`);
      return {
        success: true,
        txSignature: `DRY_RUN_SELL_${Date.now()}`,
        solReceived: estimatedSol,
        usdReceived: estimatedUsd,
        dryRun: true,
      };
    }

    // Get quote for selling tokenAmount → SOL
    const quote = await getJupiterQuote(
      tokenMint,
      SOL_MINT,
      tokenAmount,
      MAX_SLIPPAGE_BPS
    );

    const txSig = await executeJupiterSwap(quote);
    const solReceived = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
    const usdReceived = solReceived * solPrice;

    return {
      success: true,
      txSignature: txSig,
      solReceived,
      usdReceived,
      dryRun: false,
    };
  } catch (err: any) {
    logger.error('Sell failed', { tokenMint, error: err?.message });
    return { success: false, error: err?.message, dryRun: DRY_RUN };
  }
}
