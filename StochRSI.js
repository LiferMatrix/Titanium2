require('dotenv').config();
const ccxt = require('ccxt');
const TechnicalIndicators = require('technicalindicators');
const { Bot } = require('grammy');
const winston = require('winston');
const axios = require('axios');

// ================= CONFIGURAÇÃO ================= //
const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  PARES_MONITORADOS: (process.env.COINS || "BTCUSDT,ETHUSDT,BNBUSDT").split(","),
  INTERVALO_ALERTA_RSI_MS: 5 * 60 * 1000, // 5 minutos para RSI/EMA
  INTERVALO_ALERTA_STOCH_MS: 15 * 60 * 1000, // 15 minutos para Estocástico
  TEMPO_COOLDOWN_MS: 30 * 60 * 1000, // 30 minutos para Estocástico
  RSI_PERIOD: 14,
  ATR_PERIOD: 14,
  ADX_PERIOD: 10,
  EMA_FAST_PERIOD: 13,
  EMA_SLOW_PERIOD: 21,
  EMA_STOCH_34_PERIOD: 34, // EMA 34 para Estocástico (3m)
  EMA_STOCH_89_PERIOD: 89, // EMA 89 para Estocástico (3m)
  STOCHASTIC_PERIOD_K: 5,
  STOCHASTIC_SMOOTH_K: 3,
  STOCHASTIC_PERIOD_D: 3,
  RSI_OVERSOLD_THRESHOLD: 55,
  RSI_OVERBOUGHT_THRESHOLD: 65,
  STOCHASTIC_BUY_MAX: 70,
  STOCHASTIC_SELL_MIN: 80,
  LSR_BUY_MAX: 1.8,
  LSR_SELL_MIN: 2.9,
  DELTA_BUY_MIN: 10,
  DELTA_SELL_MAX: -10,
  VOLUME_SPIKE_THRESHOLD: 2,
  FUNDING_RATE_CHANGE_THRESHOLD: 0.005,
  VOLATILITY_MIN: 0.005,
  ADX_MIN: 25,
  CACHE_TTL: 5 * 60 * 1000, // 5 minutos
  MAX_CACHE_SIZE: 100,
  LIMIT_TRADES_DELTA: 100,
  MAX_COINS_PER_ALERT: 3,
  MAX_MESSAGE_LENGTH: 4000,
  MAX_HISTORICO_ALERTAS: 10
};

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'combined_trading_bot.log' }),
    new winston.transports.Console()
  ]
});

// Estado global
const state = {
  dataCache: new Map(),
  lastFundingRates: new Map(),
  rsiPeaks: new Map(),
  lastEmaValues: new Map(),
  ultimoAlertaPorAtivo: {},
  ultimoEstocastico: {}
};

// Validação de variáveis de ambiente
function validateEnv() {
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  for (const key of required) {
    if (!process.env[key]) {
      logger.error(`Missing environment variable: ${key}`);
      process.exit(1);
    }
  }
}
validateEnv();

// Inicialização do Telegram e Exchanges
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
const exchangeSpot = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: 'spot' }
});
const exchangeFutures = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: 'future' }
});

