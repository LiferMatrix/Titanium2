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
  INTERVALO_ALERTA_15M_MS: 5 * 60 * 1000, // 5 minutos
  TEMPO_COOLDOWN_MS: 30 * 60 * 1000, // 30 minutos
  RSI_PERIOD: 14,
  CACHE_TTL: 10 * 60 * 1000, // 10 minutos
  MAX_CACHE_SIZE: 100,
  MAX_HISTORICO_ALERTAS: 10,
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
  if (!data || data.length < config.RSI_PERIOD + 1) {
    logger.warn(`Dados insuficientes para calcular RSI: ${data?.length} candles disponíveis, requer ${config.RSI_PERIOD + 1}`);
    return [];
  }
  const closes = data.map(d => d.close || d[4]).filter(c => !isNaN(c));
  logger.info(`Calculando RSI com ${closes.length} preços de fechamento: ${closes.slice(-5)}`);
  const rsi = TechnicalIndicators.RSI.calculate({
    period: config.RSI_PERIOD,
    values: closes
  });
  logger.info(`RSI calculado: ${rsi.length} valores - ${rsi.slice(-5)}`);
  return rsi.filter(v => !isNaN(v));
}

function detectRSIDivergence(ohlcv, rsiValues) {
  if (!ohlcv || !rsiValues || ohlcv.length < 5 || rsiValues.length < 3) {
    logger.warn(`Dados insuficientes para detectar divergência: OHLCV=${ohlcv?.length}, RSI=${rsiValues?.length}`);
    return { isBullish: false, isBearish: false };
  }

  // Função auxiliar para encontrar topos e fundos
  function findPeaksAndTroughs(data, isPrice = false) {
    const peaks = [];
    const troughs = [];
    for (let i = 1; i < data.length - 1; i++) {
      const value = isPrice ? (data[i].high || data[i][2]) : data[i];
      const prevValue = isPrice ? (data[i - 1].high || data[i - 1][2]) : data[i - 1];
      const nextValue = isPrice ? (data[i + 1].high || data[i + 1][2]) : data[i + 1];
      if (value > prevValue && value > nextValue) {
        peaks.push({ index: i, value });
      }
      const lowValue = isPrice ? (data[i].low || data[i][3]) : data[i];
      const prevLow = isPrice ? (data[i - 1].low || data[i - 1][3]) : data[i - 1];
      const nextLow = isPrice ? (data[i + 1].low || data[i + 1][3]) : data[i + 1];
      if (lowValue < prevLow && lowValue < nextLow) {
        troughs.push({ index: i, value: lowValue });
      }
    }
    logger.info(`Peaks e troughs encontrados: Peaks=${peaks.length}, Troughs=${troughs.length}`);
    return { peaks, troughs };
  }

  const priceData = ohlcv.slice(-10); // Últimos 10 candles para análise
  const rsiData = rsiValues.slice(-10); // Últimos 10 valores de RSI
  const pricePeaksTroughs = findPeaksAndTroughs(priceData, true);
  const rsiPeaksTroughs = findPeaksAndTroughs(rsiData, false);

  let isBullish = false;
  let isBearish = false;

  // Divergência de alta: Baixa mais baixa no preço, alta mais alta no RSI
  if (pricePeaksTroughs.troughs.length >= 2 && rsiPeaksTroughs.peaks.length >= 2) {
    const lastTrough = pricePeaksTroughs.troughs[pricePeaksTroughs.troughs.length - 1];
    const secondLastTrough = pricePeaksTroughs.troughs[pricePeaksTroughs.troughs.length - 2];
    const lastRsiPeak = rsiPeaksTroughs.peaks[rsiPeaksTroughs.peaks.length - 1];
    const secondLastRsiPeak = rsiPeaksTroughs.peaks[rsiPeaksTroughs.peaks.length - 2];

    if (
      lastTrough.value < secondLastTrough.value &&
      lastRsiPeak.value > secondLastRsiPeak.value &&
      Math.abs(lastTrough.index - lastRsiPeak.index) <= 2 &&
      lastRsiPeak.value < 40 // RSI em zona de sobrevenda ou próximo
    ) {
      isBullish = true;
      logger.info(`Divergência de alta detectada: Preço=${lastTrough.value} < ${secondLastTrough.value}, RSI=${lastRsiPeak.value} > ${secondLastRsiPeak.value}`);
    }
  }

  // Divergência de baixa: Alta mais alta no preço, baixa mais baixa no RSI
  if (pricePeaksTroughs.peaks.length >= 2 && rsiPeaksTroughs.troughs.length >= 2) {
    const lastPeak = pricePeaksTroughs.peaks[pricePeaksTroughs.peaks.length - 1];
    const secondLastPeak = pricePeaksTroughs.peaks[pricePeaksTroughs.peaks.length - 2];
    const lastRsiTrough = rsiPeaksTroughs.troughs[rsiPeaksTroughs.troughs.length - 1];
    const secondLastRsiTrough = rsiPeaksTroughs.troughs[rsiPeaksTroughs.troughs.length - 2];

    if (
      lastPeak.value > secondLastPeak.value &&
      lastRsiTrough.value < secondLastRsiTrough.value &&
      Math.abs(lastPeak.index - lastRsiTrough.index) <= 2 &&
      lastRsiTrough.value > 60 // RSI em zona de sobrecompra ou próximo
    ) {
      isBearish = true;
      logger.info(`Divergência de baixa detectada: Preço=${lastPeak.value} > ${secondLastPeak.value}, RSI=${lastRsiTrough.value} < ${secondLastRsiTrough.value}`);
    }
  }

  return { isBullish, isBearish };
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

function calculateVolatility(data, price) {
  const atrValues = calculateATR(data);
  if (!atrValues.length || !price) return 0;
  const atr = atrValues[atrValues.length - 1];
  return (atr / price) || 0;
}

function detectarQuebraEstrutura(ohlcv) {
  if (!ohlcv || ohlcv.length < 2) return { estruturaAlta: 0, estruturaBaixa: 0 };
  const lookbackPeriod = 20;
  const previousCandles = ohlcv.slice(0, -1).slice(-lookbackPeriod);
  const highs = previousCandles.map(c => c.high || c[2]).filter(h => !isNaN(h));
  const lows = previousCandles.map(c => c.low || c[3]).filter(l => !isNaN(l));
  if (highs.length === 0 || lows.length === 0) {
    return { estruturaAlta: 0, estruturaBaixa: 0 };
  }
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  return {
    estruturaAlta: maxHigh,
    estruturaBaixa: minLow
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

function detectAnomalousVolume(ohlcv, timeframe = '15m') {
  if (!ohlcv || ohlcv.length < 21) return false;
  const lookbackPeriod = 20;
  const previousCandles = ohlcv.slice(0, -1).slice(-lookbackPeriod);
  const volumes = previousCandles.map(c => c.volume || c[5]).filter(v => !isNaN(v));
  if (volumes.length === 0) return false;
  const avgVolume = volumes.reduce((sum, vol) => sum + vol, 0) / volumes.length;
  const currentVolume = ohlcv[ohlcv.length - 1].volume;
  logger.info(`Detectando volume anômalo para ${timeframe}: Current=${currentVolume}, Avg=${avgVolume}, Threshold=${avgVolume * 2}`);
  return currentVolume >= avgVolume * 2;
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
    
    const largestBuyOrder = bids.reduce((max, [price, vol]) => vol > max.volume ? { price, volume: vol } : max, { price: 0, volume: 0 });
    const largestSellOrder = asks.reduce((max, [price, vol]) => vol > max.volume ? { price, volume: vol } : max, { price: 0, volume: 0 });
    
    const volumeDelta = totalBidVolume - totalAskVolume;
    const totalVolume = totalBidVolume + totalAskVolume;
    const deltaPercent = totalVolume !== 0 ? (volumeDelta / totalVolume * 100).toFixed(2) : 0;
    const onBalance = Math.abs(deltaPercent) > 10 ? (volumeDelta > 0 ? 'Comprador' : 'Vendedor') : 'Neutro';
    
    const buyLiquidityZones = bids
      .filter(([price, volume]) => volume >= totalBidVolume * liquidityThreshold)
      .map(([price]) => price);
    const sellLiquidityZones = asks
      .filter(([price, volume]) => volume >= totalAskVolume * liquidityThreshold)
      .map(([price]) => price);
    
    const result = {
      buyLiquidityZones,
      sellLiquidityZones,
      largestBuyOrder,
      largestSellOrder,
      onBalance
    };
    setCachedData(cacheKey, result);
    return result;
  } catch (e) {
    logger.error(`Erro ao buscar zonas de liquidez para ${symbol}: ${e.message}`);
    return getCachedData(cacheKey) || { 
      buyLiquidityZones: [], 
      sellLiquidityZones: [], 
      largestBuyOrder: { price: 0, volume: 0 }, 
      largestSellOrder: { price: 0, volume: 0 },
      onBalance: 'Neutro'
    };
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
    const recentOi = validOiData.slice(0, 3).map(d => d.openInterest);
    const previousRecentOi = validOiData.slice(3, 6).map(d => d.openInterest);
    const sma = recentOi.reduce((sum, val) => sum + val, 0) / recentOi.length;
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
function getSetaDirecao(current, previous) {
  if (!current || !previous) return "➡️";
  return current > previous ? "⬆️" : current < previous ? "⬇️" : "➡️";
}

async function sendAlertRSIDivergence(symbol, data) {
  logger.info(`Chamando sendAlertRSIDivergence para ${symbol}: RSI Divergence=${JSON.stringify(data.rsiDivergence)}`);
  const { ohlcv15m, ohlcv3m, price, rsi15m, rsiDivergence, lsr, fundingRate, aggressiveDelta, oi5m, oi15m, atr } = data;
  const agora = Date.now();
  if (!state.ultimoAlertaPorAtivo[symbol]) state.ultimoAlertaPorAtivo[symbol] = { historico: [] };
  if (state.ultimoAlertaPorAtivo[symbol]['15m'] && agora - state.ultimoAlertaPorAtivo[symbol]['15m'] < config.TEMPO_COOLDOWN_MS) {
    logger.info(`Cooldown ativo para ${symbol}, último alerta: ${state.ultimoAlertaPorAtivo[symbol]['15m']}`);
    return;
  }

  if (!rsiDivergence) {
    logger.warn(`Divergência RSI inválida para ${symbol}`);
    return;
  }

  const isBullishDivergence = rsiDivergence.isBullish;
  const isBearishDivergence = rsiDivergence.isBearish;

  logger.info(`RSI Divergence (15m) para ${symbol}: Bullish=${isBullishDivergence}, Bearish=${isBearishDivergence}, RSI=${rsi15m}`);

  const precision = price < 1 ? 8 : price < 10 ? 6 : price < 100 ? 4 : 2;
  const format = v => isNaN(v) ? 'N/A' : v.toFixed(precision);
  const zonas = detectarQuebraEstrutura(ohlcv15m);
  const volumeProfile = calculateVolumeProfile(ohlcv15m);
  const orderBookLiquidity = await fetchLiquidityZones(symbol);
  const isAnomalousVolume15m = detectAnomalousVolume(ohlcv15m, '15m');
  const isAnomalousVolume3m = detectAnomalousVolume(ohlcv3m, '3m');

  const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol.replace('/', '')}&interval=15`;
  const rsi15mEmoji = rsi15m > 60 ? "☑︎" : rsi15m < 40 ? "☑︎" : "";
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
  const rsiDivergenceText = isBullishDivergence ? `RSI Divergence (15m): Bullish 🟢` : isBearishDivergence ? `RSI Divergence (15m): Bearish 🔴` : `RSI Divergence (15m): Neutro`;
  const volumeText15m = isAnomalousVolume15m ? `Vol. Anormal 15m: ✅ Confirmado` : `Vol. Anormal 15m: ❌ Não `;
  const volumeText3m = isAnomalousVolume3m ? `Vol. Anormal 3m: ✅ Confirmado` : `Vol. Anormal 3m: ❌ Não `;

  const vpBuyZonesText = volumeProfile.buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const vpSellZonesText = volumeProfile.sellLiquidityZones.map(format).join(' / ') || 'N/A';
  const largestBuyOrderText = orderBookLiquidity.largestBuyOrder.price > 0 
    ? `${format(orderBookLiquidity.largestBuyOrder.price)} (${orderBookLiquidity.largestBuyOrder.volume.toFixed(2)})` 
    : 'N/A';
  const largestSellOrderText = orderBookLiquidity.largestSellOrder.price > 0 
    ? `${format(orderBookLiquidity.largestSellOrder.price)} (${orderBookLiquidity.largestSellOrder.volume.toFixed(2)})` 
    : 'N/A';
  const onBalanceText = `On-Balance: ${orderBookLiquidity.onBalance} ${orderBookLiquidity.onBalance === 'Comprador' ? '🟢' : orderBookLiquidity.onBalance === 'Vendedor' ? '🔴' : '🟡'}`;

  const entryLow = format(price - 0.3 * atr);
  const entryHigh = format(price + 0.5 * atr);
  const targetsBuy = [1, 2, 3].map(mult => format(price + mult * atr)).join(" / ");
  const targetsSell = [1, 2, 3].map(mult => format(price - mult * atr)).join(" / ");
  const stopBuy = format(price - 3.5 * atr);
  const stopSell = format(price + 3.5 * atr);

  let alertText = '';
  // Condições para compra: Divergência de alta RSI (15m) e volume anômalo no 3m
  const isBuySignal = isBullishDivergence && isAnomalousVolume3m;
  
  // Condições para venda: Divergência de baixa RSI (15m) e volume anômalo no 3m
  const isSellSignal = isBearishDivergence && isAnomalousVolume3m;

  logger.info(`Condições para ${symbol}: BuySignal=${isBuySignal}, SellSignal=${isSellSignal}, RSI Divergence(15m)=${isBullishDivergence ? 'Bullish' : isBearishDivergence ? 'Bearish' : 'Neutro'}, RSI15m=${rsi15m}, AnomalousVolume3m=${isAnomalousVolume3m}`);

  if (isBuySignal) {
    const foiAlertado = state.ultimoAlertaPorAtivo[symbol].historico.some(r => 
      r.direcao === 'buy' && (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = `🟢*Compra/DIVERGÊNCIA *\n\n` +
                  `🔹Ativo: <<*${symbol}*>> [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço: ${format(price)}\n` +
                  `🔹 RSI 15m: ${rsi15m.toFixed(2)} ${rsi15mEmoji}\n` +
                  `🔹 ${rsiDivergenceText}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 ${oi5mText}\n` +
                  `🔹 ${oi15mText}\n` +
                  `🔹 ${volumeText15m}\n` +
                  `🔹 ${volumeText3m}\n` +
                  `🔹 Entr.: ${entryLow}...${entryHigh}\n` +
                  `🎯 Tps: ${targetsBuy}\n` +
                  `⛔ Stop: ${stopBuy}\n` +
                  `❅────✧❅🔹❅✧────❅ \n` +
                  `🔹Estrutura: \n` +
                  `   Romp. de Baixa: ${format(zonas.estruturaBaixa)}\n` +
                  `   Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
                  `   Poc Bull: ${vpBuyZonesText}\n` +
                  `   Poc Bear: ${vpSellZonesText}\n` +
                  `   Maior Ordem Compra: ${largestBuyOrderText}\n` +
                  `   Maior Ordem Venda: ${largestSellOrderText}\n` +
                  `   ${onBalanceText}\n` +
                  ` ☑︎ Gerencie seu Risco -🤖 @J4Rviz\n`;
      state.ultimoAlertaPorAtivo[symbol]['15m'] = agora;
      state.ultimoAlertaPorAtivo[symbol].historico.push({ direcao: 'buy', timestamp: agora });
      state.ultimoAlertaPorAtivo[symbol].historico = state.ultimoAlertaPorAtivo[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.info(`Sinal de compra detectado para ${symbol}: Preço=${format(price)}, RSI Divergence(15m)=Bullish, RSI 15m=${rsi15m.toFixed(2)}, AnomalousVolume3m=${isAnomalousVolume3m}`);
    }
  } else if (isSellSignal) {
    const foiAlertado = state.ultimoAlertaPorAtivo[symbol].historico.some(r => 
      r.direcao === 'sell' && (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = `🔴*Correção/DIVERGÊNCIA *\n\n` +
                  `🔹Ativo: <<*${symbol}*>> [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço: ${format(price)}\n` +
                  `🔹 RSI 15m: ${rsi15m.toFixed(2)} ${rsi15mEmoji}\n` +
                  `🔹 ${rsiDivergenceText}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 ${oi5mText}\n` +
                  `🔹 ${oi15mText}\n` +
                  `🔹 ${volumeText15m}\n` +
                  `🔹 ${volumeText3m}\n` +
                  `🔹 Entr.: ${entryLow}...${entryHigh}\n` +
                  `🎯 Tps: ${targetsSell}\n` +
                  `⛔ Stop: ${stopSell}\n` +
                  `❅────✧❅🔹❅✧────❅ \n` +
                  `🔹Estrutura: \n` +
                  `   Romp. de Baixa: ${format(zonas.estruturaBaixa)}\n` +
                  `   Romp. de Alta: ${format(zonas.estruturaAlta)}\n` +
                  `   Poc Bull: ${vpBuyZonesText}\n` +
                  `   Poc Bear: ${vpSellZonesText}\n` +
                  `   Maior Ordem Compra: ${largestBuyOrderText}\n` +
                  `   Maior Ordem Venda: ${largestSellOrderText}\n` +
                  `   ${onBalanceText}\n` +
                  ` ☑︎ Gerencie seu Risco -🤖 @J4Rviz\n`;
      state.ultimoAlertaPorAtivo[symbol]['15m'] = agora;
      state.ultimoAlertaPorAtivo[symbol].historico.push({ direcao: 'sell', timestamp: agora });
      state.ultimoAlertaPorAtivo[symbol].historico = state.ultimoAlertaPorAtivo[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.info(`Sinal de venda detectado para ${symbol}: Preço=${format(price)}, RSI Divergence(15m)=Bearish, RSI 15m=${rsi15m.toFixed(2)}, AnomalousVolume3m=${isAnomalousVolume3m}`);
    }
  }

  if (alertText) {
    try {
      await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, alertText, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }));
      logger.info(`Alerta de sinal RSI Divergence enviado para ${symbol}: ${alertText}`);
    } catch (e) {
      logger.error(`Erro ao enviar alerta para ${symbol}: ${e.message}`);
    }
  }
}

async function checkConditions() {
  try {
    await limitConcurrency(config.PARES_MONITORADOS, async (symbol) => {
      const cacheKeyPrefix = `ohlcv_${symbol}`;
      const ohlcv15mRaw = getCachedData(`${cacheKeyPrefix}_15m`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '15m', undefined, config.RSI_PERIOD + 10));
      const ohlcv3mRaw = getCachedData(`${cacheKeyPrefix}_3m`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '3m', undefined, 21));
      if (!ohlcv15mRaw || !ohlcv3mRaw) {
        logger.warn(`Dados OHLCV insuficientes para ${symbol}, pulando...`);
        return;
      }

      const ohlcv15m = normalizeOHLCV(ohlcv15mRaw);
      const ohlcv3m = normalizeOHLCV(ohlcv3mRaw);
      const closes15m = ohlcv15m.map(c => c.close).filter(c => !isNaN(c));
      const currentPrice = closes15m[closes15m.length - 1];

      if (isNaN(currentPrice)) {
        logger.warn(`Preço atual inválido para ${symbol}, pulando...`);
        return;
      }

      if (ohlcv15m.length < config.RSI_PERIOD + 2) {
        logger.warn(`Candles insuficientes para RSI (15m) em ${symbol}: ${ohlcv15m.length}`);
        return;
      }

      const rsi15mValues = calculateRSI(ohlcv15m);
      const rsiDivergence = detectRSIDivergence(ohlcv15m, rsi15mValues);
      const oi5m = await fetchOpenInterest(symbol, '5m');
      const oi15m = await fetchOpenInterest(symbol, '15m');
      const lsr = await fetchLSR(symbol);
      const fundingRate = await fetchFundingRate(symbol);
      const aggressiveDelta = await calculateAggressiveDelta(symbol);
      const atrValues = calculateATR(ohlcv15m);

      if (!rsi15mValues.length || !rsiDivergence || !atrValues.length) {
        logger.warn(`Indicadores insuficientes para ${symbol}, pulando...`);
        return;
      }

      logger.info(`Últimos 5 candles 15m para ${symbol}: ${JSON.stringify(ohlcv15m.slice(-5))}`);
      logger.info(`Últimos 5 candles 3m para ${symbol}: ${JSON.stringify(ohlcv3m.slice(-5))}`);

      await sendAlertRSIDivergence(symbol, {
        ohlcv15m,
        ohlcv3m,
        price: currentPrice,
        rsi15m: rsi15mValues[rsi15mValues.length - 1],
        rsiDivergence,
        lsr,
        fundingRate,
        aggressiveDelta,
        oi5m,
        oi15m,
        atr: atrValues[atrValues.length - 1]
      });
    }, 5);
  } catch (e) {
    logger.error(`Erro ao processar condições: ${e.message}`);
  }
}

async function main() {
  logger.info('Iniciando simple trading bot');
  try {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, '🤖 Titanium D 💹Start...'));
    await checkConditions();
    setInterval(checkConditions, config.INTERVALO_ALERTA_15M_MS);
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));
