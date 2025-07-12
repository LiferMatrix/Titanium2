require('dotenv').config();
const ccxt = require('ccxt');
const TechnicalIndicators = require('technicalindicators');
const { Bot } = require('grammy');
const winston = require('winston');
const axios = require('axios');

// ================= CONFIGURAÇÃO ================= //
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PAR_MONITORADO = 'BTCUSDT';
const INTERVALO_RELATORIO_15M_MS = 15 * 60 * 1000; // 15 minutos
const API_DELAY_MS = 500; // Delay entre chamadas à API
const ATR_PERIOD = 14; // Período para cálculo do ATR
const ATR_MULTIPLIER_STOP = 2; // Multiplicador para stop-loss (2x ATR)
const ATR_MULTIPLIER_FILTER = 3; // Multiplicador para filtrar alvos fora da faixa de volatilidade
const CAPITAL = 10000; // Capital base para cálculo de tamanho de posição ($10.000)
const RISK_PER_TRADE = 0.01; // Risco por trade (1%)

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'btc_analysis_bot.log' }),
    new winston.transports.Console()
  ]
});

// Declaração explícita no início do script
const ultimoEstocastico = {};

// Validação de variáveis de ambiente
function validateEnv() {
  const required = ['BINANCE_API_KEY', 'BINANCE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  for (const key of required) {
    if (!process.env[key]) {
      logger.error(`Missing environment variable: ${key}`);
      process.exit(1);
    }
  }
}
validateEnv();

const bot = new Bot(TELEGRAM_BOT_TOKEN);

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

const rsiPeriod = 14;
const keltnerPeriod = 20; // Período para Keltner Channels
const keltnerMultiplier = 2; // Multiplicador para Keltner Channels

// ================= FUNÇÕES AUXILIARES ================= //
function isValidNumber(value) {
  return typeof value === 'number' && !isNaN(value) && value !== null;
}

function format(price, v) {
  try {
    if (!isValidNumber(v)) {
      logger.warn(`Valor inválido para formatação: ${v}`);
      return '--';
    }
    if (!isValidNumber(price)) {
      logger.warn(`Preço inválido para formatação: ${price}`);
      return v.toFixed(2); // Fallback para 2 casas decimais
    }
    return price < 1 ? v.toFixed(8) : price < 10 ? v.toFixed(6) : price < 100 ? v.toFixed(4) : v.toFixed(2);
  } catch (e) {
    logger.error(`Erro ao formatar valor ${v}: ${e.message}`);
    return '--';
  }
}

// ================= FUNÇÕES DE INDICADORES ================= //
function calculateRSI(data) {
  if (!data || data.length < rsiPeriod + 1) return null;
  return TechnicalIndicators.RSI.calculate({
    period: rsiPeriod,
    values: data.map(d => d.close).filter(isValidNumber)
  });
}

function calculateCVD(data) {
  let cvd = 0;
  for (let i = 1; i < data.length; i++) {
    const curr = data[i];
    if (!isValidNumber(curr[4]) || !isValidNumber(curr[1]) || !isValidNumber(curr[5])) continue;
    if (curr[4] > curr[1]) cvd += curr[5];
    else if (curr[4] < curr[1]) cvd -= curr[5];
  }
  return cvd;
}

function calculateOBV(data) {
  let obv = 0;
  for (let i = 1; i < data.length; i++) {
    const curr = data[i];
    const prev = data[i - 1];
    if (!isValidNumber(curr[4]) || !isValidNumber(prev[4]) || !isValidNumber(curr[5])) continue;
    if (curr[4] > prev[4]) obv += curr[5];
    else if (curr[4] < prev[4]) obv -= curr[5];
  }
  return obv;
}

function calculateMACD(data) {
  const values = data.map(d => d.close).filter(isValidNumber);
  if (values.length < 26) return null;
  const macd = TechnicalIndicators.MACD.calculate({
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    values
  });
  if (!macd || macd.length === 0) return null;
  const last = macd[macd.length - 1];
  return {
    macd: isValidNumber(last.MACD) ? last.MACD.toFixed(2) : '--',
    signal: isValidNumber(last.signal) ? last.signal.toFixed(2) : '--',
    histogram: isValidNumber(last.histogram) ? last.histogram.toFixed(2) : '--',
    status: isValidNumber(last.MACD) && isValidNumber(last.signal) ? (last.MACD > last.signal ? "⬆️ Bullish" : "⬇️ Bearish") : "🔹 Indisponível"
  };
}

function calculateBollingerBands(data) {
  const values = data.map(d => d.close).filter(isValidNumber);
  if (values.length < 20) return null;
  const bb = TechnicalIndicators.BollingerBands.calculate({
    period: 20,
    stdDev: 2,
    values
  });
  if (!bb || bb.length === 0) return null;
  const last = bb[bb.length - 1];
  const lastClose = values[values.length - 1];
  return {
    upper: isValidNumber(last.upper) ? last.upper.toFixed(2) : '--',
    middle: isValidNumber(last.middle) ? last.middle.toFixed(2) : '--',
    lower: isValidNumber(last.lower) ? last.lower.toFixed(2) : '--',
    status: isValidNumber(lastClose) && isValidNumber(last.upper) && isValidNumber(last.lower)
      ? lastClose > last.upper ? "🔴 Acima da banda superior" :
        lastClose < last.lower ? "🟢 Abaixo da banda inferior" : "⚖️ Dentro das bandas"
      : "🔹 Indisponível"
  };
}

function calculateATR(data, period = ATR_PERIOD) {
  if (!data || data.length < period + 1) return null;
  const atr = TechnicalIndicators.ATR.calculate({
    high: data.map(d => d.high).filter(isValidNumber),
    low: data.map(d => d.low).filter(isValidNumber),
    close: data.map(d => d.close).filter(isValidNumber),
    period
  });
  return atr && atr.length > 0 && isValidNumber(atr[atr.length - 1]) ? atr[atr.length - 1] : null;
}

function calculateKeltnerChannels(data) {
  if (!data || data.length < keltnerPeriod + 1) return null;
  const keltner = TechnicalIndicators.KeltnerChannels.calculate({
    maPeriod: keltnerPeriod,
    atrPeriod: ATR_PERIOD,
    multiplier: keltnerMultiplier,
    high: data.map(d => d.high).filter(isValidNumber),
    low: data.map(d => d.low).filter(isValidNumber),
    close: data.map(d => d.close).filter(isValidNumber)
  });
  if (!keltner || keltner.length === 0) return null;
  const last = keltner[keltner.length - 1];
  const lastClose = data[data.length - 1].close;
  return {
    upper: isValidNumber(last.upper) ? last.upper.toFixed(2) : '--',
    middle: isValidNumber(last.middle) ? last.middle.toFixed(2) : '--',
    lower: isValidNumber(last.lower) ? last.lower.toFixed(2) : '--',
    status: isValidNumber(lastClose) && isValidNumber(last.upper) && isValidNumber(last.lower)
      ? lastClose > last.upper ? "🔴 Acima da banda superior" :
        lastClose < last.lower ? "🟢 Abaixo da banda inferior" : "⚖️ Dentro das bandas"
      : "🔹 Indisponível"
  };
}

