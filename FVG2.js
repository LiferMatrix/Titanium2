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
  INTERVALO_ALERTA_4H_MS: 15 * 60 * 1000, // 15 minutos
  TEMPO_COOLDOWN_MS: 30 * 60 * 1000, // 30 minutos
  RSI_PERIOD: 14,
  FGV_BUY_MIN: 1.5, // Limite mínimo de FGV para compra (15m, %)
  FGV_SELL_MAX: -1.5, // Limite máximo de FGV para venda (15m, %)
  DELTA_BUY_MIN: 10, // Limite mínimo de Delta Agressivo para compra (%)
  DELTA_SELL_MAX: -10, // Limite máximo de Delta Agressivo para venda (%)
  CACHE_TTL: 10 * 60 * 1000, // 10 minutos
  MAX_CACHE_SIZE: 100,
  MAX_HISTORICO_ALERTAS: 10,
  VOLATILITY_MIN: 0.005, // Volatilidade mínima (ATR/preço ≥ 0.5%)
  VOLUME_ANOMALY_THRESHOLD: 2.0, // Volume atual deve ser >= 2x a média
  VOLUME_LOOKBACK_PERIOD: 20, // Período de lookback para calcular média do volume
};

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'simple_trading_bot.log' }),
    new winston.transports.Console()
  ]
});

// Estado global
const state = {
  ultimoAlertaPorAtivo: {},
  ultimoFGV: {},
  dataCache: new Map()
};

