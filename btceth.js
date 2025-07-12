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

// ================= FUNÇÕES DE INDICADORES ================= //
function calculateRSI(data) {
  if (!data || data.length < rsiPeriod + 1) return null;
  return TechnicalIndicators.RSI.calculate({
    period: rsiPeriod,
    values: data.map(d => d.close)
  });
}

function calculateCVD(data) {
  let cvd = 0;
  for (let i = 1; i < data.length; i++) {
    const curr = data[i];
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
    if (curr[4] > prev[4]) obv += curr[5];
    else if (curr[4] < prev[4]) obv -= curr[5];
  }
  return obv;
}

function calculateMACD(data) {
  const macd = TechnicalIndicators.MACD.calculate({
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    values: data.map(d => d.close)
  });
  if (!macd || macd.length === 0) return null;
  const last = macd[macd.length - 1];
  return {
    macd: last.MACD.toFixed(2),
    signal: last.signal.toFixed(2),
    histogram: last.histogram.toFixed(2),
    status: last.MACD > last.signal ? "⬆️ Bullish" : "⬇️ Bearish"
  };
}

function calculateBollingerBands(data) {
  const bb = TechnicalIndicators.BollingerBands.calculate({
    period: 20,
    stdDev: 2,
    values: data.map(d => d.close)
  });
  if (!bb || bb.length === 0) return null;
  const last = bb[bb.length - 1];
  return {
    upper: last.upper.toFixed(2),
    middle: last.middle.toFixed(2),
    lower: last.lower.toFixed(2),
    status: data[data.length - 1].close > last.upper ? "🔴 Acima da banda superior" :
            data[data.length - 1].close < last.lower ? "🟢 Abaixo da banda inferior" : "⚖️ Dentro das bandas"
  };
}

function calculateATR(data, period = ATR_PERIOD) {
  if (!data || data.length < period + 1) return null;
  const atr = TechnicalIndicators.ATR.calculate({
    high: data.map(d => d.high),
    low: data.map(d => d.low),
    close: data.map(d => d.close),
    period
  });
  return atr && atr.length > 0 ? atr[atr.length - 1] : null;
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

  const highs = ohlcv15m.map(c => c.high).filter(h => !isNaN(h) && h !== null);
  const lows = ohlcv15m.map(c => c.low).filter(l => !isNaN(l) && l !== null);
  const volumes = ohlcv15m.map(c => c.volume).filter(v => !isNaN(v) && v !== null);

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
    if (candle.volume >= volumeThreshold && !isNaN(candle.low) && !isNaN(candle.high)) {
      if (candle.low <= minLow * 1.01) {
        buyLiquidityZones.push(candle.low);
      }
      if (candle.high >= maxHigh * 0.99) {
        sellLiquidityZones.push(candle.high);
      }
    }
  });

  const uniqueBuyZones = [...new Set(buyLiquidityZones.filter(z => !isNaN(z)).sort((a, b) => b - a))].slice(0, 2);
  const uniqueSellZones = [...new Set(sellLiquidityZones.filter(z => !isNaN(z)).sort((a, b) => a - b))].slice(0, 2);

  return {
    estruturaAlta: isNaN(maxHigh) ? 0 : maxHigh,
    estruturaBaixa: isNaN(minLow) ? 0 : minLow,
    buyLiquidityZones: uniqueBuyZones.length > 0 ? uniqueBuyZones : [minLow].filter(z => !isNaN(z)),
    sellLiquidityZones: uniqueSellZones.length > 0 ? uniqueSellZones : [maxHigh].filter(z => !isNaN(z))
  };
}

function calculateStochastic(data, periodK = 5, smoothK = 3, periodD = 3) {
  if (!data || data.length < periodK + smoothK + periodD - 2) {
    logger.warn(`Dados insuficientes para calcular estocástico: ${data?.length || 0} velas`);
    return null;
  }

  const highs = data.map(c => c.high).filter(h => !isNaN(h) && h !== null);
  const lows = data.map(c => c.low).filter(l => !isNaN(l) && l !== null);
  const closes = data.map(c => c.close).filter(cl => !isNaN(cl) && cl !== null);

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
    k: parseFloat(lastResult.k.toFixed(2)),
    d: parseFloat(lastResult.d.toFixed(2))
  };
}