// ================= UTILITÁRIOS ================= //
async function withRetry(fn, retries = 5, delayBase = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === retries) {
        logger.warn(`Failed after ${retries} attempts: ${e.message}`);
        throw e;
      }
      const delay = Math.pow(2, attempt - 1) * delayBase;
      logger.info(`Attempt ${attempt} failed, retry after ${delay}ms: ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function getCachedData(key) {
  const cacheEntry = state.dataCache.get(key);
  if (cacheEntry && Date.now() - cacheEntry.timestamp < config.CACHE_TTL) {
    logger.info(`Using cache for ${key}`);
    return cacheEntry.data;
  }
  state.dataCache.delete(key);
  return null;
}

function setCachedData(key, data) {
  if (data === null || (data.value !== undefined && data.value === null)) {
    logger.info(`Not storing null value for ${key}`);
    return;
  }
  if (state.dataCache.size >= config.MAX_CACHE_SIZE) {
    const oldestKey = state.dataCache.keys().next().value;
    state.dataCache.delete(oldestKey);
    logger.info(`Cache full, removed oldest item: ${oldestKey}`);
  }
  state.dataCache.set(key, { timestamp: Date.now(), data });
}

function cleanSymbol(symbol) {
  return symbol.replace(/:USDT$/, '');
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of state.dataCache) {
    if (now - entry.timestamp > config.CACHE_TTL) {
      state.dataCache.delete(key);
      logger.info(`Cache cleared: ${key}`);
    }
  }
}, 60 * 60 * 1000);

async function limitConcurrency(items, fn, limit = 5) {
  const results = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const batchResults = await Promise.all(batch.map(item => fn(item)));
    results.push(...batchResults);
  }
  return results;
}

// ================= INDICADORES ================= //
function normalizeOHLCV(data, symbol) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    logger.warn(`Empty or invalid OHLCV data for ${symbol}`);
    return [];
  }
  const normalized = data.map(c => ({
    time: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  })).filter(c => !isNaN(c.close) && !isNaN(c.volume) && c.close > 0 && c.high >= c.low);
  if (normalized.length === 0) {
    logger.warn(`No valid OHLCV data after normalization for ${symbol}`);
  } else {
    logger.info(`Normalized OHLCV data for ${symbol}: ${normalized.length} candles`);
  }
  return normalized;
}

function calculateRSI(data, symbol) {
  if (!data || data.length < config.RSI_PERIOD + 1) {
    logger.warn(`Insufficient data for RSI calculation for ${symbol}: ${data?.length || 0} candles available`);
    return null;
  }
  const closes = data.map(d => d.close);
  if (closes.every(c => c === closes[0])) {
    logger.warn(`Constant prices detected for ${symbol}, RSI invalid`);
    return null;
  }
  const rsi = TechnicalIndicators.RSI.calculate({
    period: config.RSI_PERIOD,
    values: closes
  });
  const rsiValue = rsi.length ? parseFloat(rsi[rsi.length - 1].toFixed(2)) : null;
  logger.info(`RSI calculated for ${symbol}: ${rsiValue}, data: ${data.length} candles`);
  return rsiValue;
}

function calculateATR(data, symbol) {
  if (!data || data.length < config.ATR_PERIOD + 1) {
    logger.warn(`Insufficient data for ATR calculation for ${symbol}: ${data?.length || 0} candles available`);
    return null;
  }
  const atr = TechnicalIndicators.ATR.calculate({
    period: config.ATR_PERIOD,
    high: data.map(d => d.high),
    low: data.map(d => d.low),
    close: data.map(d => d.close)
  });
  return atr.length ? parseFloat(atr[atr.length - 1].toFixed(8)) : null;
}

function calculateADX(data, symbol) {
  if (!data || data.length < config.ADX_PERIOD + 14) {
    logger.warn(`Insufficient data for ADX calculation for ${symbol}: ${data?.length || 0} candles available, required: ${config.ADX_PERIOD + 14}`);
    return null;
  }
  const highs = data.map(d => d.high);
  const lows = data.map(d => d.low);
  const closes = data.map(d => d.close);
  if (highs.every(h => h === highs[0]) || lows.every(l => l === lows[0]) || closes.every(c => c === closes[0])) {
    logger.warn(`Constant prices detected for ${symbol}, ADX invalid`);
    return null;
  }
  try {
    const adx = TechnicalIndicators.ADX.calculate({
      period: config.ADX_PERIOD,
      high: highs,
      low: lows,
      close: closes
    });
    const adxValue = adx.length ? parseFloat(adx[adx.length - 1].adx.toFixed(2)) : null;
    if (adxValue === null || isNaN(adxValue)) {
      logger.warn(`Failed to calculate ADX for ${symbol}: invalid result`);
      return null;
    }
    logger.info(`ADX calculated for ${symbol}: ${adxValue}, data: ${data.length} candles`);
    return adxValue;
  } catch (e) {
    logger.warn(`Error calculating ADX for ${symbol}: ${e.message}`);
    return null;
  }
}

function calculateStochastic(data, symbol, period = config.STOCHASTIC_PERIOD_K, signalPeriod = config.STOCHASTIC_PERIOD_D, smoothing = config.STOCHASTIC_SMOOTH_K) {
  if (!data || data.length < period + signalPeriod + smoothing - 2) {
    logger.warn(`Insufficient data for Stochastic calculation for ${symbol}: ${data?.length || 0} candles available`);
    return { k: null, d: null, previousK: null };
  }
  const closes = data.map(d => d.close);
  if (closes.every(c => c === closes[0])) {
    logger.warn(`Constant prices detected for ${symbol}, Stochastic invalid`);
    return { k: null, d: null, previousK: null };
  }
  const stochastic = TechnicalIndicators.Stochastic.calculate({
    period,
    signalPeriod,
    high: data.map(d => d.high),
    low: data.map(d => d.low),
    close: closes
  });
  if (stochastic.length < 2) {
    logger.warn(`Insufficient Stochastic results for ${symbol}: ${stochastic.length} periods calculated`);
    return { k: null, d: null, previousK: null };
  }
  return {
    k: parseFloat(stochastic[stochastic.length - 1].k.toFixed(2)),
    d: parseFloat(stochastic[stochastic.length - 1].d.toFixed(2)),
    previousK: parseFloat(stochastic[stochastic.length - 2].k.toFixed(2))
  };
}

function calculateEMA(data, period, symbol) {
  if (!data || data.length < period + 1) {
    logger.warn(`Insufficient data for EMA(${period}) calculation for ${symbol}: ${data?.length || 0} candles available`);
    return null;
  }
  const closes = data.map(d => d.close);
  if (closes.every(c => c === closes[0])) {
    logger.warn(`Constant prices detected for ${symbol}, EMA(${period}) invalid`);
    return null;
  }
  const ema = TechnicalIndicators.EMA.calculate({
    period,
    values: closes
  });
  const emaValue = ema.length ? parseFloat(ema[ema.length - 1].toFixed(8)) : null;
  logger.info(`EMA(${period}) calculated for ${symbol}: ${emaValue}, data: ${data.length} candles`);
  return emaValue;
}

function detectEMACrossover(symbol, emaFast, emaSlow) {
  const cacheKey = `ema_${symbol}`;
  const previous = state.lastEmaValues.get(cacheKey) || { emaFast: null, emaSlow: null };
  if (emaFast === null || emaSlow === null || previous.emaFast === null || previous.emaSlow === null) {
    state.lastEmaValues.set(cacheKey, { emaFast, emaSlow });
    return { isBullishCrossover: false, isBearishCrossover: false };
  }
  const isBullishCrossover = previous.emaFast <= previous.emaSlow && emaFast > emaSlow;
  const isBearishCrossover = previous.emaFast >= previous.emaSlow && emaFast < emaSlow;
  state.lastEmaValues.set(cacheKey, { emaFast, emaSlow });
  logger.info(`EMA Crossover for ${symbol}: EMA${config.EMA_FAST_PERIOD}=${emaFast}, EMA${config.EMA_SLOW_PERIOD}=${emaSlow}, Bullish=${isBullishCrossover}, Bearish=${isBearishCrossover}`);
  return { isBullishCrossover, isBearishCrossover };
}

function calculateSupportResistance(data, symbol) {
  if (!data || data.length < 50) {
    logger.warn(`Insufficient data for Support/Resistance calculation for ${symbol}: ${data?.length || 0} candles available`);
    return { support: null, resistance: null };
  }
  const lows = data.map(d => d.low);
  const highs = data.map(d => d.high);
  const support = Math.min(...lows);
  const resistance = Math.max(...highs);
  return {
    support: parseFloat(support.toFixed(8)),
    resistance: parseFloat(resistance.toFixed(8))
  };
}

function detectarQuebraEstrutura(ohlcv, symbol) {
  if (!ohlcv || ohlcv.length < 2) {
    logger.warn(`Insufficient data for structure break detection for ${symbol}`);
    return { estruturaAlta: 0, estruturaBaixa: 0, buyLiquidityZones: [], sellLiquidityZones: [] };
  }
  const lookbackPeriod = 20;
  const previousCandles = ohlcv.slice(0, -1).slice(-lookbackPeriod);
  const highs = previousCandles.map(c => c.high).filter(h => !isNaN(h));
  const lows = previousCandles.map(c => c.low).filter(l => !isNaN(l));
  const volumes = previousCandles.map(c => c.volume).filter(v => !isNaN(v));
  if (highs.length === 0 || lows.length === 0 || volumes.length === 0) {
    logger.warn(`Invalid data for structure break detection for ${symbol}`);
    return { estruturaAlta: 0, estruturaBaixa: 0, buyLiquidityZones: [], sellLiquidityZones: [] };
  }
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const volumeThreshold = Math.max(...volumes) * 0.7;
  const buyLiquidityZones = [];
  const sellLiquidityZones = [];
  previousCandles.forEach(candle => {
    const high = candle.high;
    const low = candle.low;
    const volume = candle.volume;
    if (volume >= volumeThreshold && !isNaN(low) && !isNaN(high)) {
      if (low <= minLow * 1.01) buyLiquidityZones.push(low);
      if (high >= maxHigh * 0.99) sellLiquidityZones.push(high);
    }
  });
  return {
    estruturaAlta: maxHigh,
    estruturaBaixa: minLow,
    buyLiquidityZones: [...new Set(buyLiquidityZones)].sort((a, b) => b - a).slice(0, 3),
    sellLiquidityZones: [...new Set(sellLiquidityZones)].sort((a, b) => a - b).slice(0, 3)
  };
}

function calculateVolumeProfile(ohlcv, symbol, priceStepPercent = 0.1) {
  if (!ohlcv || ohlcv.length < 2) {
    logger.warn(`Insufficient data for volume profile calculation for ${symbol}`);
    return { buyLiquidityZones: [], sellLiquidityZones: [] };
  }
  const priceRange = Math.max(...ohlcv.map(c => c.high)) - Math.min(...ohlcv.map(c => c.low));
  const step = priceRange * priceStepPercent / 100;
  const volumeProfile = {};
  ohlcv.forEach(candle => {
    const price = (candle.high + candle.low) / 2;
    if (isNaN(price) || isNaN(candle.volume)) return;
    const bucket = Math.floor(price / step) * step;
    volumeProfile[bucket] = (volumeProfile[bucket] || 0) + candle.volume;
  });
  const sortedBuckets = Object.entries(volumeProfile)
    .sort(([, volA], [, volB]) => volB - volA)
    .slice(0, 3)
    .map(([price]) => parseFloat(price));
  return {
    buyLiquidityZones: sortedBuckets.filter(p => p <= ohlcv[ohlcv.length - 1].close).sort((a, b) => b - a),
    sellLiquidityZones: sortedBuckets.filter(p => p > ohlcv[ohlcv.length - 1].close).sort((a, b) => a - b)
  };
}

async function fetchLSR(symbol) {
  const cacheKey = `lsr_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    let apiSymbol = symbol.replace('/', '').toUpperCase();
    if (apiSymbol.endsWith(':USDT')) apiSymbol = apiSymbol.replace(':USDT', '');
    logger.info(`Fetching LSR for symbol: ${apiSymbol}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const res = await withRetry(() => axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', {
      params: { symbol: apiSymbol, period: '15m', limit: 2 }
    }));
    if (!res.data || !Array.isArray(res.data) || res.data.length < 2) {
      logger.warn(`Insufficient LSR data for ${symbol}: ${res.data?.length || 0} records`);
      return { value: null, isRising: false, percentChange: '0.00' };
    }
    const currentLSR = parseFloat(res.data[0].longShortRatio);
    const previousLSR = parseFloat(res.data[1].longShortRatio);
    if (isNaN(currentLSR) || isNaN(previousLSR)) {
      logger.warn(`Invalid LSR values for ${symbol}: current=${currentLSR}, previous=${previousLSR}`);
      return { value: null, isRising: false, percentChange: '0.00' };
    }
    const percentChange = previousLSR !== 0 ? ((currentLSR - previousLSR) / previousLSR * 100).toFixed(2) : '0.00';
    const result = { value: parseFloat(currentLSR.toFixed(2)), isRising: currentLSR > previousLSR, percentChange };
    setCachedData(cacheKey, result);
    logger.info(`LSR calculated for ${symbol}: ${result.value}, isRising: ${result.isRising}, percentChange: ${percentChange}%`);
    return result;
  } catch (e) {
    logger.warn(`Error fetching LSR for ${symbol}: ${e.message}`);
    return { value: null, isRising: false, percentChange: '0.00' };
  }
}

async function fetchFundingRate(symbol) {
  const cacheKey = `funding_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const fundingData = await withRetry(() => exchangeFutures.fetchFundingRateHistory(symbol, undefined, 2));
    if (!fundingData || fundingData.length < 2) {
      logger.warn(`Insufficient funding rate data for ${symbol}: ${fundingData?.length || 0} records`);
      return { current: null, isRising: false, percentChange: '0.00' };
    }
    const currentFunding = parseFloat(fundingData[fundingData.length - 1].fundingRate);
    const previousFunding = parseFloat(fundingData[fundingData.length - 2].fundingRate);
    const percentChange = previousFunding !== 0 ? ((currentFunding - previousFunding) / Math.abs(previousFunding) * 100).toFixed(2) : '0.00';
    const result = { current: parseFloat((currentFunding * 100).toFixed(5)), isRising: currentFunding > previousFunding, percentChange };
    setCachedData(cacheKey, result);
    state.lastFundingRates.set(symbol, result.current);
    logger.info(`Funding rate fetched for ${symbol}: ${result.current}%`);
    return result;
  } catch (e) {
    logger.warn(`Error fetching funding rate for ${symbol}: ${e.message}`);
    return { current: null, isRising: false, percentChange: '0.00' };
  }
}