// Validação de variáveis de ambiente
function validateEnv() {
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'COINS'];
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
        logger.warn(`Falha após ${retries} tentativas: ${e.message}`);
        throw e;
      }
      const delay = Math.pow(2, attempt - 1) * delayBase;
      logger.info(`Tentativa ${attempt} falhou, retry após ${delay}ms: ${e.message}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function getCachedData(key) {
  const cacheEntry = state.dataCache.get(key);
  if (cacheEntry && Date.now() - cacheEntry.timestamp < config.CACHE_TTL) {
    logger.info(`Usando cache para ${key}`);
    return cacheEntry.data;
  }
  state.dataCache.delete(key);
  return null;
}

function setCachedData(key, data) {
  if (state.dataCache.size >= config.MAX_CACHE_SIZE) {
    const oldestKey = state.dataCache.keys().next().value;
    state.dataCache.delete(oldestKey);
    logger.info(`Cache cheio, removido item mais antigo: ${oldestKey}`);
  }
  state.dataCache.set(key, { timestamp: Date.now(), data });
  setTimeout(() => {
    if (state.dataCache.has(key) && Date.now() - state.dataCache.get(key).timestamp >= config.CACHE_TTL) {
      state.dataCache.delete(key);
      logger.info(`Cache limpo para ${key}`);
    }
  }, config.CACHE_TTL + 1000);
}

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
function normalizeOHLCV(data) {
  return data.map(c => ({
    time: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  })).filter(c => !isNaN(c.close) && !isNaN(c.volume));
}

function calculateRSI(data) {
  if (!data || data.length < config.RSI_PERIOD + 1) return [];
  const rsi = TechnicalIndicators.RSI.calculate({
    period: config.RSI_PERIOD,
    values: data.map(d => d.close || d[4])
  });
  return rsi.filter(v => !isNaN(v));
}

function calculateFGV(data) {
  if (!data || data.length < 11) return null;
  const closes = data.map(c => c.close || c[4]).filter(cl => !isNaN(cl));
  if (closes.length < 11) return null;
  const currentClose = closes[closes.length - 1];
  const pastClose = closes[closes.length - 11]; // 10 candles atrás
  const fgvPercent = ((currentClose - pastClose) / pastClose * 100).toFixed(2);
  return parseFloat(fgvPercent);
}

function calculateATR(data) {
  const atr = TechnicalIndicators.ATR.calculate({
    period: 14,
    high: data.map(c => c.high || c[2]),
    low: data.map(c => c.low || c[3]),
    close: data.map(c => c.close || c[4])
  });
  return atr.filter(v => !isNaN(v));
}

function calculateEMA(data, period) {
  if (!data || data.length < period) return [];
  const ema = TechnicalIndicators.EMA.calculate({
    period,
    values: data.map(d => d.close || d[4])
  });
  return ema.filter(v => !isNaN(v));
}

function calculateVolatility(data, price) {
  const atrValues = calculateATR(data);
  if (!atrValues.length || !price) return 0;
  const atr = atrValues[atrValues.length - 1];
  return (atr / price) || 0;
}

function calculateAbnormalVolume(ohlcv, lookbackPeriod, threshold) {
  if (!ohlcv || ohlcv.length < lookbackPeriod + 1) return { isAbnormal: false, volumeRatio: 0 };
  
  const volumes = ohlcv.slice(-lookbackPeriod - 1, -1).map(c => c.volume || c[5]).filter(v => !isNaN(v));
  if (volumes.length < lookbackPeriod) return { isAbnormal: false, volumeRatio: 0 };
  
  const currentVolume = ohlcv[ohlcv.length - 1].volume || ohlcv[ohlcv.length - 1][5];
  if (isNaN(currentVolume)) return { isAbnormal: false, volumeRatio: 0 };
  
  const avgVolume = volumes.reduce((sum, vol) => sum + vol, 0) / volumes.length;
  const volumeRatio = avgVolume !== 0 ? currentVolume / avgVolume : 0;
  
  return {
    isAbnormal: volumeRatio >= threshold,
    volumeRatio: volumeRatio.toFixed(2)
  };
}

function detectarQuebraEstrutura(ohlcv) {
  if (!ohlcv || ohlcv.length < 2) return { estruturaAlta: 0, estruturaBaixa: 0, buyLiquidityZones: [], sellLiquidityZones: [] };
  const lookbackPeriod = 20;
  const previousCandles = ohlcv.slice(0, -1).slice(-lookbackPeriod);
  const highs = previousCandles.map(c => c.high || c[2]).filter(h => !isNaN(h));
  const lows = previousCandles.map(c => c.low || c[3]).filter(l => !isNaN(l));
  const volumes = previousCandles.map(c => c.volume || c[5]).filter(v => !isNaN(v));
  if (highs.length === 0 || lows.length === 0 || volumes.length === 0) {
    return { estruturaAlta: 0, estruturaBaixa: 0, buyLiquidityZones: [], sellLiquidityZones: [] };
  }
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const volumeThreshold = Math.max(...volumes) * 0.7;
  const buyLiquidityZones = [];
  const sellLiquidityZones = [];
  previousCandles.forEach(candle => {
    const high = candle.high || candle[2];
    const low = candle.low || candle[3];
    const volume = candle.volume || candle[5];
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

function calculateVolumeProfile(ohlcv, priceStepPercent = 0.1) {
  if (!ohlcv || ohlcv.length < 2) return { buyLiquidityZones: [], sellLiquidityZones: [] };
  const priceRange = Math.max(...ohlcv.map(c => c.high || c[2])) - Math.min(...ohlcv.map(c => c.low || c[3]));
  const step = priceRange * priceStepPercent / 100;
  const volumeProfile = {};
  ohlcv.forEach(candle => {
    const price = ((candle.high || candle[2]) + (candle.low || candle[3])) / 2;
    if (isNaN(price) || isNaN(candle.volume || candle[5])) return;
    const bucket = Math.floor(price / step) * step;
    volumeProfile[bucket] = (volumeProfile[bucket] || 0) + (candle.volume || candle[5]);
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
    logger.error(`Erro ao buscar zonas de liquidez para ${symbol}: ${e.message}`);
    return getCachedData(cacheKey) || { buyLiquidityZones: [], sellLiquidityZones: [] };
  }
}

async function fetchLSR(symbol) {
  const cacheKey = `lsr_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const res = await withRetry(() => axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', {
      params: { symbol: symbol.replace('/', ''), period: '15m', limit: 2 }
    }));
    if (!res.data || res.data.length < 2) {
      logger.warn(`Dados insuficientes de LSR para ${symbol}: ${res.data?.length || 0} registros`);
      return getCachedData(cacheKey) || { value: null, isRising: false, percentChange: '0.00' };
    }
    const currentLSR = parseFloat(res.data[0].longShortRatio);
    const previousLSR = parseFloat(res.data[1].longShortRatio);
    const percentChange = previousLSR !== 0 ? ((currentLSR - previousLSR) / previousLSR * 100).toFixed(2) : '0.00';
    const result = { value: currentLSR, isRising: currentLSR > previousLSR, percentChange };
    setCachedData(cacheKey, result);
    return result;
  } catch (e) {
    logger.warn(`Erro ao buscar LSR para ${symbol}: ${e.message}`);
    return getCachedData(cacheKey) || { value: null, isRising: false, percentChange: '0.00' };
  }
}

