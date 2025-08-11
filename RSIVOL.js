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
  INTERVALO_ALERTA_MS: 5 * 60 * 1000, // 5 minutos
  CACHE_TTL: 5 * 60 * 1000, // 5 minutos
  MAX_CACHE_SIZE: 100,
  MAX_COINS_PER_ALERT: 3, // Apenas 3 moedas por categoria (RSI média mais alto/baixo)
  MAX_MESSAGE_LENGTH: 4000,
  EMA_PERIOD: 34,
  VOLUME_THRESHOLD_MULTIPLIER: 2,
  RSI_PERIOD: 14 // Período padrão para RSI
};

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'monitor.log' }),
    new winston.transports.Console()
  ]
});

// Estado global
const state = {
  dataCache: new Map(),
  lastFundingRates: new Map(),
  lastHighsLows: new Map()
};

// Validação de variáveis de ambiente
function validateEnv() {
  const required = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  for (const key of required) {
    if (!process.env[key]) {
      logger.error(`Variável de ambiente ausente: ${key}`);
      process.exit(1);
    }
  }
}
validateEnv();

// Inicialização do Telegram e Exchange
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
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
    logger.info(`Usando cache para ${key}: ${JSON.stringify(cacheEntry.data)}`);
    return cacheEntry.data;
  }
  state.dataCache.delete(key);
  return null;
}

function setCachedData(key, data) {
  if (data === null || (data.value !== undefined && data.value === null)) {
    logger.info(`Não armazenando valor nulo no cache para ${key}`);
    return;
  }
  if (state.dataCache.size >= config.MAX_CACHE_SIZE) {
    const oldestKey = state.dataCache.keys().next().value;
    state.dataCache.delete(oldestKey);
    logger.info(`Cache cheio, removido item mais antigo: ${oldestKey}`);
  }
  state.dataCache.set(key, { timestamp: Date.now(), data });
}

// Função para limpar o sufixo :USDT do símbolo
function cleanSymbol(symbol) {
  return symbol.replace(/:USDT$/, '');
}

// Limpeza periódica do cache
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of state.dataCache) {
    if (now - entry.timestamp > config.CACHE_TTL) {
      state.dataCache.delete(key);
      logger.info(`Cache removido: ${key}`);
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
    logger.warn(`Dados OHLCV vazios ou inválidos para ${symbol}`);
    return [];
  }
  const normalized = data.map(c => ({
    time: c[0],
    open: Number(c[1]),
    high: Number(c[2]),
    low: Number(c[3]),
    close: Number(c[4]),
    volume: Number(c[5])
  })).filter(c => !isNaN(c.close) && !isNaN(c.volume) && c.close > 0);
  if (normalized.length === 0) {
    logger.warn(`Nenhum dado OHLCV válido após normalização para ${symbol}`);
  } else {
    logger.info(`Dados OHLCV normalizados para ${symbol}: ${normalized.length} velas`);
  }
  return normalized;
}

function calculateEMA(data, period, symbol) {
  if (!data || data.length < period) {
    logger.warn(`Dados insuficientes para calcular EMA ${period} para ${symbol}: ${data?.length || 0} velas disponíveis`);
    return null;
  }
  const closes = data.map(d => d.close);
  if (closes.every(c => c === closes[0])) {
    logger.warn(`Preços constantes detectados para ${symbol}, EMA inválido`);
    return null;
  }
  const ema = TechnicalIndicators.EMA.calculate({
    period: period,
    values: closes
  });
  const emaValue = ema.length ? parseFloat(ema[ema.length - 1].toFixed(8)) : null;
  logger.info(`EMA ${period} calculado para ${symbol}: ${emaValue}`);
  return emaValue;
}

