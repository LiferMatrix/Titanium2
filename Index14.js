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
  INTERVALO_ALERTA_3M_MS: 180000,
  TEMPO_COOLDOWN_MS: 15 * 60 * 1000,
  RSI_PERIOD: 14,
  CACHE_TTL: 10 * 60 * 1000,
  MAX_CACHE_SIZE: 100,
  MAX_HISTORICO_ALERTAS: 10,
  ADX_PERIOD: 10,
  ADX_MIN: 25
};

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'quick_trading_bot.log' }),
    new winston.transports.Console()
  ]
});

// Estado global
const state = {
  ultimoRompimento: {},
  ultimoEstocastico: {},
  dataCache: new Map(),
  ignoredSymbols: new Set()
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
async function withRetry(fn, retries = 10, delayBase = 2000) {
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
    if (cacheEntry.data && Array.isArray(cacheEntry.data) && cacheEntry.data.length > 0) {
      logger.info(`Usando cache para ${key}, tamanho=${cacheEntry.data.length}`);
      return cacheEntry.data;
    } else {
      logger.warn(`Cache inválido para ${key}, dados=${JSON.stringify(cacheEntry.data)}`);
      state.dataCache.delete(key);
    }
  }
  return null;
}

function setCachedData(key, data) {
  if (!data || (Array.isArray(data) && data.length === 0)) {
    logger.warn(`Tentativa de cachear dados inválidos para ${key}`);
    return;
  }
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
  if (!data || !Array.isArray(data)) return [];
  const normalized = data.map(c => ({
    time: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  })).filter(c => !isNaN(c.close) && !isNaN(c.volume) && !isNaN(c.high) && !isNaN(c.low));
  logger.info(`OHLCV normalizado: tamanho=${normalized.length}, primeiros 5=${JSON.stringify(normalized.slice(0, 5))}`);
  return normalized;
}

function calculateRSI(data) {
  if (!data || data.length < config.RSI_PERIOD + 1) {
    logger.warn(`Dados insuficientes para RSI: tamanho=${data.length}, mínimo=${config.RSI_PERIOD + 1}`);
    return [];
  }
  const rsi = TechnicalIndicators.RSI.calculate({
    period: config.RSI_PERIOD,
    values: data.map(d => d.close)
  });
  const filteredRsi = rsi.filter(v => !isNaN(v));
  logger.info(`RSI calculado: tamanho=${filteredRsi.length}`);
  return filteredRsi;
}

function calculateStochastic(data, periodK = 5, smoothK = 3, periodD = 3) {
  if (!data || data.length < periodK + smoothK + periodD - 2) {
    logger.warn(`Dados insuficientes para Stochastic: tamanho=${data.length}, mínimo=${periodK + smoothK + periodD - 2}`);
    return null;
  }
  const highs = data.map(c => c.high).filter(h => !isNaN(h));
  const lows = data.map(c => c.low).filter(l => !isNaN(l));
  const closes = data.map(c => c.close).filter(cl => !isNaN(cl));
  if (highs.length < periodK || lows.length < periodK || closes.length < periodK) {
    logger.warn(`Dados inválidos para Stochastic: highs=${highs.length}, lows=${lows.length}, closes=${closes.length}`);
    return null;
  }
  const result = TechnicalIndicators.Stochastic.calculate({
    high: highs,
    low: lows,
    close: closes,
    period: periodK,
    signalPeriod: periodD,
    smoothing: smoothK
  });
  return result.length ? { k: parseFloat(result[result.length - 1].k.toFixed(2)), d: parseFloat(result[result.length - 1].d.toFixed(2)) } : null;
}

function calculateADX(data) {
  if (!data || data.length < config.ADX_PERIOD + 1) {
    logger.warn(`Dados insuficientes para ADX: tamanho=${data.length}, mínimo=${config.ADX_PERIOD + 1}`);
    return [];
  }
  const adx = TechnicalIndicators.ADX.calculate({
    period: config.ADX_PERIOD,
    high: data.map(d => d.high),
    low: data.map(d => d.low),
    close: data.map(d => d.close)
  });
  const filteredAdx = adx.filter(v => !isNaN(v.adx)).map(v => v.adx);
  logger.info(`ADX calculado: tamanho=${filteredAdx.length}`);
  return filteredAdx;
}