async function fetchOpenInterest(symbol, timeframe, retries = 5) {
  const cacheKey = `oi_${symbol}_${timeframe}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const oiData = await withRetry(() => exchangeFutures.fetchOpenInterestHistory(symbol, timeframe, undefined, 30));
    if (!oiData || oiData.length < 3) {
      logger.warn(`Dados insuficientes de Open Interest para ${symbol} no timeframe ${timeframe}: ${oiData?.length || 0} registros`);
      if (retries > 0) {
        const delay = Math.pow(2, 5 - retries) * 1000;
        logger.info(`Tentando novamente para ${symbol} no timeframe ${timeframe}, tentativas restantes: ${retries}, delay: ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return await fetchOpenInterest(symbol, timeframe, retries - 1);
      }
      if (timeframe === '15m' || timeframe === '5m') {
        logger.info(`Fallback para timeframe 30m para ${symbol}`);
        return await fetchOpenInterest(symbol, '30m', 3);
      }
      return { isRising: false, percentChange: '0.00' };
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
      logger.warn(`Registros válidos insuficientes para ${symbol} no timeframe ${timeframe}: ${validOiData.length} registros válidos`);
      if (retries > 0) {
        const delay = Math.pow(2, 5 - retries) * 1000;
        logger.info(`Tentando novamente para ${symbol} no timeframe ${timeframe}, tentativas restantes: ${retries}, delay: ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return await fetchOpenInterest(symbol, timeframe, retries - 1);
      }
      if (timeframe === '15m' || timeframe === '5m') {
        logger.info(`Fallback para timeframe 30m para ${symbol}`);
        return await fetchOpenInterest(symbol, '30m', 3);
      }
      return { isRising: false, percentChange: '0.00' };
    }
    const oiValues = validOiData.map(d => d.openInterest).filter(v => v !== undefined);
    const sortedOi = [...oiValues].sort((a, b) => a - b);
    const median = sortedOi[Math.floor(sortedOi.length / 2)];
    const filteredOiData = validOiData.filter(d => d.openInterest >= median * 0.5 && d.openInterest <= median * 1.5);
    if (filteredOiData.length < 3) {
      logger.warn(`Registros válidos após filtro de outliers insuficientes para ${symbol} no timeframe ${timeframe}: ${filteredOiData.length}`);
      if (retries > 0) {
        const delay = Math.pow(2, 5 - retries) * 1000;
        logger.info(`Tentando novamente para ${symbol} no timeframe ${timeframe}, tentativas restantes: ${retries}, delay: ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return await fetchOpenInterest(symbol, timeframe, retries - 1);
      }
      if (timeframe === '15m' || timeframe === '5m') {
        logger.info(`Fallback para timeframe 30m para ${symbol}`);
        return await fetchOpenInterest(symbol, '30m', 3);
      }
      return { isRising: false, percentChange: '0.00' };
    }
    const recentOi = filteredOiData.slice(0, 3).map(d => d.openInterest);
    const sma = recentOi.reduce((sum, val) => sum + val, 0) / recentOi.length;
    const previousRecentOi = filteredOiData.slice(3, 6).map(d => d.openInterest);
    const previousSma = previousRecentOi.length >= 3 ? previousRecentOi.reduce((sum, val) => sum + val, 0) / previousRecentOi.length : recentOi[recentOi.length - 1];
    const oiPercentChange = previousSma !== 0 ? ((sma - previousSma) / previousSma * 100).toFixed(2) : '0.00';
    const result = {
      isRising: sma > previousSma,
      percentChange: oiPercentChange
    };
    setCachedData(cacheKey, result);
    logger.info(`Open Interest calculado para ${symbol} no timeframe ${timeframe}: sma=${sma}, previousSma=${previousSma}, percentChange=${oiPercentChange}%`);
    return result;
  } catch (e) {
    if (e.message.includes('binance does not have market symbol') || e.message.includes('Invalid symbol')) {
      logger.error(`Símbolo ${symbol} não suportado para Open Interest no timeframe ${timeframe}. Ignorando.`);
      return { isRising: false, percentChange: '0.00' };
    }
    logger.warn(`Erro ao buscar Open Interest para ${symbol} no timeframe ${timeframe}: ${e.message}`);
    return getCachedData(cacheKey) || { isRising: false, percentChange: '0.00' };
  }
}