function calculateVWAP(data) {
  let totalVolume = 0, totalPriceVolume = 0;
  for (const candle of data) {
    if (!isValidNumber(candle.high) || !isValidNumber(candle.low) || !isValidNumber(candle.close) || !isValidNumber(candle.volume)) continue;
    const typicalPrice = (candle.high + candle.low + candle.close) / 3;
    totalPriceVolume += typicalPrice * candle.volume;
    totalVolume += candle.volume;
  }
  return totalVolume > 0 && isValidNumber(totalPriceVolume) ? (totalPriceVolume / totalVolume) : null;
}

function calculatePivotPoints(data) {
  if (!data || data.length < 1) return null;
  const lastCandle = data[data.length - 1];
  if (!isValidNumber(lastCandle.high) || !isValidNumber(lastCandle.low) || !isValidNumber(lastCandle.close)) return null;
  const high = lastCandle.high;
  const low = lastCandle.low;
  const close = lastCandle.close;
  const pivot = (high + low + close) / 3;
  const r1 = 2 * pivot - low;
  const s1 = 2 * pivot - high;
  const r2 = pivot + (high - low);
  const s2 = pivot - (high - low);
  return {
    pivot: isValidNumber(pivot) ? pivot.toFixed(2) : '--',
    r1: isValidNumber(r1) ? r1.toFixed(2) : '--',
    s1: isValidNumber(s1) ? s1.toFixed(2) : '--',
    r2: isValidNumber(r2) ? r2.toFixed(2) : '--',
    s2: isValidNumber(s2) ? s2.toFixed(2) : '--'
  };
}

function detectarQuebraEstrutura(ohlcv15m) {
  if (!ohlcv15m || ohlcv15m.length < 2) {
    return {
      estruturaAlta: 0,
      estruturaBaixa: 0,
      buyLiquidityZones: [],
      sellLiquidityZones: []
    };
  }

  const highs = ohlcv15m.map(c => c.high).filter(isValidNumber);
  const lows = ohlcv15m.map(c => c.low).filter(isValidNumber);
  const volumes = ohlcv15m.map(c => c.volume).filter(isValidNumber);

  if (highs.length === 0 || lows.length === 0 || volumes.length === 0) {
    return {
      estruturaAlta: 0,
      estruturaBaixa: 0,
      buyLiquidityZones: [],
      sellLiquidityZones: []
    };
  }

  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const volumeThreshold = Math.max(...volumes) * 0.7;

  const buyLiquidityZones = [];
  const sellLiquidityZones = [];

  ohlcv15m.forEach(candle => {
    if (!isValidNumber(candle.volume) || !isValidNumber(candle.low) || !isValidNumber(candle.high)) return;
    if (candle.volume >= volumeThreshold) {
      if (candle.low <= minLow * 1.01) {
        buyLiquidityZones.push(candle.low);
      }
      if (candle.high >= maxHigh * 0.99) {
        sellLiquidityZones.push(candle.high);
      }
    }
  });

  const uniqueBuyZones = [...new Set(buyLiquidityZones.filter(isValidNumber).sort((a, b) => b - a))].slice(0, 2);
  const uniqueSellZones = [...new Set(sellLiquidityZones.filter(isValidNumber).sort((a, b) => a - b))].slice(0, 2);

  return {
    estruturaAlta: isValidNumber(maxHigh) ? maxHigh : 0,
    estruturaBaixa: isValidNumber(minLow) ? minLow : 0,
    buyLiquidityZones: uniqueBuyZones.length > 0 ? uniqueBuyZones : [minLow].filter(isValidNumber),
    sellLiquidityZones: uniqueSellZones.length > 0 ? uniqueSellZones : [maxHigh].filter(isValidNumber)
  };
}

function calculateStochastic(data, periodK = 5, smoothK = 3, periodD = 3) {
  if (!data || data.length < periodK + smoothK + periodD - 2) {
    logger.warn(`Dados insuficientes para calcular estocástico: ${data?.length || 0} velas`);
    return null;
  }

  const highs = data.map(c => c.high).filter(isValidNumber);
  const lows = data.map(c => c.low).filter(isValidNumber);
  const closes = data.map(c => c.close).filter(isValidNumber);

  if (highs.length < periodK || lows.length < periodK || closes.length < periodK) {
    logger.warn(`Dados filtrados insuficientes: highs=${highs.length}, lows=${lows.length}, closes=${closes.length}`);
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

  if (!result || result.length === 0) {
    logger.warn('Nenhum resultado do cálculo estocástico');
    return null;
  }

  const lastResult = result[result.length - 1];
  return {
    k: isValidNumber(lastResult.k) ? parseFloat(lastResult.k.toFixed(2)) : null,
    d: isValidNumber(lastResult.d) ? parseFloat(lastResult.d.toFixed(2)) : null
  };
}

function getStochasticEmoji(value) {
  if (!isValidNumber(value)) return "";
  return value < 10 ? "🔵" :
         value < 25 ? "🟢" :
         value <= 55 ? "🟡" :
         value <= 70 ? "🟠" :
         value <= 80 ? "🔴" : "💥";
}

function getSetaDirecao(current, previous) {
  if (!isValidNumber(current) || !isValidNumber(previous)) return "➡️";
  if (current > previous) return "⬆️";
  if (current < previous) return "⬇️";
  return "➡️";
}

// ================= FUNÇÕES DE DADOS DE MERCADO ================= //
async function fetchLSR(symbol) {
  try {
    const accountRes = await axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', {
      params: { symbol: symbol.replace('/', ''), period: '15m', limit: 2 }
    });
    const accountLSR = accountRes.data && accountRes.data.length >= 2 ? {
      value: parseFloat(accountRes.data[0].longShortRatio),
      status: parseFloat(accountRes.data[0].longShortRatio) > parseFloat(accountRes.data[1].longShortRatio) ? "⬆️ Subindo" : "⬇️ Caindo",
      percentChange: accountRes.data[1].longShortRatio > 0 ? ((parseFloat(accountRes.data[0].longShortRatio) - parseFloat(accountRes.data[1].longShortRatio)) / parseFloat(accountRes.data[1].longShortRatio) * 100).toFixed(2) : 0
    } : { value: null, status: "🔹 Indisponível", percentChange: 0 };

    const positionRes = await axios.get('https://fapi.binance.com/futures/data/topLongShortPositionRatio', {
      params: { symbol: symbol.replace('/', ''), period: '15m', limit: 2 }
    });
    const positionLSR = positionRes.data && positionRes.data.length >= 2 ? {
      value: parseFloat(positionRes.data[0].longShortRatio),
      status: parseFloat(positionRes.data[0].longShortRatio) > parseFloat(positionRes.data[1].longShortRatio) ? "⬆️ Subindo" : "⬇️ Caindo",
      percentChange: positionRes.data[1].longShortRatio > 0 ? ((parseFloat(positionRes.data[0].longShortRatio) - parseFloat(positionRes.data[1].longShortRatio)) / parseFloat(positionRes.data[1].longShortRatio) * 100).toFixed(2) : 0
    } : { value: null, status: "🔹 Indisponível", percentChange: 0 };

    await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
    return { account: accountLSR, position: positionLSR };
  } catch (e) {
    logger.warn(`Erro ao buscar LSR para ${symbol}: ${e.message}`);
    return {
      account: { value: null, status: "🔹 Indisponível", percentChange: 0 },
      position: { value: null, status: "🔹 Indisponível", percentChange: 0 }
    };
  }
}