function calculateRSI(data, period, symbol) {
  if (!data || data.length < period + 1) {
    logger.warn(`Dados insuficientes para calcular RSI ${period} para ${symbol}: ${data?.length || 0} velas disponíveis`);
    return null;
  }
  const closes = data.map(d => d.close);
  if (closes.some(c => isNaN(c) || c <= 0) || closes.every(c => c === closes[0])) {
    logger.warn(`Preços inválidos ou constantes detectados para ${symbol}, RSI inválido`);
    return null;
  }
  try {
    const rsi = TechnicalIndicators.RSI.calculate({
      period: period,
      values: closes
    });
    const rsiValue = rsi.length ? parseFloat(rsi[rsi.length - 1].toFixed(2)) : null;
    logger.info(`RSI ${period} calculado para ${symbol}: ${rsiValue}`);
    return rsiValue;
  } catch (e) {
    logger.error(`Erro ao calcular RSI para ${symbol}: ${e.message}`);
    return null;
  }
}

function detectStructureBreak(data, symbol) {
  if (!data || data.length < 3) {
    logger.warn(`Dados insuficientes para detectar rompimento de estrutura para ${symbol}: ${data?.length || 0} velas disponíveis`);
    return { bullishBreak: false, bearishBreak: false };
  }
  
  const lastCandle = data[data.length - 1];
  const prevCandle1 = data[data.length - 2];
  const prevCandle2 = data[data.length - 3];
  
  const bullishBreak = lastCandle.close > prevCandle1.high && prevCandle1.high > prevCandle2.high;
  const bearishBreak = lastCandle.close < prevCandle1.low && prevCandle1.low < prevCandle2.low;
  
  logger.info(`Estrutura para ${symbol}: Bullish=${bullishBreak}, Bearish=${bearishBreak}`);
  return { bullishBreak, bearishBreak };
}

function calculateStochastic(data, symbol) {
  if (!data || data.length < 5 + 3) {
    logger.warn(`Dados insuficientes para calcular Estocástico para ${symbol}: ${data?.length || 0} velas disponíveis`);
    return { k: null, d: null, previousK: null };
  }
  const closes = data.map(d => d.close);
  if (closes.every(c => c === closes[0])) {
    logger.warn(`Preços constantes detectados para ${symbol}, Estocástico inválido`);
    return { k: null, d: null, previousK: null };
  }
  const stochastic = TechnicalIndicators.Stochastic.calculate({
    period: 5,
    signalPeriod: 3,
    high: data.map(d => d.high),
    low: data.map(d => d.low),
    close: closes
  });
  if (stochastic.length < 2) {
    logger.warn(`Resultados insuficientes para Estocástico para ${symbol}: ${stochastic.length} períodos calculados`);
    return { k: null, d: null, previousK: null };
  }
  return {
    k: parseFloat(stochastic[stochastic.length - 1].k.toFixed(2)),
    d: parseFloat(stochastic[stochastic.length - 1].d.toFixed(2)),
    previousK: parseFloat(stochastic[stochastic.length - 2].k.toFixed(2))
  };
}