function getStochasticEmoji(value) {
  if (!value) return "";
  return value < 10 ? "🔵" :
         value < 25 ? "🟢" :
         value <= 55 ? "🟡" :
         value <= 70 ? "🟠" :
         value <= 80 ? "🔴" :
         "💥";
}

function getSetaDirecao(current, previous) {
  if (!current || !previous) return "➡️";
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
      const percentChange = previousOI > 0 ? ((currentOI - previousOI) / previousOI * 100).toFixed(2) : 0;
      await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
      return {
        value: currentOI,
        status: currentOI > previousOI ? `⬆️ Subindo (+${percentChange}%)` : `⬇️ Caindo (${percentChange}%)`,
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
    return res.data && res.data.sumOpenInterestValue ? parseFloat(res.data.sumOpenInterestValue).toFixed(2) : null;
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

    const bids = orderBook.bids.map(([price, amount]) => ({ price, amount })).slice(0, 5);
    const asks = orderBook.asks.map(([price, amount]) => ({ price, amount })).slice(0, 5);
    const totalBidVolume = bids.reduce((sum, bid) => sum + bid.amount, 0);
    const totalAskVolume = asks.reduce((sum, ask) => sum + ask.amount, 0);

    const significantBids = bids.filter(b => b.amount > totalBidVolume * 0.1);
    const significantAsks = asks.filter(a => a.amount > totalAskVolume * 0.1);
    const supportZone = significantBids.length > 0 ? significantBids[0].price : bids[0].price;
    const resistanceZone = significantAsks.length > 0 ? significantAsks[0].price : asks[0].price;

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
        current: currentFunding,
        status: currentFunding > previousFunding ? "⬆️ Subindo" : "⬇️ Caindo"
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
    const btcCloses = btcData.map(c => c[4]);
    const ethCloses = ethData.map(c => c[4]);

    const meanBtc = btcCloses.reduce((sum, val) => sum + val, 0) / btcCloses.length;
    const meanEth = ethCloses.reduce((sum, val) => sum + val, 0) / ethCloses.length;

    let covariance = 0, stdBtc = 0, stdEth = 0;
    for (let i = 0; i < btcCloses.length; i++) {
      covariance += (btcCloses[i] - meanBtc) * (ethCloses[i] - meanEth);
      stdBtc += Math.pow(btcCloses[i] - meanBtc, 2);
      stdEth += Math.pow(ethCloses[i] - meanEth, 2);
    }

    const correlation = covariance / Math.sqrt(stdBtc * stdEth);
    return correlation.toFixed(2) > 0.7 ? "🟢 Alta correlação com ETH" : "⚖️ Baixa correlação com ETH";
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
  const highs = ohlcv.map(c => c[2]).filter(h => !isNaN(h) && h !== null);
  const lows = ohlcv.map(c => c[3]).filter(l => !isNaN(l) && l !== null);
  if (highs.length < 3 || lows.length < 3) return null;

  // Identificar swing high/low
  let swingHigh = highs[0], swingLow = lows[0];
  for (let i = 1; i < highs.length - 1; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i + 1]) swingHigh = highs[i];
    if (lows[i] < lows[i - 1] && lows[i] < lows[i + 1]) swingLow = lows[i];
  }

  const range = swingHigh - swingLow;
  const atrAdjustment = atr ? atr * 0.5 : 0; // Ajuste de 0.5x ATR para expandir/contraí níveis
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
  const volumeIncreasing = volume24hAtual > volume24hAnterior;
  const price = lastCandle[4];
  const prevPrice = prevCandle[4];
  const priceDirection = price > prevPrice ? "⬆️ Subindo" : "⬇️ Caindo";

  // Médias móveis
  const ma50 = ohlcvDiario.slice(-50).reduce((sum, c) => sum + c[4], 0) / 50;
  const ma200 = ohlcvDiario.slice(-200).reduce((sum, c) => sum + c[4], 0) / 200;

  let wyckoffPhase = "Indefinida";
  let wyckoffAnalysis = "";

  if (volumeIncreasing && priceDirection === "⬆️ Subindo" && price > ma50) {
    wyckoffPhase = "Acumulação (Fase C) ou Mark-Up";
    wyckoffAnalysis = "📈 O preço está subindo com volume crescente, como se grandes players estivessem comprando na promoção antes de uma grande alta.";
  } else if (volumeIncreasing && priceDirection === "⬇️ Caindo" && price < ma50) {
    wyckoffPhase = "Distribuição (Fase C) ou Mark-Down";
    wyckoffAnalysis = "📉 O preço está caindo com volume elevado, sugerindo que grandes players estão vendendo suas posições.";
  } else if (!volumeIncreasing && price > ma200) {
    wyckoffPhase = "Acumulação (Fase A/B)";
    wyckoffAnalysis = "📊 O preço está acima da média de longo prazo com volume estável, como se o mercado estivesse se preparando para um movimento maior.";
  } else {
    wyckoffPhase = "Indefinida";
    wyckoffAnalysis = "⚖️ O mercado está em consolidação, como um carro parado no sinal, esperando o próximo movimento.";
  }

  return { phase: wyckoffPhase, analysis: wyckoffAnalysis };
}