async function fetchOpenInterest(symbol, timeframe) {
  try {
    const oiData = await exchangeFutures.fetchOpenInterestHistory(symbol, timeframe, undefined, 2);
    if (oiData && oiData.length >= 2) {
      const currentOI = oiData[oiData.length - 1].openInterest;
      const previousOI = oiData[oiData.length - 2].openInterest;
      const percentChange = isValidNumber(previousOI) && previousOI > 0 ? ((currentOI - previousOI) / previousOI * 100).toFixed(2) : 0;
      await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
      return {
        value: isValidNumber(currentOI) ? currentOI : null,
        status: isValidNumber(currentOI) && isValidNumber(previousOI) ? (currentOI > previousOI ? `⬆️ Subindo (+${percentChange}%)` : `⬇️ Caindo (${percentChange}%)`) : "🔹 Indisponível",
        percentChange: parseFloat(percentChange)
      };
    }
    return { value: null, status: "🔹 Indisponível", percentChange: 0 };
  } catch (e) {
    logger.warn(`Erro ao buscar Open Interest para ${symbol} no timeframe ${timeframe}: ${e.message}`);
    return { value: null, status: "🔹 Indisponível", percentChange: 0 };
  }
}

async function fetchTotalOpenInterest(symbol) {
  try {
    const res = await axios.get('https://fapi.binance.com/fapi/v1/openInterest', {
      params: { symbol: symbol.replace('/', '') }
    });
    await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
    return res.data && isValidNumber(res.data.sumOpenInterestValue) ? parseFloat(res.data.sumOpenInterestValue) : null;
  } catch (e) {
    logger.warn(`Erro ao buscar Open Interest total para ${symbol}: ${e.message}`);
    return null;
  }
}

async function fetchOrderBook(symbol) {
  try {
    const orderBook = await exchangeSpot.fetchOrderBook(symbol, 10);
    if (!orderBook.bids || !orderBook.asks || orderBook.bids.length === 0 || orderBook.asks.length === 0) {
      return { bids: [], asks: [], totalBidVolume: 0, totalAskVolume: 0, supportZone: 0, resistanceZone: 0 };
    }

    const bids = orderBook.bids.map(([price, amount]) => ({ price, amount })).slice(0, 5).filter(b => isValidNumber(b.price) && isValidNumber(b.amount));
    const asks = orderBook.asks.map(([price, amount]) => ({ price, amount })).slice(0, 5).filter(a => isValidNumber(a.price) && isValidNumber(a.amount));
    const totalBidVolume = bids.reduce((sum, bid) => sum + bid.amount, 0);
    const totalAskVolume = asks.reduce((sum, ask) => sum + ask.amount, 0);

    const significantBids = bids.filter(b => b.amount > totalBidVolume * 0.1);
    const significantAsks = asks.filter(a => a.amount > totalAskVolume * 0.1);
    const supportZone = significantBids.length > 0 ? significantBids[0].price : (bids[0]?.price || 0);
    const resistanceZone = significantAsks.length > 0 ? significantAsks[0].price : (asks[0]?.price || 0);

    await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
    return { bids, asks, totalBidVolume, totalAskVolume, supportZone, resistanceZone };
  } catch (e) {
    logger.warn(`Erro ao buscar order book para ${symbol}: ${e.message}`);
    return { bids: [], asks: [], totalBidVolume: 0, totalAskVolume: 0, supportZone: 0, resistanceZone: 0 };
  }
}

async function fetchFundingRate(symbol) {
  try {
    const fundingData = await exchangeFutures.fetchFundingRateHistory(symbol, undefined, 2);
    if (fundingData && fundingData.length >= 2) {
      const currentFunding = fundingData[fundingData.length - 1].fundingRate;
      const previousFunding = fundingData[fundingData.length - 2].fundingRate;
      await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
      return {
        current: isValidNumber(currentFunding) ? currentFunding : null,
        status: isValidNumber(currentFunding) && isValidNumber(previousFunding) ? (currentFunding > previousFunding ? "⬆️ Subindo" : "⬇️ Caindo") : "🔹 Indisponível"
      };
    }
    return { current: null, status: "🔹 Indisponível" };
  } catch (e) {
    logger.warn(`Erro ao buscar Funding Rate para ${symbol}: ${e.message}`);
    return { current: null, status: "🔹 Indisponível" };
  }
}

async function fetchCorrelation(symbol, compareSymbol = 'ETHUSDT') {
  try {
    const btcData = await exchangeSpot.fetchOHLCV(symbol, '1d', undefined, 20);
    const ethData = await exchangeSpot.fetchOHLCV(compareSymbol, '1d', undefined, 20);
    const btcCloses = btcData.map(c => c[4]).filter(isValidNumber);
    const ethCloses = ethData.map(c => c[4]).filter(isValidNumber);

    if (btcCloses.length < 20 || ethCloses.length < 20) return "🔹 Dados insuficientes";

    const meanBtc = btcCloses.reduce((sum, val) => sum + val, 0) / btcCloses.length;
    const meanEth = ethCloses.reduce((sum, val) => sum + val, 0) / ethCloses.length;

    let covariance = 0, stdBtc = 0, stdEth = 0;
    for (let i = 0; i < btcCloses.length; i++) {
      covariance += (btcCloses[i] - meanBtc) * (ethCloses[i] - meanEth);
      stdBtc += Math.pow(btcCloses[i] - meanBtc, 2);
      stdEth += Math.pow(ethCloses[i] - meanEth, 2);
    }

    const correlation = covariance / Math.sqrt(stdBtc * stdEth);
    return isValidNumber(correlation) && correlation > 0.7 ? "🟢 Alta correlação com ETH" : "⚖️ Baixa correlação com ETH";
  } catch (e) {
    logger.warn(`Erro ao calcular correlação: ${e.message}`);
    return "🔹 Indisponível";
  }
}

async function backtestTargets(symbol, timeframe = '1d', periods = 30) {
  try {
    const ohlcv = await exchangeSpot.fetchOHLCV(symbol, timeframe, undefined, periods);
    let successRate = 0, totalTests = 0;

    for (let i = 20; i < ohlcv.length; i++) {
      const pastData = ohlcv.slice(0, i);
      const fibLevels = calculateFibonacciLevels(pastData, timeframe);
      if (!fibLevels) continue;

      const nextCandle = ohlcv[i];
      if (!isValidNumber(nextCandle[2]) || !isValidNumber(nextCandle[3])) continue;
      const buyHit = fibLevels.levels['38.2'] > nextCandle[3] && fibLevels.levels['38.2'] < nextCandle[2];
      const sellHit = fibLevels.levels['61.8'] < nextCandle[2] && fibLevels.levels['61.8'] > nextCandle[3];

      if (buyHit || sellHit) successRate++;
      totalTests++;
    }

    return totalTests > 0 ? (successRate / totalTests * 100).toFixed(2) : 0;
  } catch (e) {
    logger.warn(`Erro no backtesting: ${e.message}`);
    return 0;
  }
}