function calculateSupportResistance(data, symbol) {
  if (!data || data.length < 50) {
    logger.warn(`Dados insuficientes para calcular Suporte/Resistência para ${symbol}: ${data?.length || 0} velas disponíveis`);
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

function calculateAbnormalVolume(ohlcv3m, ohlcv15m, ohlcv1h, ohlcv24h, delta, symbol) {
  const result = {
    volume3m: { isAbnormal: false, type: null },
    volume15m: { isAbnormal: false, type: null },
    volume1h: { isAbnormal: false, type: null },
    volume24h: { isAbnormal: false, type: null }
  };

  // Volume 3m
  if (!ohlcv3m || ohlcv3m.length < 11) {
    logger.warn(`Dados insuficientes para calcular volume anormal (3m) para ${symbol}: ${ohlcv3m?.length || 0} velas disponíveis`);
  } else {
    const previousVolumes3m = ohlcv3m.slice(ohlcv3m.length - 11, ohlcv3m.length - 1).map(d => d.volume);
    const averageVolume3m = previousVolumes3m.reduce((sum, vol) => sum + vol, 0) / previousVolumes3m.length;
    const currentVolume3m = ohlcv3m[ohlcv3m.length - 1].volume;
    const volumeThreshold3m = averageVolume3m * config.VOLUME_THRESHOLD_MULTIPLIER;
    result.volume3m.isAbnormal = currentVolume3m > volumeThreshold3m;
    result.volume3m.type = result.volume3m.isAbnormal ? (delta.isBuyPressure ? 'Compra' : 'Venda') : null;
    logger.info(`Volume anormal (3m) para ${symbol}: Current=${currentVolume3m}, Average=${averageVolume3m}, IsAbnormal=${result.volume3m.isAbnormal}, Type=${result.volume3m.type}`);
  }

  // Volume 15m
  if (!ohlcv15m || ohlcv15m.length < 11) {
    logger.warn(`Dados insuficientes para calcular volume anormal (15m) para ${symbol}: ${ohlcv15m?.length || 0} velas disponíveis`);
  } else {
    const previousVolumes15m = ohlcv15m.slice(ohlcv15m.length - 11, ohlcv15m.length - 1).map(d => d.volume);
    const averageVolume15m = previousVolumes15m.reduce((sum, vol) => sum + vol, 0) / previousVolumes15m.length;
    const currentVolume15m = ohlcv15m[ohlcv15m.length - 1].volume;
    const volumeThreshold15m = averageVolume15m * config.VOLUME_THRESHOLD_MULTIPLIER;
    result.volume15m.isAbnormal = currentVolume15m > volumeThreshold15m;
    result.volume15m.type = result.volume15m.isAbnormal ? (delta.isBuyPressure ? 'Compra' : 'Venda') : null;
    logger.info(`Volume anormal (15m) para ${symbol}: Current=${currentVolume15m}, Average=${averageVolume15m}, IsAbnormal=${result.volume15m.isAbnormal}, Type=${result.volume15m.type}`);
  }

  // Volume 1h
  if (!ohlcv1h || ohlcv1h.length < 11) {
    logger.warn(`Dados insuficientes para calcular volume anormal (1h) para ${symbol}: ${ohlcv1h?.length || 0} velas disponíveis`);
  } else {
    const previousVolumes1h = ohlcv1h.slice(ohlcv1h.length - 11, ohlcv1h.length - 1).map(d => d.volume);
    const averageVolume1h = previousVolumes1h.reduce((sum, vol) => sum + vol, 0) / previousVolumes1h.length;
    const currentVolume1h = ohlcv1h[ohlcv1h.length - 1].volume;
    const volumeThreshold1h = averageVolume1h * config.VOLUME_THRESHOLD_MULTIPLIER;
    result.volume1h.isAbnormal = currentVolume1h > volumeThreshold1h;
    result.volume1h.type = result.volume1h.isAbnormal ? (delta.isBuyPressure ? 'Compra' : 'Venda') : null;
    logger.info(`Volume anormal (1h) para ${symbol}: Current=${currentVolume1h}, Average=${averageVolume1h}, IsAbnormal=${result.volume1h.isAbnormal}, Type=${result.volume1h.type}`);
  }

  // Volume 24h
  if (!ohlcv24h || ohlcv24h.length < 11) {
    logger.warn(`Dados insuficientes para calcular volume anormal (24h) para ${symbol}: ${ohlcv24h?.length || 0} velas disponíveis`);
  } else {
    const previousVolumes24h = ohlcv24h.slice(ohlcv24h.length - 11, ohlcv24h.length - 1).map(d => d.volume);
    const averageVolume24h = previousVolumes24h.reduce((sum, vol) => sum + vol, 0) / previousVolumes24h.length;
    const currentVolume24h = ohlcv24h[ohlcv24h.length - 1].volume;
    const volumeThreshold24h = averageVolume24h * config.VOLUME_THRESHOLD_MULTIPLIER;
    result.volume24h.isAbnormal = currentVolume24h > volumeThreshold24h;
    result.volume24h.type = result.volume24h.isAbnormal ? (delta.isBuyPressure ? 'Compra' : 'Venda') : null;
    logger.info(`Volume anormal (24h) para ${symbol}: Current=${currentVolume24h}, Average=${averageVolume24h}, IsAbnormal=${result.volume24h.isAbnormal}, Type=${result.volume24h.type}`);
  }

  return result;
}

async function fetchLSR(symbol) {
  const cacheKey = `lsr_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) {
    logger.info(`Usando cache para LSR de ${symbol}: ${cached.value}`);
    return cached;
  }
  try {
    let apiSymbol = symbol.replace('/', '').toUpperCase();
    if (apiSymbol.endsWith(':USDT')) {
      apiSymbol = apiSymbol.replace(':USDT', '');
    }
    logger.info(`Símbolo enviado para API de LSR: ${apiSymbol}`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const res = await withRetry(() =>
      axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', {
        params: { symbol: apiSymbol, period: '15m', limit: 1 }
      })
    );
    logger.info(`Resposta bruta de LSR para ${symbol}: ${JSON.stringify(res.data)}`);
    logger.info(`Status HTTP da requisição LSR para ${symbol}: ${res.status}`);
    if (!res.data || !Array.isArray(res.data) || res.data.length === 0) {
      logger.warn(`Dados insuficientes de LSR para ${symbol}: resposta vazia ou inválida`);
      return { value: null };
    }
    const longShortRatio = res.data[0]?.longShortRatio;
    if (longShortRatio === undefined || longShortRatio === null) {
      logger.warn(`longShortRatio não definido para ${symbol}: ${JSON.stringify(res.data[0])}`);
      return { value: null };
    }
    const value = parseFloat(longShortRatio);
    if (isNaN(value) || value < 0) {
      logger.warn(`longShortRatio inválido para ${symbol}: ${longShortRatio}`);
      return { value: null };
    }
    const result = { value: parseFloat(value.toFixed(2)) };
    setCachedData(cacheKey, result);
    logger.info(`LSR calculado para ${symbol}: ${result.value}`);
    return result;
  } catch (e) {
    logger.warn(`Erro ao buscar LSR para ${symbol}: ${e.message}, código: ${e.response?.status}`);
    return { value: null };
  }
}

async function fetchFundingRate(symbol) {
  const cacheKey = `funding_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const fundingData = await withRetry(() => exchangeFutures.fetchFundingRate(symbol));
    const result = { current: parseFloat((fundingData.fundingRate * 100).toFixed(5)) };
    setCachedData(cacheKey, result);
    state.lastFundingRates.set(symbol, result.current);
    return result;
  } catch (e) {
    logger.warn(`Erro ao buscar Funding Rate para ${symbol}: ${e.message}`);
    return { current: null };
  }
}

async function fetchOpenInterest(symbol, timeframe) {
  const cacheKey = `oi_${symbol}_${timeframe}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const oiData = await withRetry(() => exchangeFutures.fetchOpenInterestHistory(symbol, timeframe, undefined, 6));
    if (!oiData || oiData.length < 3) {
      logger.warn(`Dados insuficientes de Open Interest para ${symbol} no timeframe ${timeframe}: ${oiData?.length || 0} registros`);
      return { isRising: false, value: null };
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
      logger.warn(`Registros válidos insuficientes para ${symbol} no timeframe ${timeframe}: ${validOiData.length}`);
      return { isRising: false, value: null };
    }
    const recentOi = validOiData.slice(0, 3).map(d => d.openInterest);
    const previousOi = validOiData.slice(3, 6).map(d => d.openInterest);
    const smaRecent = recentOi.reduce((sum, val) => sum + val, 0) / recentOi.length;
    const smaPrevious = previousOi.length >= 3 ? previousOi.reduce((sum, val) => sum + val, 0) / previousOi.length : recentOi[recentOi.length - 1];
    const result = { 
      isRising: smaRecent > smaPrevious,
      value: parseFloat(smaRecent.toFixed(2))
    };
    setCachedData(cacheKey, result);
    logger.info(`Open Interest calculado para ${symbol} no timeframe ${timeframe}: smaRecent=${smaRecent}, smaPrevious=${smaPrevious}, isRising=${result.isRising}`);
    return result;
  } catch (e) {
    logger.warn(`Erro ao buscar Open Interest para ${symbol} no timeframe ${timeframe}: ${e.message}`);
    return { isRising: false, value: null };
  }
}

async function calculateAggressiveDelta(symbol) {
  const cacheKey = `delta_${symbol}`;
  const cached = getCachedData(cacheKey);
  if (cached) return cached;
  try {
    const trades = await withRetry(() => exchangeFutures.fetchTrades(symbol, undefined, 100));
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
    const result = { deltaPercent, isBuyPressure: delta > 0 };
    setCachedData(cacheKey, result);
    logger.info(`Delta Agressivo para ${symbol}: Buy=${buyVolume}, Sell=${sellVolume}, Delta%=${deltaPercent}%`);
    return result;
  } catch (e) {
    logger.error(`Erro ao calcular Delta Agressivo para ${symbol}: ${e.message}`);
    return { deltaPercent: 0, isBuyPressure: false };
  }
}

// ================= FUNÇÕES DE ALERTAS ================= //
function format(value, precision = 2) {
  return isNaN(value) || value === null ? 'N/A' : value.toFixed(precision);
}

function formatPrice(price) {
  if (price === null || isNaN(price)) return 'N/A';
  return price < 1 ? price.toFixed(8) : price < 10 ? price.toFixed(6) : price < 100 ? price.toFixed(4) : price.toFixed(2);
}

function getStochasticEmoji(value) {
  if (!value) return "";
  return value < 10 ? "🔵" : value < 25 ? "🟢" : value <= 55 ? "🟡" : value <= 70 ? "🟠" : value <= 80 ? "🔴" : "💥";
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
    logger.info(`Mensagem enviada com sucesso, tamanho: ${message.length} caracteres`);
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
    logger.info(`Parte ${i + 1}/${parts.length} enviada, tamanho: ${parts[i].length} caracteres`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

async function sendMonitorAlert(coins) {
  // Filtrar moedas com RSI válido (excluir null)
  const validCoins = coins.filter(c => c.rsi15m !== null && c.rsi1h !== null && !isNaN(c.rsi15m) && !isNaN(c.rsi1h));
  
  // Calcular a média do RSI para cada moeda
  validCoins.forEach(coin => {
    coin.rsiAverage = parseFloat(((coin.rsi15m + coin.rsi1h) / 2).toFixed(2));
  });

  // Moedas com as 3 médias de RSI mais altas
  const topHighRSIAverage = validCoins
    .sort((a, b) => b.rsiAverage - a.rsiAverage)
    .slice(0, config.MAX_COINS_PER_ALERT);

  // Moedas com as 3 médias de RSI mais baixas
  const topLowRSIAverage = validCoins
    .sort((a, b) => a.rsiAverage - b.rsiAverage)
    .slice(0, config.MAX_COINS_PER_ALERT);

  logger.info(`RSI Média Alto: ${topHighRSIAverage.length}, RSI Média Baixo: ${topLowRSIAverage.length}`);

  // Função para formatar mensagem para cada grupo de moedas
  async function formatAlert(coins, title) {
    if (coins.length === 0) return '';
    let alertText = `*${title}*\n\n`;
    alertText += await Promise.all(coins.map(async (coin, i) => {
      const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${coin.symbol.replace('/', '')}&interval=15`;
      let lsrSymbol = '';
      if (coin.lsr !== null && !isNaN(coin.lsr)) {
        if (coin.lsr <= 1.4) lsrSymbol = '✅ Baixo';
        else if (coin.lsr >= 2.8) lsrSymbol = '📛 Alto';
      }
      const lsrText = coin.lsr !== null && !isNaN(coin.lsr) ? format(coin.lsr) + ` ${lsrSymbol}` : 'Indisponível';
      let fundingRateEmoji = '';
      if (coin.funding.current !== null && !isNaN(coin.funding.current)) {
        if (coin.funding.current <= -0.002) fundingRateEmoji = '🟢🟢🟢';
        else if (coin.funding.current <= -0.001) fundingRateEmoji = '🟢🟢';
        else if (coin.funding.current <= -0.0005) fundingRateEmoji = '🟢';
        else if (coin.funding.current >= 0.001) fundingRateEmoji = '🔴';
        else if (coin.funding.current >= 0.005) fundingRateEmoji = '🔴🔴';
        else if (coin.funding.current >= 0.1) fundingRateEmoji = '🔴🔴🔴';
        else fundingRateEmoji = '🟢';
      }
      const deltaText = coin.delta.isBuyPressure ? `💹${format(coin.delta.deltaPercent)}%` : `⭕${format(coin.delta.deltaPercent)}%`;
      const oi5mText = coin.oi5m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
      const oi15mText = coin.oi15m.isRising ? '⬆️ Subindo' : '⬇️ Descendo';
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
      const volume3mText = coin.volume.volume3m.isAbnormal ? 
        `${coin.volume.volume3m.type === 'Compra' ? '🟢' : '🔴'} Volume Anormal (3m): ${coin.volume.volume3m.type}` : 
        'Volume Normal (3m)';
      const volume15mText = coin.volume.volume15m.isAbnormal ? 
        `${coin.volume.volume15m.type === 'Compra' ? '🟢' : '🔴'} Volume Anormal (15m): ${coin.volume.volume15m.type}` : 
        'Volume Normal (15m)';
      const volume1hText = coin.volume.volume1h.isAbnormal ? 
        `${coin.volume.volume1h.type === 'Compra' ? '🟢' : '🔴'} Volume Anormal (1h): ${coin.volume.volume1h.type}` : 
        'Volume Normal (1h)';
      const volume24hText = coin.volume.volume24h.isAbnormal ? 
        `${coin.volume.volume24h.type === 'Compra' ? '🟢' : '🔴'} Volume Anormal (24h): ${coin.volume.volume24h.type}` : 
        'Volume Normal (24h)';
      return `${i + 1}. 🔹 *${cleanSymbol(coin.symbol)}* [- TradingView](${tradingViewLink})\n` +
             `   💲 Preço: ${formatPrice(coin.price)}\n` +
             `   EMA 34 (15m): ${formatPrice(coin.ema15m)}\n` +
             `   RSI (15m): ${format(coin.rsi15m)}\n` +
             `   RSI (1h): ${format(coin.rsi1h)}\n` +
             `   RSI Média: ${format(coin.rsiAverage)}\n` +
             `   ${volume3mText}\n` +
             `   ${volume15mText}\n` +
             `   ${volume1hText}\n` +
             `   ${volume24hText}\n` +
             `   LSR: ${lsrText}\n` +
             `   Stoch (4h): %K ${stoch4hK}${stoch4hKEmoji} ${stoch4hDir} \n` +
             `   Stoch (1d): %K ${stoch1dK}${stoch1dKEmoji} ${stoch1dDir} \n` +
             `   Vol.Delta: ${deltaText}\n` +
             `   Fund.Rate: ${fundingRateEmoji}${format(coin.funding.current, 5)}%\n` +
             `   OI 5m: ${oi5mText}\n` +
             `   OI 15m: ${oi15mText}\n` +
             `   Suporte: ${formatPrice(coin.supportResistance.support)}\n` +
             `   Resistência: ${formatPrice(coin.supportResistance.resistance)}\n`;
    })).then(results => results.join('\n'));
    alertText += `\n☑︎ 🤖 Monitor - @J4Rviz`;
    return alertText;
  }

  // Enviar alertas para cada categoria
  const highRSIAverageAlert = await formatAlert(topHighRSIAverage, '🔴 RSI Média Mais Altos 🚀');
  const lowRSIAverageAlert = await formatAlert(topLowRSIAverage, '🟢 RSI Média Mais Baixos 📉');

  // Enviar mensagens apenas se houver conteúdo
  if (highRSIAverageAlert) {
    logger.info(`Tamanho da mensagem RSI Média Alto: ${highRSIAverageAlert.length} caracteres`);
    await sendTelegramMessage(highRSIAverageAlert);
  }
  if (lowRSIAverageAlert) {
    logger.info(`Tamanho da mensagem RSI Média Baixo: ${lowRSIAverageAlert.length} caracteres`);
    await sendTelegramMessage(lowRSIAverageAlert);
  }

  if (topHighRSIAverage.length === 0 && topLowRSIAverage.length === 0) {
    logger.info('Nenhum alerta gerado, nenhuma moeda atende aos critérios');
  } else {
    logger.info('Alertas de monitoramento processados com sucesso');
  }
}