async function fetchOpenInterest(symbol, timeframe) {
  const cacheKey = `oi_${symbol}_${timeframe}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const oiData = await withRetry(() => exchangeFutures.fetchOpenInterestHistory(symbol, timeframe, undefined, 30));
    if (!oiData || oiData.length < 3) {
      logger.warn(`Insufficient Open Interest data for ${symbol} in timeframe ${timeframe}: ${oiData?.length || 0} records`);
      return { isRising: false, value: null, percentChange: '0.00' };
    }
    const validOiData = oiData
      .filter(d => {
        const oiValue = d.openInterest || d.openInterestAmount || (d.info && d.info.sumOpenInterest);
        return typeof oiValue === 'number' && !isNaN(oiValue) && oiValue >= 0;
      })
      .map(d => ({
        ...d,
        openInterest: d.openInterest || d.openInterestAmount || (d.info && d.info.sumOpenInterest)
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
    if (validOiData.length < 3) {
      logger.warn(`Insufficient valid Open Interest records for ${symbol} in timeframe ${timeframe}: ${validOiData.length}`);
      return { isRising: false, value: null, percentChange: '0.00' };
    }
    const oiValues = validOiData.map(d => d.openInterest).filter(v => v !== undefined);
    const sortedOi = [...oiValues].sort((a, b) => a - b);
    const median = sortedOi[Math.floor(sortedOi.length / 2)];
    const filteredOiData = validOiData.filter(d => d.openInterest >= median * 0.5 && d.openInterest <= median * 1.5);
    if (filteredOiData.length < 3) {
      logger.warn(`Insufficient valid Open Interest records after filtering for ${symbol} in timeframe ${timeframe}: ${filteredOiData.length}`);
      return { isRising: false, value: null, percentChange: '0.00' };
    }
    const recentOi = filteredOiData.slice(0, 3).map(d => d.openInterest);
    const previousOi = filteredOiData.slice(3, 6).map(d => d.openInterest);
    const smaRecent = recentOi.reduce((sum, val) => sum + val, 0) / recentOi.length;
    const previousSma = previousOi.length >= 3 ? previousOi.reduce((sum, val) => sum + val, 0) / previousOi.length : recentOi[recentOi.length - 1];
    const percentChange = previousSma !== 0 ? ((smaRecent - previousSma) / previousSma * 100).toFixed(2) : '0.00';
    const result = { 
      isRising: smaRecent > previousSma, 
      value: parseFloat(smaRecent.toFixed(2)),
      percentChange
    };
    setCachedData(cacheKey, result);
    logger.info(`Open Interest calculated for ${symbol} in timeframe ${timeframe}: smaRecent=${smaRecent}, smaPrevious=${previousSma}, isRising=${result.isRising}, percentChange=${percentChange}%`);
    return result;
  } catch (e) {
    logger.warn(`Error fetching Open Interest for ${symbol} in timeframe ${timeframe}: ${e.message}`);
    return { isRising: false, value: null, percentChange: '0.00' };
  }
}

async function calculateAggressiveDelta(symbol, timeframe = '15m', limit = config.LIMIT_TRADES_DELTA) {
  const cacheKey = `delta_${symbol}_${timeframe}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const trades = await withRetry(() => exchangeFutures.fetchTrades(symbol, undefined, limit));
    let buyVolume = 0;
    let sellVolume = 0;
    for (const trade of trades) {
      const { side, amount, price } = trade;
      if (!side || !amount || !price || isNaN(amount) || isNaN(price)) continue;
      if (side === 'buy') buyVolume += amount;
      else if (side === 'sell') sellVolume += amount;
    }
    const delta = buyVolume - sellVolume;
    const totalVolume = buyVolume + sellVolume;
    const deltaPercent = totalVolume !== 0 ? parseFloat((delta / totalVolume * 100).toFixed(2)) : 0;
    const result = { 
      delta, 
      deltaPercent, 
      isBuyPressure: delta > 0, 
      isSignificant: Math.abs(deltaPercent) > 10 
    };
    setCachedData(cacheKey, result);
    logger.info(`Aggressive Delta for ${symbol}: Buy=${buyVolume}, Sell=${sellVolume}, Delta=${delta}, Delta%=${deltaPercent}%`);
    return result;
  } catch (e) {
    logger.error(`Error calculating Aggressive Delta for ${symbol}: ${e.message}`);
    return { delta: 0, deltaPercent: 0, isBuyPressure: false, isSignificant: false };
  }
}