// ================= ANÁLISES DE MERCADO ================= //
function calculateFibonacciLevels(ohlcv, timeframe = '1d', atr = null) {
  const highs = ohlcv.map(c => c[2]).filter(isValidNumber);
  const lows = ohlcv.map(c => c[3]).filter(isValidNumber);
  if (highs.length < 3 || lows.length < 3) return null;

  let swingHigh = highs[0], swingLow = lows[0];
  for (let i = 1; i < highs.length - 1; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1]) swingHigh = highs[i];
    if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1]) swingLow = lows[i];
  }

  if (!isValidNumber(swingHigh) || !isValidNumber(swingLow)) return null;
  const range = swingHigh - swingLow;
  const atrAdjustment = isValidNumber(atr) ? atr * 0.5 : 0;
  return {
    timeframe,
    levels: {
      '0.0': swingLow,
      '23.6': swingLow + range * 0.236 - atrAdjustment,
      '38.2': swingLow + range * 0.382 - atrAdjustment,
      '50.0': swingLow + range * 0.5,
      '61.8': swingLow + range * 0.618 + atrAdjustment,
      '78.6': swingLow + range * 0.786 + atrAdjustment,
      '100.0': swingHigh
    }
  };
}

function analyzeWyckoff(ohlcvDiario, ohlcv4h, volume24hAtual, volume24hAnterior) {
  const lastCandle = ohlcvDiario[ohlcvDiario.length - 1];
  const prevCandle = ohlcvDiario[ohlcvDiario.length - 2];
  const volumeIncreasing = isValidNumber(volume24hAtual) && isValidNumber(volume24hAnterior) && volume24hAtual > volume24hAnterior;
  const price = lastCandle[4];
  const prevPrice = prevCandle[4];
  const priceDirection = isValidNumber(price) && isValidNumber(prevPrice) ? (price > prevPrice ? "⬆️ Subindo" : "⬇️ Caindo") : "🔹 Indisponível";

  const closes = ohlcvDiario.slice(-200).map(c => c[4]).filter(isValidNumber);
  const ma50 = closes.slice(-50).length >= 50 ? closes.slice(-50).reduce((sum, c) => sum + c, 0) / 50 : null;
  const ma200 = closes.length >= 200 ? closes.reduce((sum, c) => sum + c, 0) / 200 : null;

  let wyckoffPhase = "Indefinida";
  let wyckoffAnalysis = "";

  if (volumeIncreasing && priceDirection === "⬆️ Subindo" && isValidNumber(ma50) && price > ma50) {
    wyckoffPhase = "Acumulação (Fase C) ou Mark-Up";
    wyckoffAnalysis = "📈 O preço está subindo com volume crescente, como se grandes players estivessem comprando na promoção antes de uma grande alta.";
  } else if (volumeIncreasing && priceDirection === "⬇️ Caindo" && isValidNumber(ma50) && price < ma50) {
    wyckoffPhase = "Distribuição (Fase C) ou Mark-Down";
    wyckoffAnalysis = "📉 O preço está caindo com volume elevado, sugerindo que grandes players estão vendendo suas posições.";
  } else if (!volumeIncreasing && isValidNumber(ma200) && price > ma200) {
    wyckoffPhase = "Acumulação (Fase A/B)";
    wyckoffAnalysis = "📊 O preço está acima da média de longo prazo com volume estável, como se o mercado estivesse se preparando para um movimento maior.";
  } else {
    wyckoffPhase = "Indefinida";
    wyckoffAnalysis = "⚖️ O mercado está em consolidação, como um carro parado no sinal, esperando o próximo movimento.";
  }

  return { phase: wyckoffPhase, analysis: wyckoffAnalysis };
}

function analyzeElliott(ohlcv4h, rsi4h) {
  const highs = ohlcv4h.map(c => c[2]).slice(-10).filter(isValidNumber);
  const lows = ohlcv4h.map(c => c[3]).slice(-10).filter(isValidNumber);
  const closes = ohlcv4h.map(c => c[4]).slice(-10).filter(isValidNumber);
  let waveAnalysis = "";
  let waveStatus = "Indefinida";

  if (closes.length < 2) return { status: waveStatus, analysis: "🔹 Dados insuficientes" };

  const lastPrice = closes[closes.length - 1];
  const prevPrice = closes[closes.length - 2];
  const fib = calculateFibonacciLevels(ohlcv4h, '4h');
  const isNear618 = fib && isValidNumber(lastPrice) && isValidNumber(fib.levels['61.8']) && Math.abs(lastPrice - fib.levels['61.8']) / lastPrice < 0.02;
  const rsiIncreasing = rsi4h && rsi4h.length >= 2 && isValidNumber(rsi4h[rsi4h.length - 1]) && isValidNumber(rsi4h[rsi4h.length - 2]) && rsi4h[rsi4h.length - 1] > rsi4h[rsi4h.length - 2];

  if (isValidNumber(lastPrice) && isValidNumber(prevPrice) && lastPrice > prevPrice && lastPrice >= Math.max(...highs) * 0.99 && isNear618 && rsiIncreasing) {
    waveStatus = "Onda Impulsiva (Possível Onda 3)";
    waveAnalysis = "📈 O preço está em uma forte onda de alta, como um trem ganhando velocidade, mirando alvos em 78.6% ou 100% de Fibonacci.";
  } else if (isValidNumber(lastPrice) && isValidNumber(prevPrice) && lastPrice < prevPrice && lastPrice <= Math.min(...lows) * 1.01) {
    waveStatus = "Onda Corretiva (Possível Onda A ou C)";
    waveAnalysis = "📉 O preço está em uma correção, como um carro desacelerando, com suportes prováveis em 38.2% ou 50% de Fibonacci.";
  } else {
    waveStatus = "Indefinida";
    waveAnalysis = "⚖️ O mercado está em consolidação, como uma pausa antes do próximo grande movimento.";
  }

  return { status: waveStatus, analysis: waveAnalysis };
}

function calculateRiskReward(buyTarget, sellTarget, stopLoss, price) {
  if (!isValidNumber(buyTarget) && !isValidNumber(sellTarget)) return null;
  if (isValidNumber(buyTarget)) {
    if (!isValidNumber(stopLoss) || !isValidNumber(price)) return null;
    const risk = buyTarget - stopLoss;
    const reward = isValidNumber(sellTarget) ? sellTarget - buyTarget : buyTarget * 0.05;
    return risk > 0 ? (reward / risk).toFixed(2) : null;
  } else {
    if (!isValidNumber(stopLoss) || !isValidNumber(price)) return null;
    const risk = stopLoss - sellTarget;
    const reward = isValidNumber(buyTarget) ? sellTarget - buyTarget : sellTarget * 0.05;
    return risk > 0 ? (reward / risk).toFixed(2) : null;
  }
}

function calculatePositionSize(risk, stopLossDistance) {
  if (!isValidNumber(risk) || !isValidNumber(stopLossDistance) || stopLossDistance <= 0) return null;
  return ((CAPITAL * RISK_PER_TRADE) / stopLossDistance).toFixed(4);
}