async function checkCoins() {
  try {
    const markets = await withRetry(() => exchangeFutures.loadMarkets());
    if (!markets || Object.keys(markets).length === 0) {
      logger.error('Nenhum mercado carregado por loadMarkets()');
      return;
    }
    const allPairs = Object.keys(markets);
    logger.info(`Total de pares carregados: ${allPairs.length}`);
    logger.info(`Primeiros 10 pares: ${allPairs.slice(0, 10).join(', ')}`);
    const usdtPairs = Object.keys(markets)
      .filter(symbol => {
        const isUSDT = symbol.endsWith('USDT') || symbol.endsWith(':USDT');
        const isActive = markets[symbol].active;
        const isFuture = markets[symbol].future || (markets[symbol].info && markets[symbol].info.contractType === 'PERPETUAL');
        logger.debug(`Verificando par ${symbol}: isUSDT=${isUSDT}, isActive=${isActive}, isFuture=${isFuture}`);
        return isUSDT && isActive && isFuture;
      })
      .slice(0, 100);
    logger.info(`Pares de futuros USDT encontrados: ${usdtPairs.length}`);
    if (usdtPairs.length === 0) {
      logger.warn('Nenhum par de futuros USDT encontrado, verificando configuração da API');
      return;
    }
    const coinsData = await limitConcurrency(usdtPairs, async (symbol) => {
      try {
        const ticker = await withRetry(() => exchangeFutures.fetchTicker(symbol));
        const price = ticker?.last || null;
        if (!price || isNaN(price)) {
          logger.warn(`Preço inválido para ${symbol}, pulando...`);
          return null;
        }
        // Buscar OHLCV para 3m
        const ohlcv3mRaw = getCachedData(`ohlcv_${symbol}_3m`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '3m', undefined, 12));
        setCachedData(`ohlcv_${symbol}_3m`, ohlcv3mRaw);
        const ohlcv3m = normalizeOHLCV(ohlcv3mRaw, symbol);
        if (!ohlcv3m.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (3m), pulando...`);
          return null;
        }
        // Buscar OHLCV para 15m
        const ohlcv15mRaw = getCachedData(`ohlcv_${symbol}_15m`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '15m', undefined, Math.max(config.EMA_PERIOD, config.RSI_PERIOD) + 2));
        setCachedData(`ohlcv_${symbol}_15m`, ohlcv15mRaw);
        const ohlcv15m = normalizeOHLCV(ohlcv15mRaw, symbol);
        if (!ohlcv15m.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (15m), pulando...`);
          return null;
        }
        // Buscar OHLCV para 1h
        const ohlcv1hRaw = getCachedData(`ohlcv_${symbol}_1h`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '1h', undefined, Math.max(config.RSI_PERIOD, 12) + 1));
        setCachedData(`ohlcv_${symbol}_1h`, ohlcv1hRaw);
        const ohlcv1h = normalizeOHLCV(ohlcv1hRaw, symbol);
        if (!ohlcv1h.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (1h), pulando...`);
          return null;
        }
        // Buscar OHLCV para 24h
        const ohlcv24hRaw = getCachedData(`ohlcv_${symbol}_24h`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '1d', undefined, 12));
        setCachedData(`ohlcv_${symbol}_24h`, ohlcv24hRaw);
        const ohlcv24h = normalizeOHLCV(ohlcv24hRaw, symbol);
        if (!ohlcv24h.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (24h), pulando...`);
          return null;
        }
        // Buscar OHLCV para 4h
        const ohlcv4hRaw = getCachedData(`ohlcv_${symbol}_4h`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '4h', undefined, 8));
        setCachedData(`ohlcv_${symbol}_4h`, ohlcv4hRaw);
        const ohlcv4h = normalizeOHLCV(ohlcv4hRaw, symbol);
        if (!ohlcv4h.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (4h), pulando...`);
          return null;
        }
        // Buscar OHLCV para 1d
        const ohlcv1dRaw = getCachedData(`ohlcv_${symbol}_1d`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '1d', undefined, 8));
        setCachedData(`ohlcv_${symbol}_1d`, ohlcv1dRaw);
        const ohlcv1d = normalizeOHLCV(ohlcv1dRaw, symbol);
        if (!ohlcv1d.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (1d), pulando...`);
          return null;
        }
        // Buscar OHLCV para 50 períodos
        const ohlcv50Raw = getCachedData(`ohlcv_${symbol}_50`) ||
          await withRetry(() => exchangeFutures.fetchOHLCV(symbol, '15m', undefined, 50));
        setCachedData(`ohlcv_${symbol}_50`, ohlcv50Raw);
        const ohlcv50 = normalizeOHLCV(ohlcv50Raw, symbol);
        if (!ohlcv50.length) {
          logger.warn(`Dados OHLCV insuficientes para ${symbol} (50 períodos), pulando...`);
          return null;
        }
        const ema15m = calculateEMA(ohlcv15m, config.EMA_PERIOD, symbol);
        const rsi15m = calculateRSI(ohlcv15m, config.RSI_PERIOD, symbol);
        const rsi1h = calculateRSI(ohlcv1h, config.RSI_PERIOD, symbol);
        if (rsi15m === null || rsi1h === null) {
          logger.warn(`RSI inválido para ${symbol}, pulando...`);
          return null;
        }
        const rsiAverage = parseFloat(((rsi15m + rsi1h) / 2).toFixed(2));
        const structure15m = detectStructureBreak(ohlcv15m, symbol);
        const lsr = (await fetchLSR(symbol)).value;
        const funding = await fetchFundingRate(symbol);
        const delta = await calculateAggressiveDelta(symbol);
        const volume = calculateAbnormalVolume(ohlcv3m, ohlcv15m, ohlcv1h, ohlcv24h, delta, symbol);
        const oi5m = await fetchOpenInterest(symbol, '5m');
        const oi15m = await fetchOpenInterest(symbol, '15m');
        const stoch4h = calculateStochastic(ohlcv4h, symbol);
        const stoch1d = calculateStochastic(ohlcv1d, symbol);
        const supportResistance = calculateSupportResistance(ohlcv50, symbol);
        logger.info(`Moeda processada: ${symbol}, RSI15m: ${rsi15m}, RSI1h: ${rsi1h}, RSIAverage: ${rsiAverage}, EMA15m: ${ema15m}, BullishBreak: ${structure15m.bullishBreak}, BearishBreak: ${structure15m.bearishBreak}, Volume3m: ${JSON.stringify(volume.volume3m)}, Volume15m: ${JSON.stringify(volume.volume15m)}, Volume1h: ${JSON.stringify(volume.volume1h)}, Volume24h: ${JSON.stringify(volume.volume24h)}`);
        return { symbol, price, rsi15m, rsi1h, rsiAverage, ema15m, structure15m, lsr, funding, delta, volume, oi5m, oi15m, stoch4h, stoch1d, supportResistance };
      } catch (e) {
        logger.warn(`Erro ao processar ${symbol}: ${e.message}`);
        return null;
      }
    }, 5);
    const validCoins = coinsData.filter(coin => coin !== null);
    logger.info(`Moedas válidas processadas: ${validCoins.length}`);
    validCoins.forEach(coin => logger.info(`Moeda: ${coin.symbol}, RSI15m: ${coin.rsi15m}, RSI1h: ${coin.rsi1h}, RSIAverage: ${coin.rsiAverage}, EMA15m: ${coin.ema15m}, BullishBreak: ${coin.structure15m.bullishBreak}, BearishBreak: ${coin.structure15m.bearishBreak}, Volume3m: ${JSON.stringify(coin.volume.volume3m)}, Volume15m: ${JSON.stringify(coin.volume15m)}, Volume1h: ${JSON.stringify(coin.volume.volume1h)}, Volume24h: ${JSON.stringify(coin.volume.volume24h)}`));
    if (validCoins.length > 0) {
      await sendMonitorAlert(validCoins);
    } else {
      logger.warn('Nenhuma moeda válida processada, nenhum alerta enviado.');
    }
  } catch (e) {
    logger.error(`Erro ao processar moedas: ${e.message}`);
  }
}

async function main() {
  logger.info('Iniciando monitor de moedas');
  try {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, '🤖 Titanium RSI Monitor!'));
    await checkCoins();
    setInterval(checkCoins, config.INTERVALO_ALERTA_MS);
  } catch (e) {
    logger.error(`Erro ao iniciar monitor: ${e.message}`);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));