function analyzeElliott(ohlcv4h, rsi4h) {
  const highs = ohlcv4h.map(c => c[2]).slice(-10);
  const lows = ohlcv4h.map(c => c[3]).slice(-10);
  const closes = ohlcv4h.map(c => c[4]).slice(-10);
  let waveAnalysis = "";
  let waveStatus = "Indefinida";

  const lastPrice = closes[closes.length - 1];
  const prevPrice = closes[closes.length - 2];
  const fib = calculateFibonacciLevels(ohlcv4h, '4h');
  const isNear618 = fib && Math.abs(lastPrice - fib.levels['61.8']) / lastPrice < 0.02;
  const rsiIncreasing = rsi4h && rsi4h[rsi4h.length - 1] > rsi4h[rsi4h.length - 2];

  if (lastPrice > prevPrice && lastPrice >= Math.max(...highs) * 0.99 && isNear618 && rsiIncreasing) {
    waveStatus = "Onda Impulsiva (Possível Onda 3)";
    waveAnalysis = "📈 O preço está em uma forte onda de alta, como um trem ganhando velocidade, mirando alvos em 78.6% ou 100% de Fibonacci.";
  } else if (lastPrice < prevPrice && lastPrice <= Math.min(...lows) * 1.01) {
    waveStatus = "Onda Corretiva (Possível Onda A ou C)";
    waveAnalysis = "📉 O preço está em uma correção, como um carro desacelerando, com suportes prováveis em 38.2% ou 50% de Fibonacci.";
  } else {
    waveStatus = "Indefinida";
    waveAnalysis = "⚖️ O mercado está em consolidação, como uma pausa antes do próximo grande movimento.";
  }

  return { status: waveStatus, analysis: waveAnalysis };
}