function determineTargets(fibLevelsDaily, fibLevels4h, zonas, rsi1hVal, rsi15mVal, cvd15mStatus, obv15mStatus, macd1h, bb1h, keltner1h, vwap1h, pivotPoints, estocasticoD, estocastico4h, wyckoff, elliott, orderBook, lsrData, atr, price) {
  if (!fibLevelsDaily || !fibLevels4h || !isValidNumber(atr) || !isValidNumber(price)) {
    return { buyTargets: [], sellTargets: [], buyExplanations: [], sellExplanations: [] };
  }

  const buyTargets = [], sellTargets = [], buyExplanations = [], sellExplanations = [];

  const fibLevelsCombined = {
    '23.6': [fibLevelsDaily.levels['23.6'], fibLevels4h.levels['23.6']].filter(isValidNumber),
    '38.2': [fibLevelsDaily.levels['38.2'], fibLevels4h.levels['38.2']].filter(isValidNumber),
    '50.0': [fibLevelsDaily.levels['50.0'], fibLevels4h.levels['50.0']].filter(isValidNumber),
    '61.8': [fibLevelsDaily.levels['61.8'], fibLevels4h.levels['61.8']].filter(isValidNumber),
    '78.6': [fibLevelsDaily.levels['78.6'], fibLevels4h.levels['78.6']].filter(isValidNumber)
  };

  const potentialBuyLevels = [
    { level: fibLevelsCombined['23.6'].length > 0 ? fibLevelsCombined['23.6'].reduce((sum, val) => sum + val, 0) / fibLevelsCombined['23.6'].length : null, label: '23.6% (Média D/4h)' },
    { level: fibLevelsCombined['38.2'].length > 0 ? fibLevelsCombined['38.2'].reduce((sum, val) => sum + val, 0) / fibLevelsCombined['38.2'].length : null, label: '38.2% (Média D/4h)' },
    { level: fibLevelsCombined['50.0'].length > 0 ? fibLevelsCombined['50.0'].reduce((sum, val) => sum + val, 0) / fibLevelsCombined['50.0'].length : null, label: '50.0% (Média D/4h)' }
  ].filter(l => isValidNumber(l.level) && l.level < price && l.level > price - atr * ATR_MULTIPLIER_FILTER);

  const potentialSellLevels = [
    { level: fibLevelsCombined['61.8'].length > 0 ? fibLevelsCombined['61.8'].reduce((sum, val) => sum + val, 0) / fibLevelsCombined['61.8'].length : null, label: '61.8% (Média D/4h)' },
    { level: fibLevelsCombined['78.6'].length > 0 ? fibLevelsCombined['78.6'].reduce((sum, val) => sum + val, 0) / fibLevelsCombined['78.6'].length : null, label: '78.6% (Média D/4h)' }
  ].filter(l => isValidNumber(l.level) && l.level > price && l.level < price + atr * ATR_MULTIPLIER_FILTER);

  potentialBuyLevels.forEach(({ level, label }) => {
    let score = 0, relevance = [];

    if (zonas.buyLiquidityZones.some(z => isValidNumber(z) && isValidNumber(level) && Math.abs(z - level) / level < 0.01)) {
      score += 1;
      relevance.push("🟢 Coincide com uma zona de liquidez de compra, indicando forte suporte.");
    }
    if (isValidNumber(rsi15mVal) && rsi15mVal < 40 || isValidNumber(rsi1hVal) && rsi1hVal < 40) {
      score += 1;
      relevance.push("📉 RSI está como um elástico esticado para baixo, sugerindo possível reversão.");
    }
    if (cvd15mStatus === "⬆️ Bullish" || obv15mStatus === "⬆️ Bullish") {
      score += 1;
      relevance.push("📈 Volume acumulado (CVD/OBV) mostra pressão compradora.");
    }
    if (macd1h?.status === "⬆️ Bullish") {
      score += 1;
      relevance.push("📊 MACD indica momentum de alta.");
    }
    if (bb1h?.status.includes("Abaixo da banda inferior")) {
      score += 1;
      relevance.push("📈 Preço abaixo da banda inferior de Bollinger, sugerindo sobrevenda.");
    }
    if (keltner1h && isValidNumber(keltner1h.lower) && isValidNumber(level) && Math.abs(level - keltner1h.lower) / level < 0.005) {
      score += 1;
      relevance.push("🟢 Coincide com a banda inferior de Keltner, reforçando o suporte.");
    }
    if (isValidNumber(vwap1h) && isValidNumber(level) && Math.abs(level - vwap1h) / level < 0.005) {
      score += 1;
      relevance.push("🟢 Próximo ao VWAP, sugerindo suporte dinâmico institucional.");
    }
    if (pivotPoints && (isValidNumber(pivotPoints.s1) && isValidNumber(level) && Math.abs(level - pivotPoints.s1) / level < 0.005 || isValidNumber(pivotPoints.s2) && isValidNumber(level) && Math.abs(level - pivotPoints.s2) / level < 0.005)) {
      score += 1;
      relevance.push("🟢 Confluência com nível de Pivot (S1/S2), reforçando o suporte.");
    }
    if ((estocasticoD?.k && estocasticoD.k < 25 && estocasticoD.k > estocasticoD.d) || (estocastico4h?.k && estocastico4h.k < 25 && estocastico4h.k > estocastico4h.d)) {
      score += 1;
      relevance.push("📊 Estocástico em sobrevenda com cruzamento de alta, reforçando o suporte.");
    }
    if (wyckoff.phase.includes("Acumulação")) {
      score += 1;
      relevance.push("📚 Fase de acumulação (Wyckoff) sugere que grandes players estão comprando.");
    }
    if (elliott.status.includes("Onda Corretiva")) {
      score += 1;
      relevance.push("🌊 Onda corretiva (Elliott) indica possível fim de uma correção.");
    }
    if (orderBook.totalBidVolume > orderBook.totalAskVolume * 1.2) {
      score += 1;
      relevance.push("📖 Maior volume de ordens de compra no order book, reforçando o suporte.");
    }
    if (isValidNumber(lsrData.account.value) && lsrData.account.value > 1.2 || isValidNumber(lsrData.position.value) && lsrData.position.value > 1.2) {
      score += 1;
      relevance.push("📉 LSR mostra maior interesse comprador.");
    }

    if (score >= 3) {
      const stopLoss = level - atr * ATR_MULTIPLIER_STOP;
      const riskReward = calculateRiskReward(level, potentialSellLevels[0]?.level, stopLoss, price);
      const positionSize = calculatePositionSize(CAPITAL * RISK_PER_TRADE, level - stopLoss);
      buyTargets.push({ level, stopLoss, riskReward, positionSize });
      buyExplanations.push(`*${label} (${isValidNumber(level) ? level.toFixed(2) : '--'})*: Confiança ${score}/10. Stop-loss: ${isValidNumber(stopLoss) ? stopLoss.toFixed(2) : '--'} (baseado em ${ATR_MULTIPLIER_STOP}x ATR). Risco/Retorno: ${riskReward || '--'}:1. Tamanho da posição: ${positionSize || '--'} BTC. ${relevance.join(' ')}`);
    }
  });

  potentialSellLevels.forEach(({ level, label }) => {
    let score = 0, relevance = [];

    if (zonas.sellLiquidityZones.some(z => isValidNumber(z) && isValidNumber(level) && Math.abs(z - level) / level < 0.01)) {
      score += 1;
      relevance.push("🔴 Coincide com uma zona de liquidez de venda, indicando forte resistência.");
    }
    if (isValidNumber(rsi15mVal) && rsi15mVal > 60 || isValidNumber(rsi1hVal) && rsi1hVal > 60) {
      score += 1;
      relevance.push("📉 RSI está como um elástico esticado para cima, sugerindo possível reversão.");
    }
    if (cvd15mStatus === "⬇️ Bearish" || obv15mStatus === "⬇️ Bearish") {
      score += 1;
      relevance.push("📈 Volume acumulado (CVD/OBV) mostra pressão vendedora.");
    }
    if (macd1h?.status === "⬇️ Bearish") {
      score += 1;
      relevance.push("📊 MACD indica momentum de baixa.");
    }
    if (bb1h?.status.includes("Acima da banda superior")) {
      score += 1;
      relevance.push("📈 Preço acima da banda superior de Bollinger, sugerindo sobrecompra.");
    }
    if (keltner1h && isValidNumber(keltner1h.upper) && isValidNumber(level) && Math.abs(level - keltner1h.upper) / level < 0.005) {
      score += 1;
      relevance.push("🔴 Coincide com a banda superior de Keltner, reforçando a resistência.");
    }
    if (isValidNumber(vwap1h) && isValidNumber(level) && Math.abs(level - vwap1h) / level < 0.005) {
      score += 1;
      relevance.push("🔴 Próximo ao VWAP, sugerindo resistência dinâmica institucional.");
    }
    if (pivotPoints && (isValidNumber(pivotPoints.r1) && isValidNumber(level) && Math.abs(level - pivotPoints.r1) / level < 0.005 || isValidNumber(pivotPoints.r2) && isValidNumber(level) && Math.abs(level - pivotPoints.r2) / level < 0.005)) {
      score += 1;
      relevance.push("🔴 Confluência com nível de Pivot (R1/R2), reforçando a resistência.");
    }
    if ((estocasticoD?.k && estocasticoD.k > 75 && estocasticoD.k < estocasticoD.d) || (estocastico4h?.k && estocastico4h.k > 75 && estocastico4h.k < estocastico4h.d)) {
      score += 1;
      relevance.push("📊 Estocástico em sobrecompra com cruzamento de baixa, reforçando a resistência.");
    }
    if (wyckoff.phase.includes("Distribuição")) {
      score += 1;
      relevance.push("📚 Fase de distribuição (Wyckoff) sugere que grandes players estão vendendo.");
    }
    if (elliott.status.includes("Onda Impulsiva")) {
      score += 1;
      relevance.push("🌊 Onda impulsiva (Elliott) indica possível teste de resistência.");
    }
    if (orderBook.totalAskVolume > orderBook.totalBidVolume * 1.2) {
      score += 1;
      relevance.push("📖 Maior volume de ordens de venda no order book, reforçando a resistência.");
    }
    if (isValidNumber(lsrData.account.value) && lsrData.account.value < 0.8 || isValidNumber(lsrData.position.value) && lsrData.position.value < 0.8) {
      score += 1;
      relevance.push("📉 LSR mostra maior interesse vendedor.");
    }

    if (score >= 3) {
      const stopLoss = level + atr * ATR_MULTIPLIER_STOP;
      const riskReward = calculateRiskReward(potentialBuyLevels[0]?.level, level, stopLoss, price);
      const positionSize = calculatePositionSize(CAPITAL * RISK_PER_TRADE, stopLoss - level);
      sellTargets.push({ level, stopLoss, riskReward, positionSize });
      sellExplanations.push(`*${label} (${isValidNumber(level) ? level.toFixed(2) : '--'})*: Confiança ${score}/10. Stop-loss: ${isValidNumber(stopLoss) ? stopLoss.toFixed(2) : '--'} (baseado em ${ATR_MULTIPLIER_STOP}x ATR). Risco/Retorno: ${riskReward || '--'}:1. Tamanho da posição: ${positionSize || '--'} BTC. ${relevance.join(' ')}`);
    }
  });

  return { buyTargets, sellTargets, buyExplanations, sellExplanations };
}