function detectarQuebraEstrutura(ohlcv) {
  if (!ohlcv || ohlcv.length < 2) {
    logger.warn(`Dados insuficientes para detectar quebra de estrutura: tamanho=${ohlcv.length}`);
    return { estruturaAlta: 0, estruturaBaixa: 0, buyLiquidityZones: [], sellLiquidityZones: [] };
  }
  const lookbackPeriod = 20;
  const previousCandles = ohlcv.slice(0, -1).slice(-lookbackPeriod);
  const highs = previousCandles.map(c => c.high).filter(h => !isNaN(h));
  const lows = previousCandles.map(c => c.low).filter(l => !isNaN(l));
  const volumes = previousCandles.map(c => c.volume).filter(v => !isNaN(v));
  if (highs.length === 0 || lows.length === 0 || volumes.length === 0) {
    logger.warn(`Dados inválidos para quebra de estrutura: highs=${highs.length}, lows=${lows.length}, volumes=${volumes.length}`);
    return { estruturaAlta: 0, estruturaBaixa: 0, buyLiquidityZones: [], sellLiquidityZones: [] };
  }
  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const avgVolume = volumes.reduce((sum, v) => sum + v, 0) / volumes.length;
  const volumeThreshold = avgVolume;
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

function calculateVolumeProfile(ohlcv, priceStepPercent = 0.1) {
  if (!ohlcv || ohlcv.length < 2) {
    logger.warn(`Dados insuficientes para Volume Profile: tamanho=${ohlcv.length}`);
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

async function fetchOpenInterest(symbol, timeframe, retries = 10) {
  const cacheKey = `oi_${symbol}_${timeframe}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const oiData = await withRetry(() => exchangeFutures.fetchOpenInterestHistory(symbol, timeframe, undefined, 30));
    if (!oiData || oiData.length < 3) {
      logger.warn(`Dados insuficientes de Open Interest para ${symbol} no timeframe ${timeframe}: ${oiData?.length || 0} registros`);
      if (retries > 0) {
        const delay = Math.pow(2, 10 - retries) * 2000;
        logger.info(`Tentando novamente para ${symbol} no timeframe ${timeframe}, tentativas restantes: ${retries}, delay: ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return await fetchOpenInterest(symbol, timeframe, retries - 1);
      }
      if (timeframe === '5m') {
        logger.info(`Fallback para timeframe 15m para ${symbol}`);
        return await fetchOpenInterest(symbol, '15m', 3);
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
        const delay = Math.pow(2, 10 - retries) * 2000;
        logger.info(`Tentando novamente para ${symbol} no timeframe ${timeframe}, tentativas restantes: ${retries}, delay: ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return await fetchOpenInterest(symbol, timeframe, retries - 1);
      }
      if (timeframe === '5m') {
        logger.info(`Fallback para timeframe 15m para ${symbol}`);
        return await fetchOpenInterest(symbol, '15m', 3);
      }
      return { isRising: false, percentChange: '0.00' };
    }
    const oiValues = validOiData.map(d => d.openInterest).filter(v => v !== undefined);
    const sortedOi = [...oiValues].sort((a, b) => a - b);
    const q1 = sortedOi[Math.floor(sortedOi.length / 4)];
    const q3 = sortedOi[Math.floor(3 * sortedOi.length / 4)];
    const iqr = q3 - q1;
    const lowerBound = q1 - 1.5 * iqr;
    const upperBound = q3 + 1.5 * iqr;
    const filteredOiData = validOiData.filter(d => d.openInterest >= lowerBound && d.openInterest <= upperBound);
    if (filteredOiData.length < 3) {
      logger.warn(`Registros válidos após filtro IQR insuficientes para ${symbol} no timeframe ${timeframe}: ${filteredOiData.length}`);
      if (retries > 0) {
        const delay = Math.pow(2, 10 - retries) * 2000;
        logger.info(`Tentando novamente para ${symbol} no timeframe ${timeframe}, tentativas restantes: ${retries}, delay: ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return await fetchOpenInterest(symbol, timeframe, retries - 1);
      }
      if (timeframe === '5m') {
        logger.info(`Fallback para timeframe 15m para ${symbol}`);
        return await fetchOpenInterest(symbol, '15m', 3);
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
      state.ignoredSymbols.add(symbol);
      setTimeout(() => state.ignoredSymbols.delete(symbol), 30 * 60 * 1000);
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

async function calculateAggressiveDelta(symbol, timeframe = '3m', limit = 100) {
  const cacheKey = `delta_${symbol}_${timeframe}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const trades = await withRetry(() => exchangeSpot.fetchTrades(symbol, undefined, limit));
    let buyVolume = 0;
    let sellVolume = 0;
    const volumes = trades.map(trade => trade.amount).filter(amount => !isNaN(amount));
    const avgVolume = volumes.length > 0 ? volumes.reduce((sum, v) => sum + v, 0) / volumes.length : 0;
    const minVolumeThreshold = avgVolume * 0.001;
    for (const trade of trades) {
      const { side, amount, price } = trade;
      if (!side || !amount || !price || isNaN(amount) || isNaN(price) || amount < minVolumeThreshold) continue;
      if (side === 'buy') buyVolume += amount;
      else if (side === 'sell') sellVolume += amount;
    }
    const totalVolume = buyVolume + sellVolume;
    if (totalVolume === 0) {
      logger.warn(`Volume total zero para ${symbol}, retornando delta neutro`);
      return { delta: 0, deltaPercent: 0, isBuyPressure: false, isSignificant: false };
    }
    const delta = buyVolume - sellVolume;
    const deltaPercent = (delta / totalVolume * 100).toFixed(2);
    const result = {
      delta,
      deltaPercent: parseFloat(deltaPercent),
      isBuyPressure: delta > 0,
      isSignificant: Math.abs(deltaPercent) > 10
    };
    setCachedData(cacheKey, result);
    logger.info(`Delta Agressivo para ${symbol}: Buy=${buyVolume}, Sell=${sellVolume}, Delta=${delta}, Delta%=${deltaPercent}%, MinVolumeThreshold=${minVolumeThreshold}`);
    return result;
  } catch (e) {
    logger.error(`Erro ao calcular Delta Agressivo para ${symbol}: ${e.message}`);
    return getCachedData(cacheKey) || { delta: 0, deltaPercent: 0, isBuyPressure: false, isSignificant: false };
  }
}

// ================= FUNÇÕES DE ALERTAS ================= //
function getStochasticEmoji(value) {
  if (!value) return "";
  return value < 10 ? "🔵" : value < 25 ? "🟢" : value <= 55 ? "🟡" : value <= 70 ? "🟠" : value <= 80 ? "🔴" : "💥";
}

function getSetaDirecao(current, previous) {
  if (!current || !previous) return "➡️";
  return current > previous ? "⬆️" : current < previous ? "⬇️" : "➡️";
}

async function sendAlertRompimentoEstrutura15m(symbol, price, zonas, ohlcv15m, rsi1h, lsr, fundingRate, aggressiveDelta, estocasticoD, estocastico4h, oi15m, adx15m) {
  const agora = Date.now();
  if (!state.ultimoRompimento[symbol]) state.ultimoRompimento[symbol] = { historico: [] };
  if (state.ultimoRompimento[symbol]['15m'] && agora - state.ultimoRompimento[symbol]['15m'] < config.TEMPO_COOLDOWN_MS) return;
  const precision = price < 1 ? 8 : price < 10 ? 6 : price < 100 ? 4 : 2;
  const format = v => isNaN(v) ? 'N/A' : v.toFixed(precision);
  const currentCandle = ohlcv15m[ohlcv15m.length - 1];
  const previousCandle = ohlcv15m.length >= 2 ? ohlcv15m[ohlcv15m.length - 2] : null;
  const isValidPreviousCandle = previousCandle !== null && !isNaN(previousCandle.close);
  if (!currentCandle || !isValidPreviousCandle) return;
  const currentClose = currentCandle.close;
  const currentHigh = currentCandle.high;
  const currentLow = currentCandle.low;
  const previousClose = previousCandle.close;
  const isPriceRising = currentClose > previousClose;
  const isPriceFalling = currentClose < previousClose;
  let alertText = '';
  const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol.replace('/', '')}&interval=15`;
  const rsi1hEmoji = rsi1h > 60 ? "☑︎" : rsi1h < 40 ? "☑︎" : "";
  let lsrSymbol = '🔘Consol.';
  if (lsr.value !== null) {
    if (lsr.value <= 1.4) lsrSymbol = '✅Baixo';
    else if (lsr.value >= 3) lsrSymbol = '📛Alto';
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
  const oiText = oi15m ? `${oi15m.isRising ? '📈' : '📉'} OI 15m: ${oi15m.percentChange}%` : '🔹 Indisp.';
  const adxText = adx15m ? `${adx15m >= config.ADX_MIN ? '📈' : '🔘'} ${adx15m.toFixed(2)}` : '🔹 Indisp.';
  if (!state.ultimoEstocastico[symbol]) state.ultimoEstocastico[symbol] = {};
  const kAnteriorD = state.ultimoEstocastico[symbol].kD || estocasticoD?.k || 0;
  const kAnterior4h = state.ultimoEstocastico[symbol].k4h || estocastico4h?.k || 0;
  state.ultimoEstocastico[symbol].kD = estocasticoD?.k;
  state.ultimoEstocastico[symbol].k4h = estocastico4h?.k;
  const direcaoD = getSetaDirecao(estocasticoD?.k, kAnteriorD);
  const direcao4h = getSetaDirecao(estocastico4h?.k, kAnterior4h);
  const stochDEmoji = estocasticoD ? getStochasticEmoji(estocasticoD.k) : "";
  const stoch4hEmoji = estocastico4h ? getStochasticEmoji(estocastico4h.k) : "";
  const vpBuyZonesText = calculateVolumeProfile(ohlcv15m).buyLiquidityZones.map(format).join(' / ') || 'N/A';
  const vpSellZonesText = calculateVolumeProfile(ohlcv15m).sellLiquidityZones.map(format).join(' / ') || 'N/A';

  if (isValidPreviousCandle &&
      zonas.estruturaAlta > 0 &&
      previousClose < zonas.estruturaAlta &&
      currentHigh >= zonas.estruturaAlta &&
      isPriceRising &&
      (lsr.value === null || lsr.value < 2.8) &&
      aggressiveDelta.isBuyPressure &&
      estocasticoD?.k < 73 &&
      estocastico4h?.k < 73 &&
      rsi1h < 55) {
    const nivelRompido = zonas.estruturaAlta;
    const foiAlertado = state.ultimoRompimento[symbol].historico.some(r =>
      r.nivel === nivelRompido &&
      r.direcao === 'alta' &&
      (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = ` *Rompimento de 🚀Alta🚀*\n\n` +
                  `🔹 Ativo: <<*${symbol}*>> [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço Atual: ${format(price)}\n` +
                  `🔹 RSI 1h: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 OI 15m: ${oiText}\n` +
                  `🔹 ADX: ${adxText}\n` +
                  `🔹 Stoch Diário %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${stochDEmoji} ${direcaoD}\n` +
                  `🔹 Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${stoch4hEmoji} ${direcao4h}\n` +
                  `   Poc Bull: ${vpBuyZonesText}\n` +
                  `   Poc Bear: ${vpSellZonesText}\n` +
                  `☑︎ Monitor -🤖 @J4Rviz`;
      state.ultimoRompimento[symbol]['15m'] = agora;
      state.ultimoRompimento[symbol].historico.push({ nivel: nivelRompido, direcao: 'alta', timestamp: agora });
      state.ultimoRompimento[symbol].historico = state.ultimoRompimento[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.info(`Rompimento de alta detectado para ${symbol}: Preço=${format(price)}, Estrutura Alta=${format(zonas.estruturaAlta)}, Tendência=Subindo, Preço Anterior=${format(previousClose)}, LSR=${lsr.value ? lsr.value.toFixed(2) : 'Spot'}, Delta=${aggressiveDelta.deltaPercent}%, OI 15m=${oi15m.percentChange}%, RSI 1h=${rsi1h.toFixed(2)}, ADX 15m=${adx15m.toFixed(2)}`);
    }
  } else if (isValidPreviousCandle &&
             zonas.estruturaBaixa > 0 &&
             previousClose > zonas.estruturaBaixa &&
             currentLow <= zonas.estruturaBaixa &&
             isPriceFalling &&
             (lsr.value === null || lsr.value > 2.8) &&
             !aggressiveDelta.isBuyPressure &&
             estocastico4h?.k > 73 &&
             rsi1h > 55) {
    const nivelRompido = zonas.estruturaBaixa;
    const foiAlertado = state.ultimoRompimento[symbol].historico.some(r =>
      r.nivel === nivelRompido &&
      r.direcao === 'baixa' &&
      (agora - r.timestamp) < config.TEMPO_COOLDOWN_MS
    );
    if (!foiAlertado) {
      alertText = ` *Rompimento de 🔻Baixa🔻*\n\n` +
                  `🔹 Ativo: <<*${symbol}*>> [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço Atual: ${format(price)}\n` +
                  `🔹 RSI 1h: ${rsi1h.toFixed(2)} ${rsi1hEmoji}\n` +
                  `🔹 LSR: ${lsr.value ? lsr.value.toFixed(2) : '🔹Spot'} ${lsrSymbol} (${lsr.percentChange}%)\n` +
                  `🔹 Fund. R: ${fundingRateText}\n` +
                  `🔸 Vol.Delta: ${deltaText}\n` +
                  `🔹 OI 15m: ${oiText}\n` +
                  `🔹 ADX: ${adxText}\n` +
                  `🔹 Stoch Diário %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${stochDEmoji} ${direcaoD}\n` +
                  `🔹 Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${stoch4hEmoji} ${direcao4h}\n` +
                  `   Poc Bull: ${vpBuyZonesText}\n` +
                  `   Poc Bear: ${vpSellZonesText}\n` +
                  `☑︎ Monitor -🤖 @J4Rviz`;
      state.ultimoRompimento[symbol]['15m'] = agora;
      state.ultimoRompimento[symbol].historico.push({ nivel: nivelRompido, direcao: 'baixa', timestamp: agora });
      state.ultimoRompimento[symbol].historico = state.ultimoRompimento[symbol].historico.slice(-config.MAX_HISTORICO_ALERTAS);
      logger.info(`Rompimento de baixa detectado para ${symbol}: Preço=${format(price)}, Estrutura Baixa=${format(zonas.estruturaBaixa)}, Tendência=Caindo, Preço Anterior=${format(previousClose)}, LSR=${lsr.value ? lsr.value.toFixed(2) : 'Spot'}, Delta=${aggressiveDelta.deltaPercent}%, OI 15m=${oi15m.percentChange}%, RSI 1h=${rsi1h.toFixed(2)}, ADX 15m=${adx15m.toFixed(2)}`);
    }
  }

  if (alertText) {
    try {
      await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, alertText, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }));
      logger.info(`Alerta de rompimento de estrutura enviado para ${symbol}`);
    } catch (e) {
      logger.error(`Erro ao enviar alerta para ${symbol}: ${e.message}`);
    }
  }
}

async function checkConditions() {
  try {
    await limitConcurrency(config.PARES_MONITORADOS.filter(s => !state.ignoredSymbols.has(s)), async (symbol) => {
      try {
        const cacheKeyPrefix = `ohlcv_${symbol}`;
        const minCandles = Math.max(config.RSI_PERIOD + 1, config.ADX_PERIOD + 1);
        const ohlcv15mRaw = getCachedData(`${cacheKeyPrefix}_15m`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '15m', undefined, minCandles));
        const ohlcv1hRaw = getCachedData(`${cacheKeyPrefix}_1h`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '1h', undefined, minCandles));
        const ohlcv4hRaw = getCachedData(`${cacheKeyPrefix}_4h`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '4h', undefined, 20));
        const ohlcvDiarioRaw = getCachedData(`${cacheKeyPrefix}_1d`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '1d', undefined, 20));

        logger.info(`OHLCV para ${symbol}: 15m=${ohlcv15mRaw?.length || 0}, 1h=${ohlcv1hRaw?.length || 0}, 4h=${ohlcv4hRaw?.length || 0}, 1d=${ohlcvDiarioRaw?.length || 0}`);

        if (!ohlcv15mRaw || !ohlcv1hRaw || !ohlcv4hRaw || !ohlcvDiarioRaw) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol}, pulando...`);
          state.ignoredSymbols.add(symbol);
          setTimeout(() => state.ignoredSymbols.delete(symbol), 30 * 60 * 1000);
          return;
        }

        const ohlcv15m = normalizeOHLCV(ohlcv15mRaw);
        const ohlcv1h = normalizeOHLCV(ohlcv1hRaw);
        const ohlcv4h = normalizeOHLCV(ohlcv4hRaw);
        const ohlcvDiario = normalizeOHLCV(ohlcvDiarioRaw);

        logger.info(`OHLCV normalizado para ${symbol}: 15m=${ohlcv15m.length}, 1h=${ohlcv1h.length}, 4h=${ohlcv4h.length}, 1d=${ohlcvDiario.length}`);

        if (ohlcv15m.length < minCandles || ohlcv1h.length < minCandles) {
          logger.warn(`Dados normalizados insuficientes para ${symbol}, pulando...`);
          state.ignoredSymbols.add(symbol);
          setTimeout(() => state.ignoredSymbols.delete(symbol), 30 * 60 * 1000);
          return;
        }

        setCachedData(`${cacheKeyPrefix}_15m`, ohlcv15mRaw);
        setCachedData(`${cacheKeyPrefix}_1h`, ohlcv1hRaw);
        setCachedData(`${cacheKeyPrefix}_4h`, ohlcv4hRaw);
        setCachedData(`${cacheKeyPrefix}_1d`, ohlcvDiarioRaw);

        const closes15m = ohlcv15m.map(c => c.close).filter(c => !isNaN(c));
        const currentPrice = closes15m[closes15m.length - 1];
        if (isNaN(currentPrice)) {
          logger.warn(`Preço atual inválido para ${symbol}, pulando...`);
          return;
        }

        const rsi1hValues = calculateRSI(ohlcv1h);
        const adx15mValues = calculateADX(ohlcv15m);
        const lsr = await fetchLSR(symbol);
        const oi15m = await fetchOpenInterest(symbol, '15m');
        const fundingRate = await fetchFundingRate(symbol);
        const zonas = detectarQuebraEstrutura(ohlcv15m);
        const estocasticoD = calculateStochastic(ohlcvDiario, 5, 3, 3);
        const estocastico4h = calculateStochastic(ohlcv4h, 5, 3, 3);

        logger.info(`Indicadores para ${symbol}: RSI1h=${rsi1hValues.length}, ADX15m=${adx15mValues.length}`);

        if (!rsi1hValues.length || !adx15mValues.length) {
          logger.warn(`Indicadores insuficientes para ${symbol}, pulando...`);
          state.ignoredSymbols.add(symbol);
          setTimeout(() => state.ignoredSymbols.delete(symbol), 30 * 60 * 1000);
          return;
        }

        await sendAlertRompimentoEstrutura15m(
          symbol,
          currentPrice,
          zonas,
          ohlcv15m,
          rsi1hValues[rsi1hValues.length - 1],
          lsr,
          fundingRate,
          await calculateAggressiveDelta(symbol),
          estocasticoD,
          estocastico4h,
          oi15m,
          adx15mValues[adx15mValues.length - 1]
        );
      } catch (e) {
        logger.error(`Erro ao processar ${symbol}: ${e.message}`);
        state.ignoredSymbols.add(symbol);
        setTimeout(() => state.ignoredSymbols.delete(symbol), 30 * 60 * 1000);
      }
    }, 5);
  } catch (e) {
    logger.error(`Erro ao processar condições: ${e.message}`);
  }
}

async function main() {
  logger.info('Iniciando scalp');
  try {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, '🤖 Titanium 💹Start...'));
    await checkConditions();
    setInterval(checkConditions, config.INTERVALO_ALERTA_3M_MS);
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));