function determineTargets(fibLevelsDaily, fibLevels4h, zonas, rsi1hVal, rsi15mVal, cvd15mStatus, obv15mStatus, macd1h, bb1h, estocasticoD, estocastico4h, wyckoff, elliott, orderBook, lsrData, atr, price) {
  if (!fibLevelsDaily || !fibLevels4h || !atr) return { buyTargets: [], sellTargets: [], buyExplanations: [], sellExplanations: [] };

  const buyTargets = [], sellTargets = [], buyExplanations = [], sellExplanations = [];

  // Combinar níveis de Fibonacci diário e 4h
  const fibLevelsCombined = {
    '23.6': [fibLevelsDaily.levels['23.6'], fibLevels4h.levels['23.6']],
    '38.2': [fibLevelsDaily.levels['38.2'], fibLevels4h.levels['38.2']],
    '50.0': [fibLevelsDaily.levels['50.0'], fibLevels4h.levels['50.0']],
    '61.8': [fibLevelsDaily.levels['61.8'], fibLevels4h.levels['61.8']],
    '78.6': [fibLevelsDaily.levels['78.6'], fibLevels4h.levels['78.6']]
  };

  const potentialBuyLevels = [
    { level: fibLevelsCombined['23.6'].reduce((sum, val) => sum + val, 0) / 2, label: '23.6% (Média D/4h)' },
    { level: fibLevelsCombined['38.2'].reduce((sum, val) => sum + val, 0) / 2, label: '38.2% (Média D/4h)' },
    { level: fibLevelsCombined['50.0'].reduce((sum, val) => sum + val, 0) / 2, label: '50.0% (Média D/4h)' }
  ].filter(l => l.level < price && l.level > price - atr * ATR_MULTIPLIER_FILTER); // Filtrar alvos fora de 3x ATR

  const potentialSellLevels = [
    { level: fibLevelsCombined['61.8'].reduce((sum, val) => sum + val, 0) / 2, label: '61.8% (Média D/4h)' },
    { level: fibLevelsCombined['78.6'].reduce((sum, val) => sum + val, 0) / 2, label: '78.6% (Média D/4h)' }
  ].filter(l => l.level > price && l.level < price + atr * ATR_MULTIPLIER_FILTER); // Filtrar alvos fora de 3x ATR

  potentialBuyLevels.forEach(({ level, label }) => {
    let score = 0, relevance = [];

    if (zonas.buyLiquidityZones.some(z => Math.abs(z - level) / level < 0.01)) {
      score += 1;
      relevance.push("🟢 Coincide com uma zona de liquidez de compra, indicando forte suporte.");
    }
    if (rsi15mVal < 40 || rsi1hVal < 40) {
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
    if ((estocasticoD?.k < 25 && estocasticoD?.k > estocasticoD?.d) || (estocastico4h?.k < 25 && estocastico4h?.k > estocastico4h?.d)) {
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
    if (lsrData.account.value > 1.2 || lsrData.position.value > 1.2) {
      score += 1;
      relevance.push("📉 LSR mostra maior interesse comprador.");
    }

    if (score >= 3) {
      const stopLoss = level - atr * ATR_MULTIPLIER_STOP;
      buyTargets.push({ level, stopLoss });
      buyExplanations.push(`*${label} (${level.toFixed(2)})*: Confiança ${score}/10. Stop-loss: ${stopLoss.toFixed(2)} (baseado em ${ATR_MULTIPLIER_STOP}x ATR). ${relevance.join(' ')}`);
    }
  });

  potentialSellLevels.forEach(({ level, label }) => {
    let score = 0, relevance = [];

    if (zonas.sellLiquidityZones.some(z => Math.abs(z - level) / level < 0.01)) {
      score += 1;
      relevance.push("🔴 Coincide com uma zona de liquidez de venda, indicando forte resistência.");
    }
    if (rsi15mVal > 60 || rsi1hVal > 60) {
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
    if ((estocasticoD?.k > 75 && estocasticoD?.k < estocasticoD?.d) || (estocastico4h?.k > 75 && estocastico4h?.k < estocastico4h?.d)) {
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
    if (lsrData.account.value < 0.8 || lsrData.position.value < 0.8) {
      score += 1;
      relevance.push("📉 LSR mostra maior interesse vendedor.");
    }

    if (score >= 3) {
      const stopLoss = level + atr * ATR_MULTIPLIER_STOP;
      sellTargets.push({ level, stopLoss });
      sellExplanations.push(`*${label} (${level.toFixed(2)})*: Confiança ${score}/10. Stop-loss: ${stopLoss.toFixed(2)} (baseado em ${ATR_MULTIPLIER_STOP}x ATR). ${relevance.join(' ')}`);
    }
  });

  return { buyTargets, sellTargets, buyExplanations, sellExplanations };
}

function generateSummary(price, rsi1hVal, wyckoff, elliott, targets, backtestSuccess, atr) {
  let sentiment = "Neutro ⚖️";
  if (rsi1hVal < 40 && wyckoff.phase.includes("Acumulação") && targets.buyTargets.length > 0) {
    sentiment = "Bullish 🟢";
  } else if (rsi1hVal > 60 && wyckoff.phase.includes("Distribuição") && targets.sellTargets.length > 0) {
    sentiment = "Bearish 🔴";
  }

  const recommendation = targets.buyTargets.length > 0
    ? `Considere comprar em ${targets.buyTargets[0].level.toFixed(2)} com stop-loss em ${targets.buyTargets[0].stopLoss.toFixed(2)} (baseado em ${ATR_MULTIPLIER_STOP}x ATR).`
    : targets.sellTargets.length > 0
      ? `Considere vender em ${targets.sellTargets[0].level.toFixed(2)} com stop-loss em ${targets.sellTargets[0].stopLoss.toFixed(2)} (baseado em ${ATR_MULTIPLIER_STOP}x ATR).`
      : "Aguarde por sinais mais claros antes de agir.";

  return `📝 *Resumo do Mercado*\n` +
         `Sentimento: ${sentiment}\n` +
         `Recomendação: ${recommendation}\n` +
         `Volatilidade (ATR 1H): ${atr.toFixed(2)} USDT\n` +
         `Confiabilidade dos alvos (histórico): ${backtestSuccess}% dos alvos de Fibonacci foram atingidos nos últimos 30 dias.\n`;
}

// ================= FUNÇÃO PRINCIPAL ================= //
async function sendStatusReport() {
  try {
    let texto = `🤖 *Análise Automática de BTCUSDT* - ${new Date().toLocaleString('pt-BR')}\n\n`;

    const symbol = PAR_MONITORADO;

    // Dados OHLCV
    const ohlcv1h = await exchangeSpot.fetchOHLCV(symbol, '1h', undefined, 20);
    const ohlcv15m = await exchangeSpot.fetchOHLCV(symbol, '15m', undefined, 20);
    const ohlcv3m = await exchangeSpot.fetchOHLCV(symbol, '3m', undefined, 10);
    const ohlcvDiario = await exchangeSpot.fetchOHLCV(symbol, '1d', undefined, 200);
    const ohlcv4h = await exchangeSpot.fetchOHLCV(symbol, '4h', undefined, 20);

    if (!ohlcv1h || !ohlcv3m || !ohlcv15m || !ohlcvDiario || !ohlcv4h) {
      logger.warn(`Dados insuficientes para ${symbol}`);
      texto += `⚠️ *${symbol}*: Dados insuficientes\n\n`;
      await bot.api.sendMessage(TELEGRAM_CHAT_ID, texto, { parse_mode: 'Markdown' });
      return;
    }

    // Indicadores e análises
    const volume1hAtual = ohlcv1h[ohlcv1h.length - 1][5];
    const volume1hAnterior = ohlcv1h[ohlcv1h.length - 2][5];
    const volume1hStatus = volume1hAtual > volume1hAnterior ? `⬆️ Subindo (+${((volume1hAtual - volume1hAnterior) / volume1hAnterior * 100).toFixed(2)}%)` : `⬇️ Caindo (${((volume1hAnterior - volume1hAtual) / volume1hAnterior * 100).toFixed(2)}%)`;

    const volume24hAtual = ohlcvDiario[ohlcvDiario.length - 1][5];
    const volume24hAnterior = ohlcvDiario[ohlcvDiario.length - 2][5];
    const volume24hStatus = volume24hAtual > volume24hAnterior ? `⬆️ Subindo (+${((volume24hAtual - volume24hAnterior) / volume24hAnterior * 100).toFixed(2)}%)` : `⬇️ Caindo (${((volume24hAnterior - volume24hAtual) / volume24hAnterior * 100).toFixed(2)}%)`;

    const lsrData = await fetchLSR(symbol);
    const oi5m = await fetchOpenInterest(symbol, '5m');
    const oi15m = await fetchOpenInterest(symbol, '15m');
    const oi1h = await fetchOpenInterest(symbol, '1h');
    const totalOI = await fetchTotalOpenInterest(symbol);
    const fundingRateData = await fetchFundingRate(symbol);
    const fundingRate = fundingRateData.current !== null ? (fundingRateData.current * 100).toFixed(4) : '--';
    const orderBook = await fetchOrderBook(symbol);
    const correlation = await fetchCorrelation(symbol);
    const backtestSuccess = await backtestTargets(symbol);

    const price = ohlcv1h[ohlcv1h.length - 1][4];
    const format = v => price < 1 ? v.toFixed(8) : price < 10 ? v.toFixed(6) : price < 100 ? v.toFixed(4) : v.toFixed(2);

    const atr = calculateATR(ohlcv1h.map(c => ({ high: c[2], low: c[3], close: c[4] })));
    if (!atr) {
      logger.warn('ATR não calculado, pulando relatório');
      texto += `⚠️ *${symbol}*: ATR indisponível\n\n`;
      await bot.api.sendMessage(TELEGRAM_CHAT_ID, texto, { parse_mode: 'Markdown' });
      return;
    }

    const estocasticoD = calculateStochastic(ohlcvDiario.map(c => ({ high: c[2], low: c[3], close: c[4] })), 5, 3, 3);
    const estocastico4h = calculateStochastic(ohlcv4h.map(c => ({ high: c[2], low: c[3], close: c[4] })), 5, 3, 3);
    const zonas = detectarQuebraEstrutura(ohlcv15m.map(c => ({ high: c[2], low: c[3], volume: c[5] })));
    const rsi1h = calculateRSI(ohlcv1h.map(c => ({ close: c[4] })));
    const rsi15m = calculateRSI(ohlcv15m.map(c => ({ close: c[4] })));
    const rsi4h = calculateRSI(ohlcv4h.map(c => ({ close: c[4] })));
    const cvd15m = calculateCVD(ohlcv15m);
    const obv15m = calculateOBV(ohlcv15m);
    const macd1h = calculateMACD(ohlcv1h.map(c => ({ close: c[4] })));
    const bb1h = calculateBollingerBands(ohlcv1h.map(c => ({ close: c[4] })));

    const cvd15mStatus = cvd15m > 0 ? "⬆️ Bullish" : cvd15m < 0 ? "⬇️ Bearish" : "➡️ Neutro";
    const obv15mStatus = obv15m > 0 ? "⬆️ Bullish" : obv15m < 0 ? "⬇️ Bearish" : "➡️ Neutro";
    const rsi1hVal = rsi1h && rsi1h.length ? rsi1h[rsi1h.length - 1].toFixed(2) : '--';
    const rsi15mVal = rsi15m && rsi15m.length ? rsi15m[rsi15m.length - 1].toFixed(2) : '--';
    const rsi1hEmoji = rsi1h && rsi1h.length ? (rsi1h[rsi1h.length - 1] > 60 ? "🔴" : rsi1h[rsi1h.length - 1] < 40 ? "🟢" : "") : "";

    if (!ultimoEstocastico[symbol]) ultimoEstocastico[symbol] = {};
    const kDAnterior = ultimoEstocastico[symbol].kD || estocasticoD?.k || 0;
    const dDAnterior = ultimoEstocastico[symbol].dD || estocasticoD?.d || 0;
    const k4hAnterior = ultimoEstocastico[symbol].k4h || estocastico4h?.k || 0;
    const d4hAnterior = ultimoEstocastico[symbol].d4h || estocastico4h?.d || 0;

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
      ? orderBook.bids.map(bid => `${format(bid.price)} (${bid.amount.toFixed(2)} BTC)`).join(', ')
      : '--';
    const askText = orderBook.asks.length > 0
      ? orderBook.asks.map(ask => `${format(ask.price)} (${ask.amount.toFixed(2)} BTC)`).join(', ')
      : '--';

    const wyckoff = analyzeWyckoff(ohlcvDiario, ohlcv4h, volume24hAtual, volume24hAnterior);
    const elliott = analyzeElliott(ohlcv4h, rsi4h);
    const fibLevelsDaily = calculateFibonacciLevels(ohlcvDiario, '1d', atr);
    const fibLevels4h = calculateFibonacciLevels(ohlcv4h, '4h', atr);
    const targets = determineTargets(fibLevelsDaily, fibLevels4h, zonas, rsi1hVal, rsi15mVal, cvd15mStatus, obv15mStatus, macd1h, bb1h, estocasticoD, estocastico4h, wyckoff, elliott, orderBook, lsrData, atr, price);
    const summary = generateSummary(price, rsi1hVal, wyckoff, elliott, targets, backtestSuccess, atr);

    // Montar relatório
    texto += summary +
      `*${symbol}*\n` +
      `💲 Preço: ${format(price)}\n` +
      `📊 Volume 1H: ${volume1hStatus}\n` +
      `📊 Volume 24H: ${volume24hStatus}\n` +
      `📉 LSR Contas: ${lsrData.account.value?.toFixed(2) || '--'} ${lsrData.account.status} (${lsrData.account.percentChange}%)\n` +
      `📉 LSR Posições: ${lsrData.position.value?.toFixed(2) || '--'} ${lsrData.position.status} (${lsrData.position.percentChange}%)\n` +
      `📈 OI Total: ${totalOI ? `$${parseFloat(totalOI).toLocaleString('en-US')}` : '--'} USDT\n` +
      `📈 OI 5m: ${oi5m.value ? oi5m.value.toFixed(2) : '--'} BTC ${oi5m.status}\n` +
      `📈 OI 15m: ${oi15m.value ? oi5m.value.toFixed(2) : '--'} BTC ${oi15m.status}\n` +
      `📈 OI 1h: ${oi1h.value ? oi1h.value.toFixed(2) : '--'} BTC ${oi1h.status}\n` +
      `📊 Funding Rate: ${fundingRate}% ${fundingRateData.status}\n` +
      `📈 RSI 1H: ${rsi1hVal} ${rsi1hEmoji}\n` +
      `📈 RSI 15M: ${rsi15mVal}\n` +
      `📊 CVD 15M: ${cvd15m.toFixed(2)} ${cvd15mStatus}\n` +
      `📊 OBV 15M: ${obv15m.toFixed(2)} ${obv15mStatus}\n` +
      `📊 MACD 1H: ${macd1h ? macd1h.status : '--'}\n` +
      `📊 Bollinger Bands 1H: ${bb1h ? bb1h.status : '--'}\n` +
      `📊 Stoch D %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${kDEmoji} ${direcaoKD}\n` +
      `📊 Stoch D %D: ${estocasticoD ? estocasticoD.d.toFixed(2) : '--'} ${dDEmoji} ${direcaoDD}\n` +
      `📊 Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${k4hEmoji} ${direcaoK4h}\n` +
      `📊 Stoch 4H %D: ${estocastico4h ? estocastico4h.d.toFixed(2) : '--'} ${d4hEmoji} ${direcaoD4h}\n` +
      `🔹 Estrutura de Baixa: ${format(zonas.estruturaBaixa) || '--'}\n` +
      `🔹 Rompimento de Alta: ${format(zonas.estruturaAlta) || '--'}\n` +
      `📖 *Order Book (Top 5)*\n` +
      `🟢 Bids: ${bidText}\n` +
      `🔴 Asks: ${askText}\n` +
      `📊 Volume Bids: ${orderBook.totalBidVolume.toFixed(2)} BTC | Asks: ${orderBook.totalAskVolume.toFixed(2)} BTC\n` +
      `📊 Zona de Suporte (Order Book): ${format(orderBook.supportZone)}\n` +
      `📊 Zona de Resistência (Order Book): ${format(orderBook.resistanceZone)}\n` +
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

    await bot.api.sendMessage(TELEGRAM_CHAT_ID, texto, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  } catch (e) {
    logger.error(`Erro no relatório de mercado: ${e.message}`);
  }
}

// Função principal
async function main() {
  logger.info('Iniciando análise I.A. BTCUSDT');
  try {
    await bot.api.sendMessage(TELEGRAM_CHAT_ID, '🤖 Titanium BTCUSDT');
    await sendStatusReport(); // Envia relatório inicial
    setInterval(sendStatusReport, INTERVALO_RELATORIO_15M_MS); // A cada 15 minutos
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`);
  }
}

main();