function generateSummary(price, rsi1hVal, wyckoff, elliott, targets, backtestSuccess, atr, keltner1h, vwap1h, pivotPoints) {
  let sentiment = "Neutro ⚖️";
  if (isValidNumber(rsi1hVal) && rsi1hVal < 40 && wyckoff.phase.includes("Acumulação") && targets.buyTargets.length > 0) {
    sentiment = "Bullish 🟢";
  } else if (isValidNumber(rsi1hVal) && rsi1hVal > 60 && wyckoff.phase.includes("Distribuição") && targets.sellTargets.length > 0) {
    sentiment = "Bearish 🔴";
  }

  const recommendation = targets.buyTargets.length > 0
    ? `Considere comprar em ${isValidNumber(targets.buyTargets[0].level) ? targets.buyTargets[0].level.toFixed(2) : '--'} com stop-loss em ${isValidNumber(targets.buyTargets[0].stopLoss) ? targets.buyTargets[0].stopLoss.toFixed(2) : '--'} (baseado em ${ATR_MULTIPLIER_STOP}x ATR). Risco/Retorno: ${targets.buyTargets[0].riskReward || '--'}:1. Tamanho da posição: ${targets.buyTargets[0].positionSize || '--'} BTC.`
    : targets.sellTargets.length > 0
      ? `Considere vender em ${isValidNumber(targets.sellTargets[0].level) ? targets.sellTargets[0].level.toFixed(2) : '--'} com stop-loss em ${isValidNumber(targets.sellTargets[0].stopLoss) ? targets.sellTargets[0].stopLoss.toFixed(2) : '--'} (baseado em ${ATR_MULTIPLIER_STOP}x ATR). Risco/Retorno: ${targets.sellTargets[0].riskReward || '--'}:1. Tamanho da posição: ${targets.sellTargets[0].positionSize || '--'} BTC.`
      : "Aguarde por sinais mais claros antes de agir.";

  return `📝 *Resumo do Mercado*\n` +
         `Sentimento: ${sentiment}\n` +
         `Recomendação: ${recommendation}\n` +
         `Volatilidade (ATR 1H): ${isValidNumber(atr) ? atr.toFixed(2) : '--'} USDT\n` +
         `Keltner Channels 1H: ${keltner1h ? keltner1h.status : '--'}\n` +
         `VWAP 1H: ${isValidNumber(vwap1h) ? format(price, vwap1h) : '--'} USDT\n` +
         `Pivot Points: PP ${pivotPoints?.pivot || '--'}, S1 ${pivotPoints?.s1 || '--'}, R1 ${pivotPoints?.r1 || '--'}\n` +
         `Confiabilidade dos alvos (histórico): ${isValidNumber(backtestSuccess) ? backtestSuccess : '--'}% dos alvos de Fibonacci foram atingidos nos últimos 30 dias.\n`;
}