async function fetchLiquidityZones(symbol) {
  const cacheKey = `liquidity_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const orderBook = await withRetry(() => exchangeSpot.fetchOrderBook(symbol, 20));
    const bids = orderBook.bids;
    const asks = orderBook.asks;
    const liquidityThreshold = 0.5;
    const totalBidVolume = bids.reduce((sum, [, vol]) => sum + vol, 0);
    const totalAskVolume = asks.reduce((sum, [, vol]) => sum + vol, 0);
    const buyLiquidityZones = bids
      .filter(([price, volume]) => volume >= totalBidVolume * liquidityThreshold)
      .map(([price]) => price);
    const sellLiquidityZones = asks
      .filter(([price, volume]) => volume >= totalAskVolume * liquidityThreshold)
      .map(([price]) => price);
    const result = { buyLiquidityZones, sellLiquidityZones };
    setCachedData(cacheKey, result);
    return result;
  } catch (e) {
    logger.error(`Error fetching liquidity zones for ${symbol}: ${e.message}`);
    return { buyLiquidityZones: [], sellLiquidityZones: [] };
  }
}

async function detectVolumeSpike(symbol, timeframe = '15m') {
  try {
    const ohlcv = await withRetry(() => exchangeFutures.fetchOHLCV(symbol, timeframe, undefined, 3));
    const volumes = normalizeOHLCV(ohlcv, symbol).map(d => d.volume);
    if (volumes.length < 2) return false;
    const spike = volumes[volumes.length - 1] / volumes[volumes.length - 2] > config.VOLUME_SPIKE_THRESHOLD;
    logger.info(`Volume spike for ${symbol}: ${spike ? 'Detected' : 'Not detected'}, current volume: ${volumes[volumes.length - 1]}, previous volume: ${volumes[volumes.length - 2]}`);
    return spike;
  } catch (e) {
    logger.warn(`Error detecting volume spike for ${symbol}: ${e.message}`);
    return false;
  }
}

async function detectFundingRateChange(symbol, currentFundingRate) {
  const lastFundingRate = state.lastFundingRates.get(symbol) || currentFundingRate;
  const change = Math.abs(currentFundingRate - lastFundingRate);
  const isSignificantChange = change >= config.FUNDING_RATE_CHANGE_THRESHOLD;
  logger.info(`Funding Rate for ${symbol}: Current=${currentFundingRate}%, Previous=${lastFundingRate}%, Change=${change}, Significant=${isSignificantChange}`);
  return isSignificantChange;
}

function updateRsiPeaks(symbol, rsi15m) {
  const cacheKey = `rsi_peaks_${symbol}`;
  const currentPeaks = state.rsiPeaks.get(cacheKey) || {
    oversold15m: false,
    overbought15m: false,
    timestamp: Date.now()
  };
  if (rsi15m !== null && rsi15m < config.RSI_OVERSOLD_THRESHOLD) {
    currentPeaks.oversold15m = true;
  }
  if (rsi15m !== null && rsi15m > config.RSI_OVERBOUGHT_THRESHOLD) {
    currentPeaks.overbought15m = true;
  }
  if (rsi15m !== null && rsi15m >= config.RSI_OVERSOLD_THRESHOLD && rsi15m <= config.RSI_OVERBOUGHT_THRESHOLD) {
    currentPeaks.oversold15m = false;
    currentPeaks.overbought15m = false;
  }
  state.rsiPeaks.set(cacheKey, { ...currentPeaks, timestamp: Date.now() });
  logger.info(`RSI Peaks updated for ${symbol}: ${JSON.stringify(currentPeaks)}`);
}

// ================= FUNÇÕES DE ALERTAS ================= //
function getStochasticEmoji(value) {
  if (!value) return "";
  return value < 10 ? "🔵" : value < 25 ? "🟢" : value <= 55 ? "🟡" : value <= 70 ? "🟠" : value <= 80 ? "🔴" : "💥";
}

function getATREmoji(atrPercent) {
  if (!atrPercent || isNaN(atrPercent)) return "";
  return atrPercent < 0.2 ? "🔵Ruim" : atrPercent < 0.5 ? "🟢Regular" : atrPercent <= 1.5 ? "🟡Médio" : atrPercent <= 3 ? "🟠Bom" : atrPercent <= 5 ? "🔴Muito Bom" : "💥Excelente";
}

function getSetaDirecao(current, previous) {
  if (!current || !previous) return "➡️";
  return current > previous ? "⬆️" : current < previous ? "⬇️" : "➡️";
}

async function sendTelegramMessage(message) {
  const maxLength = config.MAX_MESSAGE_LENGTH;
  if (message.length <= maxLength) {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, message, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }));
    logger.info(`Message sent successfully, length: ${message.length} characters`);
    return;
  }
  const lines = message.split('\n');
  let part = '';
  const parts = [];
  for (const line of lines) {
    if (part.length + line.length + 1 > maxLength) {
      parts.push(part);
      part = '';
    }
    part += line + '\n';
  }
  if (part) parts.push(part);
  for (let i = 0; i < parts.length; i++) {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, parts[i], {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    }));
    logger.info(`Part ${i + 1}/${parts.length} sent, length: ${parts[i].length} characters`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function sendMonitorAlert(coins) {
  const format = (v, precision = 2) => isNaN(v) || v === null ? 'N/A' : v.toFixed(precision);
  const formatPrice = (price) => price < 1 ? price.toFixed(8) : price < 10 ? price.toFixed(6) : price < 100 ? price.toFixed(4) : price.toFixed(2);

  const topLowRsiWithBullishEMA = coins
    .filter(c => c.rsi !== null && c.rsi < config.RSI_OVERSOLD_THRESHOLD && c.emaCrossover.isBullishCrossover && c.lsr !== null && c.lsr < 2.5)
    .sort((a, b) => a.rsi - b.rsi)
    .slice(0, config.MAX_COINS_PER_ALERT);

  const topHighRsiWithBearishEMA = coins
    .filter(c => c.rsi !== null && c.rsi > config.RSI_OVERBOUGHT_THRESHOLD && c.emaCrossover.isBearishCrossover && c.lsr !== null && c.lsr > 2.5)
    .sort((a, b) => b.rsi - a.rsi)
    .slice(0, config.MAX_COINS_PER_ALERT);

  logger.info(`Low RSI with bullish EMA and LSR < 2.5: ${topLowRsiWithBullishEMA.length}, High RSI with bearish EMA and LSR > 2.5: ${topHighRsiWithBearishEMA.length}`);

  if (topLowRsiWithBullishEMA.length > 0) {
    let emaBullishAlertText = `🟢*RSI Baixo + Tendência (EMA${config.EMA_FAST_PERIOD}⤴️EMA${config.EMA_SLOW_PERIOD} 3m) 📈*\n\n`;
    emaBullishAlertText += await Promise.all(topLowRsiWithBullishEMA.map(async (coin, i) => {
      const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${coin.symbol.replace('/', '')}&interval=15`;
      const deltaText = coin.delta.isBuyPressure ? `💹${format(coin.delta.deltaPercent)}%` : `⭕${format(coin.delta.deltaPercent)}%`;
      let lsrSymbol = '';
      if (coin.lsr !== null && !isNaN(coin.lsr)) {
        if (coin.lsr <= 1.4) lsrSymbol = '✅ Baixo';
        else if (coin.lsr >= 2.8) lsrSymbol = '📛 Alto';
      }
      const lsrText = coin.lsr !== null && !isNaN(coin.lsr) ? format(coin.lsr) + ` ${lsrSymbol}` : 'Indisponível';
      let fundingRateEmoji = '';
      if (coin.funding.current !== null) {
        if (coin.funding.current <= -0.002) fundingRateEmoji = '🟢🟢🟢';
        else if (coin.funding.current <= -0.001) fundingRateEmoji = '🟢🟢';
        else if (coin.funding.current <= -0.0005) fundingRateEmoji = '🟢';
        else if (coin.funding.current >= 0.001) fundingRateEmoji = '🔴🔴🔴';
        else if (coin.funding.current >= 0.0003) fundingRateEmoji = '🔴🔴';
        else if (coin.funding.current >= 0.0002) fundingRateEmoji = '🔴';
        else fundingRateEmoji = '🟢';
      }
      const oi5mText = coin.oi5m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const oi15mText = coin.oi15m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const isVolumeSpike = await detectVolumeSpike(coin.symbol);
      const isFundingAnomaly = await detectFundingRateChange(coin.symbol, coin.funding.current);
      const anomalyText = isVolumeSpike || isFundingAnomaly ? `🚨 Anomalia: ${isVolumeSpike ? '📈Pico de Volume📈' : ''}${isVolumeSpike && isFundingAnomaly ? ' | ' : ''}${isFundingAnomaly ? 'Mudança no Funding Rate' : ''}\n` : '';
      const stoch4hK = coin.stoch4h.k !== null ? format(coin.stoch4h.k) : 'N/A';
      const stoch4hD = coin.stoch4h.d !== null ? format(coin.stoch4h.d) : 'N/A';
      const stoch4hKEmoji = getStochasticEmoji(coin.stoch4h.k);
      const stoch4hDEmoji = getStochasticEmoji(coin.stoch4h.d);
      const stoch4hDir = getSetaDirecao(coin.stoch4h.k, coin.stoch4h.previousK);
      const stoch1dK = coin.stoch1d.k !== null ? format(coin.stoch1d.k) : 'N/A';
      const stoch1dD = coin.stoch1d.d !== null ? format(coin.stoch1d.d) : 'N/A';
      const stoch1dKEmoji = getStochasticEmoji(coin.stoch1d.k);
      const stoch1dDEmoji = getStochasticEmoji(coin.stoch1d.d);
      const stoch1dDir = getSetaDirecao(coin.stoch1d.k, coin.stoch1d.previousK);
      const adxText = coin.adx !== null ? format(coin.adx) : 'N/A';
      const adxNote = coin.adx !== null && coin.adx >= 20 && coin.adx <= 30 ? '🟣Analisar🟣' : '';
      const atrEmoji = getATREmoji(coin.atrPercent);
      const target1 = coin.atr !== null && coin.price !== null ? coin.price + coin.atr : null;
      const target2 = coin.atr !== null && coin.price !== null ? coin.price + 2 * coin.atr : null;
      const target3 = coin.atr !== null && coin.price !== null ? coin.price + 3 * coin.atr : null;
      const stopLoss = coin.atr !== null && coin.price !== null ? coin.price - 1.7 * coin.atr : null;
      const targetsText = target1 && target2 && target3 && stopLoss 
        ? `, ▪︎T1: ${formatPrice(target1)}, ▪︎T2: ${formatPrice(target2)}, ▪︎T3: ${formatPrice(target3)}, ⛔Stop: ${formatPrice(stopLoss)}`
        : '';
      return `${i + 1}. 🔹 *${cleanSymbol(coin.symbol)}* [- TradingView](${tradingViewLink})\n` +
             `   💲 Preço: ${formatPrice(coin.price)}${targetsText}\n` +
             `   LSR: ${lsrText}\n` +
             `   RSI (15m): ${format(coin.rsi)}\n` +
             `   RSI (1h): ${format(coin.rsi1h)}\n` +
             `   RSI (4h): ${format(coin.rsi4h)}\n` +
             `   ADX (15m): ${adxText}${adxNote ? ` ${adxNote}` : ''}\n` +
             `   ATR (15m): ${format(coin.atr, 4)}${atrEmoji}\n` +
             `   Stoch (4h): %K ${stoch4hK}${stoch4hKEmoji} ${stoch4hDir} \n` +
             `   Stoch (1d): %K ${stoch1dK}${stoch1dKEmoji} ${stoch1dDir} \n` +
             `   Vol.Delta: ${deltaText}\n` +
             `   Fund.Rate: ${fundingRateEmoji}${format(coin.funding.current, 5)}%\n` +
             `   OI 5m: ${oi5mText}\n` +
             `   OI 15m: ${oi15mText}\n` +
             `   Suporte: ${formatPrice(coin.supportResistance.support)}\n` +
             `   Resistência: ${formatPrice(coin.supportResistance.resistance)}\n` +
             anomalyText;
    })).then(results => results.join('\n'));
    emaBullishAlertText += `\n☑︎ 🤖 Monitor - @J4Rviz`;
    logger.info(`Low RSI with bullish EMA message length: ${emaBullishAlertText.length} characters`);
    await sendTelegramMessage(emaBullishAlertText);
    logger.info('Low RSI with bullish EMA alert sent successfully');
  }

  if (topHighRsiWithBearishEMA.length > 0) {
    let emaBearishAlertText = `🔴*RSI Alto + Tendência (EMA${config.EMA_FAST_PERIOD}⤵️EMA${config.EMA_SLOW_PERIOD} 3m) 📉*\n\n`;
    emaBearishAlertText += await Promise.all(topHighRsiWithBearishEMA.map(async (coin, i) => {
      const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${coin.symbol.replace('/', '')}&interval=15`;
      const deltaText = coin.delta.isBuyPressure ? `💹${format(coin.delta.deltaPercent)}%` : `⭕${format(coin.delta.deltaPercent)}%`;
      let lsrSymbol = '';
      if (coin.lsr !== null && !isNaN(coin.lsr)) {
        if (coin.lsr <= 1.4) lsrSymbol = '✅ Baixo';
        else if (coin.lsr >= 2.8) lsrSymbol = '📛 Alto';
      }
      const lsrText = coin.lsr !== null && !isNaN(coin.lsr) ? format(coin.lsr) + ` ${lsrSymbol}` : 'Indisponível';
      let fundingRateEmoji = '';
      if (coin.funding.current !== null) {
        if (coin.funding.current <= -0.002) fundingRateEmoji = '🟢🟢🟢';
        else if (coin.funding.current <= -0.001) fundingRateEmoji = '🟢🟢';
        else if (coin.funding.current <= -0.0005) fundingRateEmoji = '🟢';
        else if (coin.funding.current >= 0.001) fundingRateEmoji = '🔴🔴🔴';
        else if (coin.funding.current >= 0.0003) fundingRateEmoji = '🔴🔴';
        else if (coin.funding.current >= 0.0002) fundingRateEmoji = '🔴';
        else fundingRateEmoji = '🟢';
      }
      const oi5mText = coin.oi5m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const oi15mText = coin.oi15m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const isVolumeSpike = await detectVolumeSpike(coin.symbol);
      const isFundingAnomaly = await detectFundingRateChange(coin.symbol, coin.funding.current);
      const anomalyText = isVolumeSpike || isFundingAnomaly ? `🚨 Anomalia: ${isVolumeSpike ? 'Pico de Volume' : ''}${isVolumeSpike && isFundingAnomaly ? ' | ' : ''}${isFundingAnomaly ? 'Mudança no Funding Rate' : ''}\n` : '';
      const stoch4hK = coin.stoch4h.k !== null ? format(coin.stoch4h.k) : 'N/A';
      const stoch4hD = coin.stoch4h.d !== null ? format(coin.stoch4h.d) : 'N/A';
      const stoch4hKEmoji = getStochasticEmoji(coin.stoch4h.k);
      const stoch4hDEmoji = getStochasticEmoji(coin.stoch4h.d);
      const stoch4hDir = getSetaDirecao(coin.stoch4h.k, coin.stoch4h.previousK);
      const stoch1dK = coin.stoch1d.k !== null ? format(coin.stoch1d.k) : 'N/A';
      const stoch1dD = coin.stoch1d.d !== null ? format(coin.stoch1d.d) : 'N/A';
      const stoch1dKEmoji = getStochasticEmoji(coin.stoch1d.k);
      const stoch1dDEmoji = getStochasticEmoji(coin.stoch1d.d);
      const stoch1dDir = getSetaDirecao(coin.stoch1d.k, coin.stoch1d.previousK);
      const adxText = coin.adx !== null ? format(coin.adx) : 'N/A';
      const adxNote = coin.adx !== null && coin.adx >= 20 && coin.adx <= 30 ? '🟣Analisar🟣' : '';
      const atrEmoji = getATREmoji(coin.atrPercent);
      const target1 = coin.atr !== null && coin.price !== null ? coin.price - coin.atr : null;
      const target2 = coin.atr !== null && coin.price !== null ? coin.price - 2 * coin.atr : null;
      const target3 = coin.atr !== null && coin.price !== null ? coin.price - 3 * coin.atr : null;
      const stopLoss = coin.atr !== null && coin.price !== null ? coin.price + 1.7 * coin.atr : null;
      const targetsText = target1 && target2 && target3 && stopLoss 
        ? `, ▪︎T1: ${formatPrice(target1)}, ▪︎T2: ${formatPrice(target2)}, ▪︎T3: ${formatPrice(target3)}, ⛔Stop: ${formatPrice(stopLoss)}`
        : '';
      return `${i + 1}. 🔻 *${cleanSymbol(coin.symbol)}* [- TradingView](${tradingViewLink})\n` +
             `   💲 Preço: ${formatPrice(coin.price)}${targetsText}\n` +
             `   LSR: ${lsrText}\n` +
             `   RSI (15m): ${format(coin.rsi)}\n` +
             `   RSI (1h): ${format(coin.rsi1h)}\n` +
             `   RSI (4h): ${format(coin.rsi4h)}\n` +
             `   ADX (15m): ${adxText}${adxNote ? ` ${adxNote}` : ''}\n` +
             `   ATR (15m): ${format(coin.atr, 4)}${atrEmoji}\n` +
             `   Stoch (4h): %K ${stoch4hK}${stoch4hKEmoji} ${stoch4hDir} | %D ${stoch4hD}${stoch4hDEmoji}\n` +
             `   Stoch (1d): %K ${stoch1dK}${stoch1dKEmoji} ${stoch1dDir} | %D ${stoch1dD}${stoch1dDEmoji}\n` +
             `   Vol.Delta: ${deltaText}\n` +
             `   Fund.Rate: ${fundingRateEmoji}${format(coin.funding.current, 5)}%\n` +
             `   OI 5m: ${oi5mText}\n` +
             `   OI 15m: ${oi15mText}\n` +
             `   Suporte: ${formatPrice(coin.supportResistance.support)}\n` +
             `   Resistência: ${formatPrice(coin.supportResistance.resistance)}\n` +
             anomalyText;
    })).then(results => results.join('\n'));
    emaBearishAlertText += `\n☑︎ 🤖 Monitor - @J4Rviz`;
    logger.info(`High RSI with bearish EMA message length: ${emaBearishAlertText.length} characters`);
    await sendTelegramMessage(emaBearishAlertText);
    logger.info('High RSI with bearish EMA alert sent successfully');
  }

  if (topLowRsiWithBullishEMA.length === 0 && topHighRsiWithBearishEMA.length === 0) {
    logger.info('No RSI/EMA alerts triggered');
  }
}

async function sendAlertStochasticCross(symbol, data) {
  const { ohlcv15m, ohlcv4h, ohlcv1h, ohlcvDiario, ohlcv3m, price, rsi1h, lsr, fundingRate, aggressiveDelta, estocastico4h, estocasticoD, oi5m, oi15m, atr, ema34_3m, ema89_3m, adx } = data;
  const agora = Date.now();
  if (!state.ultimoAlertaPorAtivo[symbol]) state.ultimoAlertaPorAtivo[symbol] = { historico: [] };
  if (state.ultimoAlertaPorAtivo[symbol]['4h'] && agora - state.ultimoAlertaPorAtivo[symbol]['4h'] < config.TEMPO_COOLDOWN_MS) return;

  const precision = price < 1 ? 8 : price < 10 ? 6 : price < 100 ? 4 : 2;
  const format = v => isNaN(v) ? 'N/A' : v.toFixed(precision);
  const zonas = detectarQuebraEstrutura(ohlcv15m, symbol);
  const volumeProfile = calculateVolumeProfile(ohlcv15m, symbol);
  const orderBookLiquidity = await fetchLiquidityZones(symbol);

  const isNearBuyZone = zonas.buyLiquidityZones.some(zone => Math.abs(price - zone) <= atr * 0.01);
  const isNearSellZone = zonas.sellLiquidityZones.some(zone => Math.abs(price - zone) <= atr * 0.01);

  const volatility = atr && price ? atr / price : 0;
  if (volatility < config.VOLATILITY_MIN) {
    logger.info(`Insufficient volatility for ${symbol}: ${volatility.toFixed(4)} < ${config.VOLATILITY_MIN}`);
    return;
  }

  const volumes3m = ohlcv3m.map(c => c.volume).filter(v => !isNaN(v));
  const avgVolume3m = volumes3m.slice(0, -1).length > 0 ? volumes3m.slice(0, -1).reduce((sum, v) => sum + v, 0) / (volumes3m.length - 1) : 0;
  const currentVolume3m = volumes3m[volumes3m.length - 1] || 0;
  const isAbnormalVolume = avgVolume3m > 0 && currentVolume3m >= avgVolume3m * 2;

  const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol.replace('/', '')}&interval=15`;
  const rsi1hEmoji = rsi1h > 60 ? "☑︎" : rsi1h < 40 ? "☑︎" : "";
  let lsrSymbol = '🔘Consol.';
  if (lsr.value !== null) {
    if (lsr.value <= 1.4) lsrSymbol = '✅Baixo';
    else if (lsr.value >= 2.8) lsrSymbol = '📛Alto';
  }
  let fundingRateEmoji = '';
  if (fundingRate.current !== null) {
    if (fundingRate.current <= -0.002) fundingRateEmoji = '🟢🟢🟢';
    else if (fundingRate.current <= -0.001) fundingRateEmoji = '🟢🟢';
    else if (fundingRate.current <= -0.0005) fundingRateEmoji = '🟢';
    else if (fundingRate.current >= 0.001) fundingRateEmoji = '🔴🔴🔴';
    else if (fundingRate.current >= 0.0003) fundingRateEmoji = '🔴🔴';
    else if (fundingRate.current >= 0.0002) fundingRateEmoji = '🔴';
    else fundingRateEmoji = '🟢';
  }
  const fundingRateText = fundingRate.current !== null 
    ? `${fundingRateEmoji} ${(fundingRate.current * 100).toFixed(5)}% ${fundingRate.isRising ? '⬆️' : '⬇️'}`
    : '🔹 Indisp.';
  const deltaText = aggressiveDelta.isSignificant 
    ? `${aggressiveDelta.isBuyPressure ? '💹F.Comprador' : '⭕F.Vendedor'} ${aggressiveDelta.deltaPercent > 60 && lsr.value !== null && lsr.value < 1 ? '💥' : ''}(${aggressiveDelta.deltaPercent}%)`
    : '🔘Neutro';
  const oi5mText = oi5m ? `${oi5m.isRising ? '📈' : '📉'} OI 5m: ${oi5m.percentChange}%` : '🔹 Indisp.';
  const oi15mText = oi15m ? `${oi15m.isRising ? '📈' : '📉'} OI 15m: ${oi15m.percentChange}%` : '🔹 Indisp.';
  const emaText = ema34_3m && ema89_3m ? `${ema34_3m > ema89_3m ? '🟢 EMA 34 > 89 (3m)' : '🔴 EMA 34 < 89 (3m)'}` : '🔹 EMA Indisp.';

  if (!state.ultimoEstocastico[symbol]) state.ultimoEstocastico[symbol] = {};
  const kAnteriorD = state.ultimoEstocastico[symbol].kD || estocasticoD?.k || 0;
  const kAnterior4h = state.ultimoEstocastico[symbol].k4h || estocastico4h?.k || 0;
  state.ultimoEstocastico[symbol].kD = estocasticoD?.k;
  state.ultimoEstocastico[symbol].k4h = estocastico4h?.k;
  const direcaoD = getSetaDirecao(estocasticoD?.k, kAnteriorD);
  const direcao4h = getSetaDirecao(estocastico4h?.k, kAnterior4h);
  const stochDEmoji = estocasticoD ? getStochasticEmoji(estocasticoD.k) : "";
  const stoch4hEmoji = estocastico4h ? getStochasticEmoji(estocastico4h.k) : "";

  const vpBuyZonesText = volumeProfile.buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const vpSellZonesText = volumeProfile.sellLiquidityZones.map(format).join(' / ') || 'N/A';

  const entryLow = format(price - 0.3 * atr);
  const entryHigh = format(price + 0.5 * atr);
  const targetsBuy = [1.5, 3, 4.5, 6].map(mult => format(price + mult * atr)).join(" / ");
  const targetsSell = [1.5, 3, 4.5, 6].map(mult => format(price - mult * atr)).join(" / ");
  const stopBuy = format(price - 3.5 * atr);
  const stopSell = format(price + 3.5 * atr);

  let alertText = '';
  const isBuySignal = estocastico4h && estocasticoD &&
                      estocastico4h.k > estocastico4h.d && 
                      estocastico4h.k <= config.STOCHASTIC_BUY_MAX && 
                      estocasticoD.k <= config.STOCHASTIC_BUY_MAX &&
                      rsi1h < 60 && 
                      oi5m.isRising &&
                      oi15m.isRising && 
                      (lsr.value === null || lsr.value < config.LSR_BUY_MAX) &&
                      aggressiveDelta.deltaPercent >= config.DELTA_BUY_MIN &&
                      ema34_3m > ema89_3m &&
                      volatility >= config.VOLATILITY_MIN &&
                      isAbnormalVolume &&
                      adx >= config.ADX_MIN;

  const isSellSignal = estocastico4h && estocasticoD &&
                       estocastico4h.k < estocastico4h.d && 
                       estocastico4h.k >= config.STOCHASTIC_SELL_MIN && 
                       estocasticoD.k >= config.STOCHASTIC_SELL_MIN &&
                       rsi1h > 68 && 
                       !oi5m.isRising &&
                       !oi15m.isRising && 
                       (lsr.value === null || lsr.value > config.LSR_SELL_MIN) &&
                       aggressiveDelta.deltaPercent <= config.DELTA_SELL_MAX &&
                       ema34_3m < ema89_3m &&
                       volatility >= config.VOLATILITY_MIN &&
                       isAbnormalVolume &&
                       adx >= config.ADX_MIN;

  if (isBuySignal) {
    const foiAlertado = state.ultimoAlertaPorAtivo[symbol].historico.some(r => 
      r.direcao === 'buy' && (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = `💹*Stoch 4h - 🤖 Compra/Reversão *\n\n` +
                  `🔹Ativo: <<*${symbol}*>> [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço: ${format(price)}\n` +
                  `🔹 RSI 1h: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 Stoch Diário %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${stochDEmoji} ${direcaoD}\n` +
                  `🔹 Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${stoch4hEmoji} ${direcao4h}\n` +
                  `🔹 ${oi5mText}\n` +
                  `🔹 ${oi15mText}\n` +
                  `🔹 ${emaText}\n` +
                  `🔹 Entr.: ${entryLow}...${entryHigh}\n` +
                  `🎯 Tps: ${targetsBuy}\n` +
                  `⛔ Stop: ${stopBuy}\n` +
                  `   Romp. de Baixa: ${format(zonas.estruturaBaixa)}\n` +
                  `   Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
                  `   Poc Bull: ${vpBuyZonesText}\n` +
                  `   Poc Bear: ${vpSellZonesText}\n` +
                  ` ☑︎ Gerencie seu Risco - 🤖 @J4Rviz\n`;
      state.ultimoAlertaPorAtivo[symbol]['4h'] = agora;
      state.ultimoAlertaPorAtivo[symbol].historico.push({ direcao: 'buy', timestamp: agora });
      state.ultimoAlertaPorAtivo[symbol].historico = state.ultimoAlertaPorAtivo[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.info(`Buy signal detected for ${symbol}: Price=${format(price)}, Stoch 4h K=${estocastico4h.k}, D=${estocastico4h.d}, Stoch Daily K=${estocasticoD.k}, RSI 1h=${rsi1h.toFixed(2)}, OI 5m=${oi5m.percentChange}%, OI 15m=${oi15m.percentChange}%, LSR=${lsr.value ? lsr.value.toFixed(2) : 'N/A'}, Delta=${aggressiveDelta.deltaPercent}%, NearBuyZone=${isNearBuyZone}, EMA34_3m=${ema34_3m}, EMA89_3m=${ema89_3m}, Volatility=${volatility.toFixed(4)}, AbnormalVolume=${isAbnormalVolume}, ADX=${adx.toFixed(2)}`);
    }
  } else if (isSellSignal) {
    const foiAlertado = state.ultimoAlertaPorAtivo[symbol].historico.some(r => 
      r.direcao === 'sell' && (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = `🛑*Stoch 4h - 🤖 Correção *\n\n` +
                  `🔹Ativo: <<*${symbol}*>> [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço: ${format(price)}\n` +
                  `🔹 RSI 1h: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 Stoch Diário: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${stochDEmoji} ${direcaoD}\n` +
                  `🔹 Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${stoch4hEmoji} ${direcao4h}\n` +
                  `🔹 ${oi5mText}\n` +
                  `🔹 ${oi15mText}\n` +
                  `🔹 ${emaText}\n` +
                  `🔹 Entr.: ${entryLow}...${entryHigh}\n` +
                  `🎯 Tps: ${targetsSell}\n` +
                  `⛔ Stop: ${stopSell}\n` +
                  `   Romp. de Baixa: ${format(zonas.estruturaBaixa)}\n` +
                  `   Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
                  `   Poc Bull: ${vpBuyZonesText}\n` +
                  `   Poc Bear: ${vpSellZonesText}\n` +
                  ` ☑︎ Gerencie seu Risco - 🤖 @J4Rviz\n`;
      state.ultimoAlertaPorAtivo[symbol]['4h'] = agora;
      state.ultimoAlertaPorAtivo[symbol].historico.push({ direcao: 'sell', timestamp: agora });
      state.ultimoAlertaPorAtivo[symbol].historico = state.ultimoAlertaPorAtivo[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.info(`Sell signal detected for ${symbol}: Price=${format(price)}, Stoch 4h K=${estocastico4h.k}, D=${estocastico4h.d}, Stoch Daily K=${estocasticoD.k}, RSI 1h=${rsi1h.toFixed(2)}, OI 5m=${oi5m.percentChange}%, OI 15m=${oi15m.percentChange}%, LSR=${lsr.value ? lsr.value.toFixed(2) : 'N/A'}, Delta=${aggressiveDelta.deltaPercent}%, NearSellZone=${isNearSellZone}, EMA34_3m=${ema34_3m}, EMA89_3m=${ema89_3m}, Volatility=${volatility.toFixed(4)}, AbnormalVolume=${isAbnormalVolume}, ADX=${adx.toFixed(2)}`);
    }
  }

  if (alertText) {
    try {
      await sendTelegramMessage(alertText);
      logger.info(`Stochastic signal alert sent for ${symbol}: ${alertText}`);
    } catch (e) {
      logger.error(`Error sending stochastic alert for ${symbol}: ${e.message}`);
    }
  }
}

// ================= LÓGICA PRINCIPAL ================= //
async function checkCoins(monitorType) {
  try {
    const markets = await withRetry(() => exchangeFutures.loadMarkets());
    if (!markets || Object.keys(markets).length === 0) {
      logger.error('No markets loaded by loadMarkets()');
      return;
    }
    const usdtPairs = monitorType === 'stochastic' 
      ? config.PARES_MONITORADOS 
      : Object.keys(markets)
          .filter(symbol => {
            const isUSDT = symbol.endsWith('USDT') || symbol.endsWith(':USDT');
            const isActive = markets[symbol].active;
            const isFuture = markets[symbol].future || (markets[symbol].info && markets[symbol].info.contractType === 'PERPETUAL');
            return isUSDT && isActive && isFuture;
          })
          .slice(0, 100);
    
    logger.info(`Processing ${usdtPairs.length} USDT pairs for ${monitorType} monitor`);

    const coinsData = await limitConcurrency(usdtPairs, async (symbol) => {
      try {
        const ticker = await withRetry(() => exchangeFutures.fetchTicker(symbol));
        const price = ticker?.last || null;
        const volume = ticker?.baseVolume * price || 0;
        if (!price) {
          logger.warn(`Invalid price for ${symbol}, skipping...`);
          return null;
        }

        const cacheKeyPrefix = `ohlcv_${symbol}`;
        const requiredCandles = Math.max(config.RSI_PERIOD, config.ATR_PERIOD, config.ADX_PERIOD + 14, config.EMA_SLOW_PERIOD, config.STOCHASTIC_PERIOD_K + config.STOCHASTIC_SMOOTH_K + config.STOCHASTIC_PERIOD_D, 50);
        
        const ohlcv15mRaw = getCachedData(`${cacheKeyPrefix}_15m`) || 
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '15m', undefined, requiredCandles + 1));
        const ohlcv1hRaw = getCachedData(`${cacheKeyPrefix}_1h`) || 
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '1h', undefined, config.RSI_PERIOD + 1));
        const ohlcv4hRaw = getCachedData(`${cacheKeyPrefix}_4h`) || 
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '4h', undefined, requiredCandles));
        const ohlcv1dRaw = getCachedData(`${cacheKeyPrefix}_1d`) || 
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '1d', undefined, 20));
        const ohlcv3mRaw = getCachedData(`${cacheKeyPrefix}_3m`) || 
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '3m', undefined, 90));
        const ohlcv50Raw = getCachedData(`${cacheKeyPrefix}_50`) || 
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '15m', undefined, 50));

        setCachedData(`${cacheKeyPrefix}_15m`, ohlcv15mRaw);
        setCachedData(`${cacheKeyPrefix}_1h`, ohlcv1hRaw);
        setCachedData(`${cacheKeyPrefix}_4h`, ohlcv4hRaw);
        setCachedData(`${cacheKeyPrefix}_1d`, ohlcv1dRaw);
        setCachedData(`${cacheKeyPrefix}_3m`, ohlcv3mRaw);
        setCachedData(`${cacheKeyPrefix}_50`, ohlcv50Raw);

        const ohlcv15m = normalizeOHLCV(ohlcv15mRaw, symbol);
        const ohlcv1h = normalizeOHLCV(ohlcv1hRaw, symbol);
        const ohlcv4h = normalizeOHLCV(ohlcv4hRaw, symbol);
        const ohlcv1d = normalizeOHLCV(ohlcv1dRaw, symbol);
        const ohlcv3m = normalizeOHLCV(ohlcv3mRaw, symbol);
        const ohlcv50 = normalizeOHLCV(ohlcv50Raw, symbol);

        if (ohlcv15m.length < requiredCandles || ohlcv1h.length < config.RSI_PERIOD + 1 || 
            ohlcv4h.length < requiredCandles || ohlcv1d.length < 8 || ohlcv3m.length < 90 || ohlcv50.length < 50) {
          logger.warn(`Insufficient OHLCV data for ${symbol}: 15m=${ohlcv15m.length}, 1h=${ohlcv1h.length}, 4h=${ohlcv4h.length}, 1d=${ohlcv1d.length}, 3m=${ohlcv3m.length}, 50=${ohlcv50.length}, skipping...`);
          return null;
        }

        const rsi = calculateRSI(ohlcv15m, symbol);
        const rsi1h = calculateRSI(ohlcv1h, symbol);
        const rsi4h = calculateRSI(ohlcv4h, symbol);
        const atr = calculateATR(ohlcv15m, symbol);
        const atrPercent = atr && price ? parseFloat((atr / price * 100).toFixed(2)) : null;
        const adx = calculateADX(ohlcv15m, symbol);
        const lsr = (await fetchLSR(symbol)).value;
        const funding = await fetchFundingRate(symbol);
        const delta = await calculateAggressiveDelta(symbol);
        const oi5m = await fetchOpenInterest(symbol, '5m');
        const oi15m = await fetchOpenInterest(symbol, '15m');
        const stoch4h = calculateStochastic(ohlcv4h, symbol);
        const stoch1d = calculateStochastic(ohlcv1d, symbol);
        const supportResistance = calculateSupportResistance(ohlcv50, symbol);
        const emaFast = calculateEMA(ohlcv15m, config.EMA_FAST_PERIOD, symbol);
        const emaSlow = calculateEMA(ohlcv15m, config.EMA_SLOW_PERIOD, symbol);
        const ema34_3m = calculateEMA(ohlcv3m, config.EMA_STOCH_34_PERIOD, symbol);
        const ema89_3m = calculateEMA(ohlcv3m, config.EMA_STOCH_89_PERIOD, symbol);
        const emaCrossover = detectEMACrossover(symbol, emaFast, emaSlow);
        

        updateRsiPeaks(symbol, rsi);
        const volumeSpike = await detectVolumeSpike(symbol);
        const fundingAnomaly = await detectFundingRateChange(symbol, funding.current);

        logger.info(`Processed ${symbol}: RSI=${rsi}, RSI1h=${rsi1h}, RSI4h=${rsi4h}, ATR=${atr}, ATR%=${atrPercent}, ADX=${adx}, Stoch4h K=${stoch4h.k}, D=${stoch4h.d}, Stoch1d K=${stoch1d.k}, D=${stoch1d.d}, LSR=${lsr}, Funding=${funding.current}, Delta=${delta.deltaPercent}, OI5m=${oi5m.percentChange}, OI15m=${oi15m.percentChange}, VolumeSpike=${volumeSpike}, FundingAnomaly=${fundingAnomaly}`);
        
        if (monitorType === 'rsi_ema') {
          return {
            symbol,
            price,
            volume,
            rsi,
            rsi1h,
            rsi4h,
            atr,
            atrPercent,
            adx,
            lsr,
            funding,
            delta,
            oi5m,
            oi15m,
            stoch4h,
            stoch1d,
            supportResistance,
            emaCrossover,
            volumeSpike,
            fundingAnomaly
          };
        } else if (monitorType === 'stochastic') {
          await sendAlertStochasticCross(symbol, {
            ohlcv15m,
            ohlcv4h,
            ohlcv1h,
            ohlcvDiario: ohlcv1d,
            ohlcv3m,
            price,
            rsi1h,
            lsr,
            fundingRate: funding,
            aggressiveDelta: delta,
            estocastico4h: stoch4h,
            estocasticoD: stoch1d,
            oi5m,
            oi15m,
            atr,
            ema34_3m,
            ema89_3m,
            adx
          });
          return null; // Não retorna dados para o monitor estocástico, pois os alertas são enviados diretamente
        }
      } catch (e) {
        logger.error(`Erro ao processar ${symbol} no monitor ${monitorType}: ${e.message}`);
        return null;
      }
    }, 5);

    if (monitorType === 'rsi_ema') {
      const validCoins = coinsData.filter(c => c !== null);
      if (validCoins.length > 0) {
        await sendMonitorAlert(validCoins);
      } else {
        logger.info('Nenhum dado válido de moedas para alerta RSI/EMA');
      }
    }
  } catch (e) {
    logger.error(`Erro ao verificar moedas para ${monitorType}: ${e.message}`);
  }
}

async function main() {
  logger.info('Iniciando Combined Trading Bot');
  try {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, '🤖 Stoch & RSI/EMA ...'));
    
    // Iniciar monitoramento RSI/EMA
    await checkCoins('rsi_ema');
    setInterval(() => checkCoins('rsi_ema'), config.INTERVALO_ALERTA_RSI_MS);
    
    // Iniciar monitoramento Estocástico
    await checkCoins('stochastic');
    setInterval(() => checkCoins('stochastic'), config.INTERVALO_ALERTA_STOCH_MS);
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));