async function fetchFundingRate(symbol) {
  const cacheKey = `funding_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const fundingData = await withRetry(() => exchangeFutures.fetchFundingRateHistory(symbol, undefined, 2));
    if (fundingData && fundingData.length >= 2) {
      const currentFunding = parseFloat(fundingData[fundingData.length - 1].fundingRate);
      const previousFunding = parseFloat(fundingData[fundingData.length - 2].fundingRate);
      const percentChange = previousFunding !== 0 ? ((currentFunding - previousFunding) / Math.abs(previousFunding) * 100).toFixed(2) : '0.00';
      const result = { current: currentFunding, isRising: currentFunding > previousFunding, percentChange };
      setCachedData(cacheKey, result);
      return result;
    }
    return getCachedData(cacheKey) || { current: null, isRising: false, percentChange: '0.00' };
  } catch (e) {
    logger.warn(`Erro ao buscar Funding Rate para ${symbol}: ${e.message}`);
    return getCachedData(cacheKey) || { current: null, isRising: false, percentChange: '0.00' };
  }
}

async function calculateAggressiveDelta(symbol, timeframe = '15m', limit = 100) {
  const cacheKey = `delta_${symbol}_${timeframe}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const trades = await withRetry(() => exchangeSpot.fetchTrades(symbol, undefined, limit));
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
    const deltaPercent = totalVolume !== 0 ? (delta / totalVolume * 100).toFixed(2) : '0.00';
    const result = {
      delta,
      deltaPercent: parseFloat(deltaPercent),
      isBuyPressure: delta > 0,
      isSignificant: Math.abs(deltaPercent) > 10
    };
    setCachedData(cacheKey, result);
    logger.info(`Delta Agressivo para ${symbol}: Buy=${buyVolume}, Sell=${sellVolume}, Delta=${delta}, Delta%=${deltaPercent}%`);
    return result;
  } catch (e) {
    logger.error(`Erro ao calcular Delta Agressivo para ${symbol}: ${e.message}`);
    return getCachedData(cacheKey) || { delta: 0, deltaPercent: 0, isBuyPressure: false, isSignificant: false };
  }
}

// ================= FUNÇÕES DE ALERTAS ================= //
function getFGVEmoji(value) {
  if (!value) return "";
  return value >= 3 ? "🔥" : value >= 1.5 ? "🟢" : value <= -3 ? "💥" : value <= -1.5 ? "🔴" : "🟡";
}

function getSetaDirecao(current, previous) {
  if (!current || !previous) return "➡️";
  return current > previous ? "⬆️" : current < previous ? "⬇️" : "➡️";
}