// ================= FUNÇÃO PRINCIPAL ================= //
async function sendStatusReport() {
  try {
    let texto = `🤖 *Análise Titanium I.A. ativo : BTCUSDT* - ${new Date().toLocaleString('pt-BR')}\n\n`;

    const symbol = PAR_MONITORADO;

    // Dados OHLCV
    const ohlcv1h = await exchangeSpot.fetchOHLCV(symbol, '1h', undefined, 20);
    const ohlcv15m = await exchangeSpot.fetchOHLCV(symbol, '15m', undefined, 20);
    const ohlcv3m = await exchangeSpot.fetchOHLCV(symbol, '3m', undefined, 10);
    const ohlcvDiario = await exchangeSpot.fetchOHLCV(symbol, '1d', undefined, 200);
    const ohlcv4h = await exchangeSpot.fetchOHLCV(symbol, '4h', undefined, 20);

    if (!ohlcv1h || !ohlcv3m || !ohlcv15m || !ohlcvDiario || !ohlcv4h || ohlcv1h.length === 0 || ohlcv3m.length === 0 || ohlcv15m.length === 0 || ohlcvDiario.length === 0 || ohlcv4h.length === 0) {
      logger.warn(`Dados insuficientes para ${symbol}`);
      texto += `⚠️ *${symbol}*: Dados insuficientes\n\n`;
      await bot.api.sendMessage(TELEGRAM_CHAT_ID, texto, { parse_mode: 'Markdown' });
      return;
    }

    // Validar integridade dos dados OHLCV
    const validateOHLCV = (data, timeframe) => data.every(c => c.length >= 6 && c.slice(1, 6).every(isValidNumber));
    if (!validateOHLCV(ohlcv1h, '1h') || !validateOHLCV(ohlcv15m, '15m') || !validateOHLCV(ohlcv3m, '3m') || !validateOHLCV(ohlcvDiario, '1d') || !validateOHLCV(ohlcv4h, '4h')) {
      logger.warn(`Dados OHLCV inválidos para ${symbol}`);
      texto += `⚠️ *${symbol}*: Dados OHLCV inválidos\n\n`;
      await bot.api.sendMessage(TELEGRAM_CHAT_ID, texto, { parse_mode: 'Markdown' });
      return;
    }

    // Mapear OHLCV para objetos com nomeação clara
    const mapOHLCV = data => data.map(c => ({
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5]
    }));

    const ohlcv1hMapped = mapOHLCV(ohlcv1h);
    const ohlcv15mMapped = mapOHLCV(ohlcv15m);
    const ohlcv3mMapped = mapOHLCV(ohlcv3m);
    const ohlcvDiarioMapped = mapOHLCV(ohlcvDiario);
    const ohlcv4hMapped = mapOHLCV(ohlcv4h);

    // Indicadores e análises
    const volume1hAtual = ohlcv1hMapped[ohlcv1hMapped.length - 1].volume;
    const volume1hAnterior = ohlcv1hMapped[ohlcv1hMapped.length - 2].volume;
    const volume1hStatus = isValidNumber(volume1hAtual) && isValidNumber(volume1hAnterior) && volume1hAnterior > 0
      ? volume1hAtual > volume1hAnterior
        ? `⬆️ Subindo (+${((volume1hAtual - volume1hAnterior) / volume1hAnterior * 100).toFixed(2)}%)`
        : `⬇️ Caindo (${((volume1hAnterior - volume1hAtual) / volume1hAnterior * 100).toFixed(2)}%)`
      : "🔹 Indisponível";

    const volume24hAtual = ohlcvDiarioMapped[ohlcvDiarioMapped.length - 1].volume;
    const volume24hAnterior = ohlcvDiarioMapped[ohlcvDiarioMapped.length - 2].volume;
    const volume24hStatus = isValidNumber(volume24hAtual) && isValidNumber(volume24hAnterior) && volume24hAnterior > 0
      ? volume24hAtual > volume24hAnterior
        ? `⬆️ Subindo (+${((volume24hAtual - volume24hAnterior) / volume24hAnterior * 100).toFixed(2)}%)`
        : `⬇️ Caindo (${((volume24hAnterior - volume24hAtual) / volume24hAnterior * 100).toFixed(2)}%)`
      : "🔹 Indisponível";

    const lsrData = await fetchLSR(symbol);
    const oi5m = await fetchOpenInterest(symbol, '5m');
    const oi15m = await fetchOpenInterest(symbol, '15m');
    const oi1h = await fetchOpenInterest(symbol, '1h');
    const totalOI = await fetchTotalOpenInterest(symbol);
    const fundingRateData = await fetchFundingRate(symbol);
    const fundingRate = isValidNumber(fundingRateData.current) ? (fundingRateData.current * 100).toFixed(4) : '--';
    const orderBook = await fetchOrderBook(symbol);
    const correlation = await fetchCorrelation(symbol);
    const backtestSuccess = await backtestTargets(symbol);

    const price = ohlcv1hMapped[ohlcv1hMapped.length - 1].close;

    const atr = calculateATR(ohlcv1hMapped);
    if (!isValidNumber(atr)) {
      logger.warn('ATR não calculado, pulando relatório');
      texto += `⚠️ *${symbol}*: ATR indisponível\n\n`;
      await bot.api.sendMessage(TELEGRAM_CHAT_ID, texto, { parse_mode: 'Markdown' });
      return;
    }

    const estocasticoD = calculateStochastic(ohlcvDiarioMapped);
    const estocastico4h = calculateStochastic(ohlcv4hMapped);
    const zonas = detectarQuebraEstrutura(ohlcv15mMapped);
    const rsi1h = calculateRSI(ohlcv1hMapped);
    const rsi15m = calculateRSI(ohlcv15mMapped);
    const rsi4h = calculateRSI(ohlcv4hMapped);
    const cvd15m = calculateCVD(ohlcv15mMapped);
    const obv15m = calculateOBV(ohlcv15mMapped);
    const macd1h = calculateMACD(ohlcv1hMapped);
    const bb1h = calculateBollingerBands(ohlcv1hMapped);
    const keltner1h = calculateKeltnerChannels(ohlcv1hMapped);
    const vwap1h = calculateVWAP(ohlcv1hMapped);
    const pivotPoints = calculatePivotPoints(ohlcvDiarioMapped);

    const cvd15mStatus = isValidNumber(cvd15m) ? (cvd15m > 0 ? "⬆️ Bullish" : cvd15m < 0 ? "⬇️ Bearish" : "➡️ Neutro") : "🔹 Indisponível";
    const obv15mStatus = isValidNumber(obv15m) ? (obv15m > 0 ? "⬆️ Bullish" : obv15m < 0 ? "⬇️ Bearish" : "➡️ Neutro") : "🔹 Indisponível";
    const rsi1hVal = rsi1h && rsi1h.length ? rsi1h[rsi1h.length - 1].toFixed(2) : '--';
    const rsi15mVal = rsi15m && rsi15m.length ? rsi15m[rsi15m.length - 1].toFixed(2) : '--';
    const rsi1hEmoji = isValidNumber(rsi1hVal) ? (rsi1hVal > 60 ? "🔴" : rsi1hVal < 40 ? "🟢" : "") : "";

    if (!ultimoEstocastico[symbol]) ultimoEstocastico[symbol] = {};
    const kDAnterior = ultimoEstocastico[symbol].kD || (estocasticoD?.k ?? 0);
    const dDAnterior = ultimoEstocastico[symbol].dD || (estocasticoD?.d ?? 0);
    const k4hAnterior = ultimoEstocastico[symbol].k4h || (estocastico4h?.k ?? 0);
    const d4hAnterior = ultimoEstocastico[symbol].d4h || (estocastico4h?.d ?? 0);

    ultimoEstocastico[symbol].kD = estocasticoD?.k;
    ultimoEstocastico[symbol].dD = estocasticoD?.d;
    ultimoEstocastico[symbol].k4h = estocastico4h?.k;
    ultimoEstocastico[symbol].d4h = estocastico4h?.d;

    const direcaoKD = getSetaDirecao(estocasticoD?.k, kDAnterior);
    const direcaoDD = getSetaDirecao(estocasticoD?.d, dDAnterior);
    const direcaoK4h = getSetaDirecao(estocastico4h?.k, k4hAnterior);
    const direcaoD4h = getSetaDirecao(estocastico4h?.d, d4hAnterior);

    const kDEmoji = getStochasticEmoji(estocasticoD?.k);
    const dDEmoji = getStochasticEmoji(estocasticoD?.d);
    const k4hEmoji = getStochasticEmoji(estocastico4h?.k);
    const d4hEmoji = getStochasticEmoji(estocastico4h?.d);

    const bidText = orderBook.bids.length > 0
      ? orderBook.bids.map(bid => `${format(price, bid.price)} (${isValidNumber(bid.amount) ? bid.amount.toFixed(2) : '--'} BTC)`).join(', ')
      : '--';
    const askText = orderBook.asks.length > 0
      ? orderBook.asks.map(ask => `${format(price, ask.price)} (${isValidNumber(ask.amount) ? ask.amount.toFixed(2) : '--'} BTC)`).join(', ')
      : '--';

    const wyckoff = analyzeWyckoff(ohlcvDiarioMapped, ohlcv4hMapped, volume24hAtual, volume24hAnterior);
    const elliott = analyzeElliott(ohlcv4hMapped, rsi4h);
    const fibLevelsDaily = calculateFibonacciLevels(ohlcvDiarioMapped, '1d', atr);
    const fibLevels4h = calculateFibonacciLevels(ohlcv4hMapped, '4h', atr);
    const targets = determineTargets(fibLevelsDaily, fibLevels4h, zonas, rsi1hVal, rsi15mVal, cvd15mStatus, obv15mStatus, macd1h, bb1h, keltner1h, vwap1h, pivotPoints, estocasticoD, estocastico4h, wyckoff, elliott, orderBook, lsrData, atr, price);
    const summary = generateSummary(price, rsi1hVal, wyckoff, elliott, targets, backtestSuccess, atr, keltner1h, vwap1h, pivotPoints);

    // Montar relatório
    texto += summary +
      `*${symbol}*\n` +
      `💲 Preço: ${isValidNumber(price) ? format(price, price) : '--'}\n` +
      `📊 Volume 1H: ${volume1hStatus}\n` +
      `📊 Volume 24H: ${volume24hStatus}\n` +
      `📉 LSR Contas: ${isValidNumber(lsrData.account.value) ? lsrData.account.value.toFixed(2) : '--'} ${lsrData.account.status} (${lsrData.account.percentChange}%)\n` +
      `📉 LSR Posições: ${isValidNumber(lsrData.position.value) ? lsrData.position.value.toFixed(2) : '--'} ${lsrData.position.status} (${lsrData.position.percentChange}%)\n` +
      `📈 OI Total: ${isValidNumber(totalOI) ? `$${parseFloat(totalOI).toLocaleString('en-US')}` : '--'} USDT\n` +
      `📈 OI 5m: ${isValidNumber(oi5m.value) ? oi5m.value.toFixed(2) : '--'} BTC ${oi5m.status}\n` +
      `📈 OI 15m: ${isValidNumber(oi15m.value) ? oi15m.value.toFixed(2) : '--'} BTC ${oi15m.status}\n` +
      `📈 OI 1h: ${isValidNumber(oi1h.value) ? oi1h.value.toFixed(2) : '--'} BTC ${oi1h.status}\n` +
      `📊 Funding Rate: ${fundingRate}% ${fundingRateData.status}\n` +
      `📈 RSI 1H: ${rsi1hVal} ${rsi1hEmoji}\n` +
      `📈 RSI 15M: ${rsi15mVal}\n` +
      `📊 CVD 15M: ${isValidNumber(cvd15m) ? cvd15m.toFixed(2) : '--'} ${cvd15mStatus}\n` +
      `📊 OBV 15M: ${isValidNumber(obv15m) ? obv15m.toFixed(2) : '--'} ${obv15mStatus}\n` +
      `📊 MACD 1H: ${macd1h ? macd1h.status : '--'}\n` +
      `📊 Bollinger Bands 1H: ${bb1h ? bb1h.status : '--'}\n` +
      `📊 Keltner Channels 1H: ${keltner1h ? keltner1h.status : '--'}\n` +
      `📊 VWAP 1H: ${isValidNumber(vwap1h) ? format(price, vwap1h) : '--'} USDT\n` +
      `📊 Pivot Points: PP ${pivotPoints?.pivot || '--'}, S1 ${pivotPoints?.s1 || '--'}, S2 ${pivotPoints?.s2 || '--'}, R1 ${pivotPoints?.r1 || '--'}, R2 ${pivotPoints?.r2 || '--'}\n` +
      `📊 Stoch D %K: ${estocasticoD?.k ?? '--'} ${kDEmoji} ${direcaoKD}\n` +
      `📊 Stoch D %D: ${estocasticoD?.d ?? '--'} ${dDEmoji} ${direcaoDD}\n` +
      `📊 Stoch 4H %K: ${estocastico4h?.k ?? '--'} ${k4hEmoji} ${direcaoK4h}\n` +
      `📊 Stoch 4H %D: ${estocastico4h?.d ?? '--'} ${d4hEmoji} ${direcaoD4h}\n` +
      `🔹 Estrutura de Baixa: ${isValidNumber(zonas.estruturaBaixa) ? format(price, zonas.estruturaBaixa) : '--'}\n` +
      `🔹 Rompimento de Alta: ${isValidNumber(zonas.estruturaAlta) ? format(price, zonas.estruturaAlta) : '--'}\n` +
      `📖 *Order Book (Top 5)*\n` +
      `🟢 Bids: ${bidText}\n` +
      `🔴 Asks: ${askText}\n` +
      `📊 Volume Bids: ${isValidNumber(orderBook.totalBidVolume) ? orderBook.totalBidVolume.toFixed(2) : '--'} BTC | Asks: ${isValidNumber(orderBook.totalAskVolume) ? orderBook.totalAskVolume.toFixed(2) : '--'} BTC\n` +
      `📊 Zona de Suporte (Order Book): ${isValidNumber(orderBook.supportZone) ? format(price, orderBook.supportZone) : '--'}\n` +
      `📊 Zona de Resistência (Order Book): ${isValidNumber(orderBook.resistanceZone) ? format(price, orderBook.resistanceZone) : '--'}\n` +
      `🔗 Correlação com ETH: ${correlation}\n` +
      `\n📚 *Análise Wyckoff*\n` +
      `Fase: ${wyckoff.phase}\n` +
      `${wyckoff.analysis}\n` +
      `\n🌊 *Análise Elliott Wave*\n` +
      `Status: ${elliott.status}\n` +
      `${elliott.analysis}\n` +
      `\n🎯 *Alvos de Compra (Suportes)*\n` +
      (targets.buyExplanations.length > 0 ? targets.buyExplanations.join('\n') : 'Nenhum alvo de compra identificado.\n') +
      `\n🎯 *Alvos de Venda (Resistências)*\n` +
      (targets.sellExplanations.length > 0 ? targets.sellExplanations.join('\n') : 'Nenhum alvo de venda identificado.\n');

    // Enviar relatório como texto
    await bot.api.sendMessage(TELEGRAM_CHAT_ID, texto, { parse_mode: 'Markdown' });
  } catch (e) {
    logger.error(`Erro no relatório de mercado: ${e.message}`, { stack: e.stack });
  }
}

// Função principal
async function main() {
  logger.info('Iniciando Análise BTCUSDT');
  try {
    await bot.api.sendMessage(TELEGRAM_CHAT_ID, '🤖 Titanium - Análise BTCUSDT');
    await sendStatusReport(); // Envia relatório inicial
    setInterval(sendStatusReport, INTERVALO_RELATORIO_15M_MS); // A cada 15 minutos
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`, { stack: e.stack });
  }
}

main();