async function sendAlertFGV(symbol, data) {
  const { ohlcv15m, ohlcv4h, ohlcv1h, ohlcvDiario, ohlcv3m, price, rsi1h, lsr, fundingRate, aggressiveDelta, fgv15m, oi5m, oi15m, atr, ema8_3m, ema21_3m } = data;
  const agora = Date.now();
  if (!state.ultimoAlertaPorAtivo[symbol]) state.ultimoAlertaPorAtivo[symbol] = { historico: [] };
  if (state.ultimoAlertaPorAtivo[symbol]['4h'] && agora - state.ultimoAlertaPorAtivo[symbol]['4h'] < config.TEMPO_COOLDOWN_MS) return;

  const precision = price < 1 ? 8 : price < 10 ? 6 : price < 100 ? 4 : 2;
  const format = v => isNaN(v) ? 'N/A' : v.toFixed(precision);
  const zonas = detectarQuebraEstrutura(ohlcv15m);
  const volumeProfile = calculateVolumeProfile(ohlcv15m);
  const orderBookLiquidity = await fetchLiquidityZones(symbol);
  const abnormalVolume = calculateAbnormalVolume(ohlcv3m, config.VOLUME_LOOKBACK_PERIOD, config.VOLUME_ANOMALY_THRESHOLD);

  const isNearBuyZone = zonas.buyLiquidityZones.some(zone => Math.abs(price - zone) <= atr * 0.01);
  const isNearSellZone = zonas.sellLiquidityZones.some(zone => Math.abs(price - zone) <= atr * 0.01);

  const volatility = calculateVolatility(ohlcv15m, price);
  if (volatility < config.VOLATILITY_MIN) {
    logger.info(`Volatilidade insuficiente para ${symbol}: ${volatility.toFixed(4)} < ${config.VOLATILITY_MIN}`);
    return;
  }

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
    ? `${fundingRateEmoji} ${(fundingRate.current * 100).toFixed(5)}%  ${fundingRate.isRising ? '⬆️' : '⬇️'}`
    : '🔹 Indisp.';
  const deltaText = aggressiveDelta.isSignificant 
    ? `${aggressiveDelta.isBuyPressure ? '💹F.Comprador' : '⭕F.Vendedor'} ${aggressiveDelta.deltaPercent > 60 && lsr.value !== null && lsr.value < 1 ? '💥' : ''}(${aggressiveDelta.deltaPercent}%)`
    : '🔘Neutro';
  const oi5mText = oi5m ? `${oi5m.isRising ? '📈' : '📉'} OI 5m: ${oi5m.percentChange}%` : '🔹 Indisp.';
  const oi15mText = oi15m ? `${oi15m.isRising ? '📈' : '📉'} OI 15m: ${oi15m.percentChange}%` : '🔹 Indisp.';
  const emaText = ema8_3m && ema21_3m ? `${ema8_3m > ema21_3m ? '🟢 EMA 8 > 21 (3m)' : '🔴 EMA 8 < 21 (3m)'}` : '🔹 EMA Indisp.';
  const volumeText = abnormalVolume.isAbnormal ? `📊 Vol. 3m: ${abnormalVolume.volumeRatio}x` : '🔘 Vol. Normal';

  if (!state.ultimoFGV[symbol]) state.ultimoFGV[symbol] = {};
  const fgvAnterior15m = state.ultimoFGV[symbol].fgv15m || fgv15m || 0;
  state.ultimoFGV[symbol].fgv15m = fgv15m;
  const direcaoFGV = getSetaDirecao(fgv15m, fgvAnterior15m);
  const fgvEmoji = fgv15m ? getFGVEmoji(fgv15m) : "";

  const buyZonesText = zonas.buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const sellZonesText = zonas.sellLiquidityZones.map(format).join(' / ') || 'N/A';
  const vpBuyZonesText = volumeProfile.buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const vpSellZonesText = volumeProfile.sellLiquidityZones.map(format).join(' / ') || 'N/A';
  const obBuyZonesText = orderBookLiquidity.buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const obSellZonesText = orderBookLiquidity.sellLiquidityZones.map(format).join(' / ') || 'N/A';

  const entryLow = format(price - 0.3 * atr);
  const entryHigh = format(price + 0.5 * atr);
  const targetsBuy = [1.5, 3, 4.5, 6].map(mult => format(price + mult * atr)).join(" / ");
  const targetsSell = [1.5, 3, 4.5, 6].map(mult => format(price - mult * atr)).join(" / ");
  const stopBuy = format(price - 3.5 * atr);
  const stopSell = format(price + 3.5 * atr);

  let alertText = '';
  // Condições para compra: FGV 15m ≥ 1.5%, RSI 1h < 60, OI 5m e 15m subindo, Delta ≥ 10%, EMA 8 > EMA 21 (3m), Volatilidade ≥ 0.5%, Volume Anormal
  const isBuySignal = fgv15m >= config.FGV_BUY_MIN &&
                      rsi1h < 60 && 
                      oi5m.isRising &&
                      oi15m.isRising && 
                      aggressiveDelta.deltaPercent >= config.DELTA_BUY_MIN &&
                      ema8_3m > ema21_3m &&
                      volatility >= config.VOLATILITY_MIN &&
                      abnormalVolume.isAbnormal;
  
  // Condições para venda: FGV 15m ≤ -1.5%, RSI 1h > 68, OI 5m e 15m caindo, Delta ≤ -10%, EMA 8 < EMA 21 (3m), Volatilidade ≥ 0.5%, Volume Anormal
  const isSellSignal = fgv15m <= config.FGV_SELL_MAX &&
                       rsi1h > 68 && 
                       !oi5m.isRising &&
                       !oi15m.isRising && 
                       aggressiveDelta.deltaPercent <= config.DELTA_SELL_MAX &&
                       ema8_3m < ema21_3m &&
                       volatility >= config.VOLATILITY_MIN &&
                       abnormalVolume.isAbnormal;

  if (isBuySignal) {
    const foiAlertado = state.ultimoAlertaPorAtivo[symbol].historico.some(r => 
      r.direcao === 'buy' && (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = `💠*FGV 15m - 📊Bull Detectado *\n\n` +
                  `🔹 Ativo: <<*${symbol}*>> [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço: ${format(price)}\n` +
                  `🔹 RSI 1h: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 FGV 15m: ${fgv15m ? fgv15m.toFixed(2) : '--'}% ${fgvEmoji} ${direcaoFGV}\n` +
                  `🔹 ${oi5mText}\n` +
                  `🔹 ${oi15mText}\n` +
                  `🔹 ${emaText}\n` +
                  `🔹 ${volumeText}\n` +
                  `   Romp. de Baixa: ${format(zonas.estruturaBaixa)}\n` +
                  `   Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
                  `   Poc Bull: ${vpBuyZonesText}\n` +
                  `   Poc Bear: ${vpSellZonesText}\n` +
                  ` ☑︎ Monitor -🤖 @J4Rviz\n`;
      state.ultimoAlertaPorAtivo[symbol]['4h'] = agora;
      state.ultimoAlertaPorAtivo[symbol].historico.push({ direcao: 'buy', timestamp: agora });
      state.ultimoAlertaPorAtivo[symbol].historico = state.ultimoAlertaPorAtivo[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.info(`Sinal de compra detectado para ${symbol}: Preço=${format(price)}, FGV 15m=${fgv15m}%, RSI 1h=${rsi1h.toFixed(2)}, OI 5m=${oi5m.percentChange}%, OI 15m=${oi15m.percentChange}%, LSR=${lsr.value ? lsr.value.toFixed(2) : 'N/A'}, Delta=${aggressiveDelta.deltaPercent}%, NearBuyZone=${isNearBuyZone}, EMA8_3m=${ema8_3m}, EMA21_3m=${ema21_3m}, Volatility=${volatility.toFixed(4)}, VolumeRatio=${abnormalVolume.volumeRatio}x`);
    }
  } else if (isSellSignal) {
    const foiAlertado = state.ultimoAlertaPorAtivo[symbol].historico.some(r => 
      r.direcao === 'sell' && (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = `🔻*FGV 15m - 📊Bear Detectado*\n\n` +
                  `🔹 Ativo: <<*${symbol}*>> [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço: ${format(price)}\n` +
                  `🔹 RSI 1h: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 FGV 15m: ${fgv15m ? fgv15m.toFixed(2) : '--'}% ${fgvEmoji} ${direcaoFGV}\n` +
                  `🔹 ${oi5mText}\n` +
                  `🔹 ${oi15mText}\n` +
                  `🔹 ${emaText}\n` +
                  `🔹 ${volumeText}\n` +
                  `   Romp. de Baixa: ${format(zonas.estruturaBaixa)}\n` +
                  `   Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
                  `   Poc Bull: ${vpBuyZonesText}\n` +
                  `   Poc Bear: ${vpSellZonesText}\n` +
                  ` ☑︎ Monitor -🤖 @J4Rviz\n`;
      state.ultimoAlertaPorAtivo[symbol]['4h'] = agora;
      state.ultimoAlertaPorAtivo[symbol].historico.push({ direcao: 'sell', timestamp: agora });
      state.ultimoAlertaPorAtivo[symbol].historico = state.ultimoAlertaPorAtivo[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.info(`Sinal de venda detectado para ${symbol}: Preço=${format(price)}, FGV 15m=${fgv15m}%, RSI 1h=${rsi1h.toFixed(2)}, OI 5m=${oi5m.percentChange}%, OI 15m=${oi15m.percentChange}%, LSR=${lsr.value ? lsr.value.toFixed(2) : 'N/A'}, Delta=${aggressiveDelta.deltaPercent}%, NearSellZone=${isNearSellZone}, EMA8_3m=${ema8_3m}, EMA21_3m=${ema21_3m}, Volatility=${volatility.toFixed(4)}, VolumeRatio=${abnormalVolume.volumeRatio}x`);
    }
  }

  if (alertText) {
    try {
      await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, alertText, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }));
      logger.info(`Alerta de sinal FGV enviado para ${symbol}: ${alertText}`);
    } catch (e) {
      logger.error(`Erro ao enviar alerta para ${symbol}: ${e.message}`);
    }
  }
}

async function checkConditions() {
  try {
    await limitConcurrency(config.PARES_MONITORADOS, async (symbol) => {
      const cacheKeyPrefix = `ohlcv_${symbol}`;
      const ohlcv15mRaw = getCachedData(`${cacheKeyPrefix}_15m`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '15m', undefined, 50));
      const ohlcv4hRaw = getCachedData(`${cacheKeyPrefix}_4h`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '4h', undefined, 20));
      const ohlcv1hRaw = getCachedData(`${cacheKeyPrefix}_1h`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '1h', undefined, config.RSI_PERIOD + 1));
      const ohlcvDiarioRaw = getCachedData(`${cacheKeyPrefix}_1d`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '1d', undefined, 20));
      const ohlcv3mRaw = getCachedData(`${cacheKeyPrefix}_3m`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '3m', undefined, config.VOLUME_LOOKBACK_PERIOD + 1));
      setCachedData(`${cacheKeyPrefix}_15m`, ohlcv15mRaw);
      setCachedData(`${cacheKeyPrefix}_4h`, ohlcv4hRaw);
      setCachedData(`${cacheKeyPrefix}_1h`, ohlcv1hRaw);
      setCachedData(`${cacheKeyPrefix}_1d`, ohlcvDiarioRaw);
      setCachedData(`${cacheKeyPrefix}_3m`, ohlcv3mRaw);

      if (!ohlcv15mRaw || !ohlcv4hRaw || !ohlcv1hRaw || !ohlcvDiarioRaw || !ohlcv3mRaw) {
        logger.warn(`Dados OHLCV insuficientes para ${symbol}, pulando...`);
        return;
      }

      const ohlcv15m = normalizeOHLCV(ohlcv15mRaw);
      const ohlcv4h = normalizeOHLCV(ohlcv4hRaw);
      const ohlcv1h = normalizeOHLCV(ohlcv1hRaw);
      const ohlcvDiario = normalizeOHLCV(ohlcvDiarioRaw);
      const ohlcv3m = normalizeOHLCV(ohlcv3mRaw);
      const closes15m = ohlcv15m.map(c => c.close).filter(c => !isNaN(c));
      const currentPrice = closes15m[closes15m.length - 1];

      if (isNaN(currentPrice)) {
        logger.warn(`Preço atual inválido para ${symbol}, pulando...`);
        return;
      }

      const rsi1hValues = calculateRSI(ohlcv1h);
      const fgv15m = calculateFGV(ohlcv15m);
      const oi5m = await fetchOpenInterest(symbol, '5m');
      const oi15m = await fetchOpenInterest(symbol, '15m');
      const lsr = await fetchLSR(symbol);
      const fundingRate = await fetchFundingRate(symbol);
      const aggressiveDelta = await calculateAggressiveDelta(symbol);
      const atrValues = calculateATR(ohlcv15m);
      const ema8_3mValues = calculateEMA(ohlcv3m, 8);
      const ema21_3mValues = calculateEMA(ohlcv3m, 21);

      if (!rsi1hValues.length || fgv15m === null || !atrValues.length || !ema8_3mValues.length || !ema21_3mValues.length) {
        logger.warn(`Indicadores insuficientes para ${symbol}, pulando...`);
        return;
      }

      await sendAlertFGV(symbol, {
        ohlcv15m,
        ohlcv4h,
        ohlcv1h,
        ohlcvDiario,
        ohlcv3m,
        price: currentPrice,
        rsi1h: rsi1hValues[rsi1hValues.length - 1],
        lsr,
        fundingRate,
        aggressiveDelta,
        fgv15m,
        oi5m,
        oi15m,
        atr: atrValues[atrValues.length - 1],
        ema8_3m: ema8_3mValues[ema8_3mValues.length - 1],
        ema21_3m: ema21_3mValues[ema21_3mValues.length - 1]
      });
    }, 5);
  } catch (e) {
    logger.error(`Erro ao processar condições: ${e.message}`);
  }
}

async function main() {
  logger.info('Iniciando simple trading bot');
  try {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, '🤖 Titanium FGV  💹Start...'));
    await checkConditions();
    setInterval(checkConditions, config.INTERVALO_ALERTA_4H_MS);
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));