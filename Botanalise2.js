require('dotenv').config();
const ccxt = require('ccxt');
const TechnicalIndicators = require('technicalindicators');
const { Bot } = require('grammy');
const winston = require('winston');
const axios = require('axios');

// ================= CONFIGURAÇÃO ================= //
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const INTERVALO_RELATORIO_15M_MS = 15 * 60 * 1000; // 15 minutos
const API_DELAY_MS = 500; // Delay entre chamadas à API

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'crypto_analysis_bot.log' }),
    new winston.transports.Console()
  ]
});

// Declaração explícita no início do script
const ultimoEstocastico = {};

// Validação de variáveis de ambiente
function validateEnv() {
  const required = ['BINANCE_API_KEY', 'BINANCE_SECRET_KEY', 'TELEGRAM_BOT_TOKEN'];
  for (const key of required) {
    if (!process.env[key]) {
      logger.error(`Variável de ambiente ausente: ${key}`);
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

// Funções de indicadores
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

function calculateVWAP(ohlcv) {
  if (!ohlcv || ohlcv.length < 1) return { vwap: null, max: null, min: null };
  
  let totalVolume = 0;
  let totalPriceVolume = 0;

  ohlcv.forEach(candle => {
    const typicalPrice = (candle[2] + candle[3] + candle[4]) / 3; // (High + Low + Close) / 3
    const volume = candle[5];
    totalPriceVolume += typicalPrice * volume;
    totalVolume += volume;
  });

  const vwap = totalVolume > 0 ? totalPriceVolume / totalVolume : null;
  if (!vwap) return { vwap: null, max: null, min: null };

  // Definir região VWAP (±1% para max/min)
  const vwapMax = vwap * 1.01;
  const vwapMin = vwap * 0.99;

  return { vwap: vwap.toFixed(4), max: vwapMax.toFixed(4), min: vwapMin.toFixed(4) };
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
agedy: 3,
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
      return { bids: [], asks: [], totalBidVolume: 0, totalAskVolume: 0 };
    }

    const bids = orderBook.bids.map(([price, amount]) => ({ price, amount })).slice(0, 5);
    const asks = orderBook.asks.map(([price, amount]) => ({ price, amount })).slice(0, 5);
    const totalBidVolume = bids.reduce((sum, bid) => sum + bid.amount, 0);
    const totalAskVolume = asks.reduce((sum, ask) => sum + ask.amount, 0);

    await new Promise(resolve => setTimeout(resolve, API_DELAY_MS));
    return { bids, asks, totalBidVolume, totalAskVolume };
  } catch (e) {
    logger.warn(`Erro ao buscar order book para ${symbol}: ${e.message}`);
    return { bids: [], asks: [], totalBidVolume: 0, totalAskVolume: 0 };
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

function calculateFibonacciLevels(ohlcvDiario) {
  const highs = ohlcvDiario.map(c => c[2]).filter(h => !isNaN(h) && h !== null);
  const lows = ohlcvDiario.map(c => c[3]).filter(l => !isNaN(l) && l !== null);
  if (highs.length === 0 || lows.length === 0) return null;

  const maxHigh = Math.max(...highs);
  const minLow = Math.min(...lows);
  const range = maxHigh - minLow;

  return {
    '0.0': minLow,
    '23.6': minLow + range * 0.236,
    '38.2': minLow + range * 0.382,
    '50.0': minLow + range * 0.5,
    '61.8': minLow + range * 0.618,
    '78.6': minLow + range * 0.786,
    '100.0': maxHigh
  };
}

function analyzeWyckoff(ohlcvDiario, ohlcv4h, volume24hAtual, volume24hAnterior) {
  const lastCandle = ohlcvDiario[ohlcvDiario.length - 1];
  const prevCandle = ohlcvDiario[ohlcvDiario.length - 2];
  const volumeIncreasing = volume24hAtual > volume24hAnterior;
  const price = lastCandle[4];
  const prevPrice = prevCandle[4];
  const priceDirection = price > prevPrice ? "⬆️ Subindo" : "⬇️ Caindo";

  let wyckoffPhase = "Indefinida";
  let wyckoffAnalysis = "";

  if (volumeIncreasing && priceDirection === "⬆️ Subindo") {
    wyckoffPhase = "Acumulação (Fase B/C) ou Mark-Up";
    wyckoffAnalysis = "📈 Indícios de acumulação ou início de uma tendência de alta.";
  } else if (volumeIncreasing && priceDirection === "⬇️ Caindo") {
    wyckoffPhase = "Distribuição (Fase B/C) ou Mark-Down";
    wyckoffAnalysis = "📉 Indícios de distribuição ou início de uma tendência de baixa.";
  } else if (!volumeIncreasing && price > prevPrice) {
    wyckoffPhase = "Acumulação (Fase A) ou Reacumulação";
    wyckoffAnalysis = "📊 Possível acumulação ou reacumulação.";
  } else {
    wyckoffPhase = "Indefinida";
    wyckoffAnalysis = "⚖️ Mercado em consolidação ou indefinido.";
  }

  return { phase: wyckoffPhase, analysis: wyckoffAnalysis };
}

function analyzeElliott(ohlcv4h) {
  const highs = ohlcv4h.map(c => c[2]).slice(-10);
  const lows = ohlcv4h.map(c => c[3]).slice(-10);
  let waveAnalysis = "";
  let waveStatus = "Indefinida";

  const lastHigh = Math.max(...highs);
  const lastLow = Math.min(...lows);
  const lastPrice = ohlcv4h[ohlcv4h.length - 1][4];
  const prevPrice = ohlcv4h[ohlcv4h.length - 2][4];

  if (lastPrice > prevPrice && lastPrice >= lastHigh * 0.99) {
    waveStatus = "Onda Impulsiva (Possível Onda 3 ou 5)";
    waveAnalysis = "📈 O preço está em uma possível onda impulsiva de alta.";
  } else if (lastPrice < prevPrice && lastPrice <= lastLow * 1.01) {
    waveStatus = "Onda Corretiva (Possível Onda A ou C)";
    waveAnalysis = "📉 O preço está em uma possível onda corretiva.";
  } else {
    waveStatus = "Indefinida";
    waveAnalysis = "⚖️ Sem padrão claro de Elliott Wave no momento.";
  }

  return { status: waveStatus, analysis: waveAnalysis };
}

function determineTargets(fibLevels, zonas, rsi1hVal, rsi15mVal, cvd15mStatus, obv15mStatus, estocasticoD, estocastico4h, wyckoff, elliott, orderBook, lsrData, currentPrice) {
  if (!fibLevels) return { 
    buyTargets: [], 
    sellTargets: [], 
    buyExplanations: [], 
    sellExplanations: [], 
    bestBuyZone: null, 
    bestSellZone: null, 
    breakoutAbove: [], 
    breakoutBelow: [] 
  };

  const price = currentPrice || fibLevels['50.0'];
  const buyTargets = [];
  const sellTargets = [];
  const buyExplanations = [];
  const sellExplanations = [];
  let bestBuyZone = null;
  let bestSellZone = null;
  let bestBuyScore = -1;
  let bestSellScore = -1;
  let bestBuyExplanation = '';
  let bestSellExplanation = '';
  const breakoutAbove = [];
  const breakoutBelow = [];

  const potentialBuyLevels = [
    { level: fibLevels['23.6'], label: '23.6%' },
    { level: fibLevels['38.2'], label: '38.2%' },
    { level: fibLevels['50.0'], label: '50.0%' }
  ].filter(l => l.level < price && l.level > 0);

  const potentialSellLevels = [
    { level: fibLevels['61.8'], label: '61.8%' },
    { level: fibLevels['78.6'], label: '78.6%' },
    { level: fibLevels['100.0'], label: '100.0%' }
  ].filter(l => l.level > price && l.level > 0);

  // Avaliar alvos de compra
  potentialBuyLevels.forEach(({ level, label }) => {
    let relevance = "";
    let score = 0;

    const nearBuyZone = zonas.buyLiquidityZones.some(z => Math.abs(z - level) / level < 0.01);
    if (nearBuyZone) {
      relevance += "🟢 Coincide com zona de liquidez de compra. ";
      score += 2;
    }

    if (rsi15mVal < 40 || rsi1hVal < 40) {
      relevance += "📉 RSI em zona de sobrevenda. ";
      score += 1.5;
    }

    if (cvd15mStatus === "⬆️ Bullish" || obv15mStatus === "⬆️ Bullish") {
      relevance += "📈 CVD/OBV bullish. ";
      score += 1;
    }

    if ((estocasticoD?.k < 25 && estocasticoD?.k > estocasticoD?.d) || (estocastico4h?.k < 25 && estocastico4h?.k > estocastico4h?.d)) {
      relevance += "📊 Estocástico em sobrevenda. ";
      score += 1.5;
    }

    if (wyckoff.phase.includes("Acumulação")) {
      relevance += "📚 Fase de acumulação (Wyckoff). ";
      score += 1;
    }

    if (elliott.status.includes("Onda Corretiva")) {
      relevance += "🌊 Onda corretiva (Elliott). ";
      score += 1;
    }

    if (orderBook.totalBidVolume > orderBook.totalAskVolume * 1.2) {
      relevance += "📖 Maior volume de bids. ";
      score += 1;
    }

    if (lsrData.account.value > 1.2 || lsrData.position.value > 1.2) {
      relevance += `📉 LSR bullish (Conta: ${lsrData.account.value?.toFixed(2) || '--'}, Posição: ${lsrData.position.value?.toFixed(2) || '--'}). `;
      score += 1;
    }

    if (score > 0) {
      buyTargets.push(level);
      buyExplanations.push(`*${label} (${level.toFixed(4)})*: ${relevance}`);
      if (score > bestBuyScore) {
        bestBuyScore = score;
        bestBuyZone = { level, label };
        bestBuyExplanation = relevance;
      }
    }
  });

  // Avaliar alvos de venda
  potentialSellLevels.forEach(({ level, label }) => {
    let relevance = "";
    let score = 0;

    const nearSellZone = zonas.sellLiquidityZones.some(z => Math.abs(z - level) / level < 0.01);
    if (nearSellZone) {
      relevance += "🔴 Coincide com zona de liquidez de venda. ";
      score += 2;
    }

    if (rsi15mVal > 60 || rsi1hVal > 60) {
      relevance += "📉 RSI em zona de sobrecompra. ";
      score += 1.5;
    }

    if (cvd15mStatus === "⬇️ Bearish" || obv15mStatus === "⬇️ Bearish") {
      relevance += "📈 CVD/OBV bearish. ";
      score += 1;
    }

    if ((estocasticoD?.k > 75 && estocasticoD?.k < estocasticoD?.d) || (estocastico4h?.k > 75 && estocastico4h?.k < estocastico4h?.d)) {
      relevance += "📊 Estocástico em sobrecompra. ";
      score += 1.5;
    }

    if (wyckoff.phase.includes("Distribuição")) {
      relevance += "📚 Fase de distribuição (Wyckoff). ";
      score += 1;
    }

    if (elliott.status.includes("Onda Impulsiva")) {
      relevance += "🌊 Onda impulsiva (Elliott). ";
      score += 1;
    }

    if (orderBook.totalAskVolume > orderBook.totalBidVolume * 1.2) {
      relevance += "📖 Maior volume de asks. ";
      score += 1;
    }

    if (lsrData.account.value < 0.8 || lsrData.position.value < 0.8) {
      relevance += `📉 LSR bearish (Conta: ${lsrData.account.value?.toFixed(2) || '--'}, Posição: ${lsrData.position.value?.toFixed(2) || '--'}). `;
      score += 1;
    }

    if (score > 0) {
      sellTargets.push(level);
      sellExplanations.push(`*${label} (${level.toFixed(4)})*: ${relevance}`);
      if (score > bestSellScore) {
        bestSellScore = score;
        bestSellZone = { level, label };
        bestSellExplanation = relevance;
      }
    }
  });

  // Avaliar pontos de rompimento de estrutura
  if (zonas.estruturaAlta > 0 && zonas.estruturaAlta > price) {
    let relevance = "🔝 Resistência principal. ";
    let score = 1;

    const nearSellZone = zonas.sellLiquidityZones.some(z => Math.abs(z - zonas.estruturaAlta) / zonas.estruturaAlta < 0.01);
    if (nearSellZone) {
      relevance += "🔴 Coincide com zona de liquidez de venda. ";
      score += 2;
    }

    if (fibLevels['61.8'] && Math.abs(zonas.estruturaAlta - fibLevels['61.8']) / zonas.estruturaAlta < 0.01) {
      relevance += "📏 Perto de Fibonacci 61.8%. ";
      score += 1;
    } else if (fibLevels['78.6'] && Math.abs(zonas.estruturaAlta - fibLevels['78.6']) / zonas.estruturaAlta < 0.01) {
      relevance += "📏 Perto de Fibonacci 78.6%. ";
      score += 1;
    } else if (fibLevels['100.0'] && Math.abs(zonas.estruturaAlta - fibLevels['100.0']) / zonas.estruturaAlta < 0.01) {
      relevance += "📏 Perto de Fibonacci 100.0%. ";
      score += 1;
    }

    if (lsrData.account.value < 0.8 || lsrData.position.value < 0.8) {
      relevance += `📉 LSR bearish (Conta: ${lsrData.account.value?.toFixed(2) || '--'}, Posição: ${lsrData.position.value?.toFixed(2) || '--'}). `;
      score += 1;
    }

    breakoutAbove.push({ level: zonas.estruturaAlta, label: 'Estrutura Alta', explanation: relevance });

    // Adicionar alvos futuros acima
    const futureAboveLevels = [
      { level: fibLevels['78.6'], label: 'Fib 78.6%' },
      { level: fibLevels['100.0'], label: 'Fib 100.0%' }
    ].filter(l => l.level > zonas.estruturaAlta && l.level > 0);

    futureAboveLevels.forEach(({ level, label }) => {
      let futureRelevance = "🎯 Alvo futuro após rompimento de alta. ";
      if (zonas.sellLiquidityZones.some(z => Math.abs(z - level) / level < 0.01)) {
        futureRelevance += "🔴 Coincide com zona de liquidez de venda. ";
      }
      breakoutAbove.push({ level, label, explanation: futureRelevance });
    });
  }

  if (zonas.estruturaBaixa > 0 && zonas.estruturaBaixa < price) {
    let relevance = "🔍 Suporte principal. ";
    let score = 1;

    const nearBuyZone = zonas.buyLiquidityZones.some(z => Math.abs(z - zonas.estruturaBaixa) / zonas.estruturaBaixa < 0.01);
    if (nearBuyZone) {
      relevance += "🟢 Coincide com zona de liquidez de compra. ";
      score += 2;
    }

    if (fibLevels['38.2'] && Math.abs(zonas.estruturaBaixa - fibLevels['38.2']) / zonas.estruturaBaixa < 0.01) {
      relevance += "📏 Perto de Fibonacci 38.2%. ";
      score += 1;
    } else if (fibLevels['23.6'] && Math.abs(zonas.estruturaBaixa - fibLevels['23.6']) / zonas.estruturaBaixa < 0.01) {
      relevance += "📏 Perto de Fibonacci 23.6%. ";
      score += 1;
    } else if (fibLevels['0.0'] && Math.abs(zonas.estruturaBaixa - fibLevels['0.0']) / zonas.estruturaBaixa < 0.01) {
      relevance += "📏 Perto de Fibonacci 0.0%. ";
      score += 1;
    }

    if (lsrData.account.value > 1.2 || lsrData.position.value > 1.2) {
      relevance += `📉 LSR bullish (Conta: ${lsrData.account.value?.toFixed(2) || '--'}, Posição: ${lsrData.position.value?.toFixed(2) || '--'}). `;
      score += 1;
    }

    breakoutBelow.push({ level: zonas.estruturaBaixa, label: 'Estrutura Baixa', explanation: relevance });

    // Adicionar alvos futuros abaixo
    const futureBelowLevels = [
      { level: fibLevels['23.6'], label: 'Fib 23.6%' },
      { level: fibLevels['0.0'], label: 'Fib 0.0%' }
    ].filter(l => l.level < zonas.estruturaBaixa && l.level > 0);

    futureBelowLevels.forEach(({ level, label }) => {
      let futureRelevance = "🎯 Alvo futuro após rompimento de baixa. ";
      if (zonas.buyLiquidityZones.some(z => Math.abs(z - level) / level < 0.01)) {
        futureRelevance += "🟢 Coincide com zona de liquidez de compra. ";
      }
      breakoutBelow.push({ level, label, explanation: futureRelevance });
    });
  }

  return {
    buyTargets,
    sellTargets,
    buyExplanations,
    sellExplanations,
    bestBuyZone: bestBuyZone ? { level: bestBuyZone.level.toFixed(4), label: bestBuyZone.label, explanation: bestBuyExplanation } : null,
    bestSellZone: bestSellZone ? { level: bestSellZone.level.toFixed(4), label: bestSellZone.label, explanation: bestSellExplanation } : null,
    breakoutAbove,
    breakoutBelow
  };
}

// Função para validar o par de moedas
async function validateSymbol(symbol) {
  try {
    const markets = await exchangeSpot.loadMarkets();
    return !!markets[symbol];
  } catch (e) {
    logger.error(`Erro ao validar par ${symbol}: ${e.message}`);
    return false;
  }
}

// Função principal de envio de relatório
async function sendStatusReport(symbol, chatId) {
  try {
    // Validar o par de moedas
    const isValidSymbol = await validateSymbol(symbol);
    if (!isValidSymbol) {
      await bot.api.sendMessage(chatId, `⚠️ Par inválido: ${symbol}. Exemplo: /info BTCUSDT`);
      return;
    }

    let texto = `🤖 *Análise de ${symbol}*\n\n`;

    // Dados OHLCV
    const ohlcv1h = await exchangeSpot.fetchOHLCV(symbol, '1h', undefined, 20);
    const ohlcv15m = await exchangeSpot.fetchOHLCV(symbol, '15m', undefined, 20);
    const ohlcvDiario = await exchangeSpot.fetchOHLCV(symbol, '1d', undefined, 20);
    const ohlcv4h = await exchangeSpot.fetchOHLCV(symbol, '4h', undefined, 20);

    if (!ohlcv1h || !ohlcv15m || !ohlcvDiario || !ohlcv4h) {
      logger.warn(`Dados insuficientes para ${symbol}`);
      texto += `⚠️ *${symbol}*: Dados insuficientes\n`;
      await bot.api.sendMessage(chatId, texto, { parse_mode: 'Markdown' });
      return;
    }

    // Preço atual
    const price = ohlcv1h[ohlcv1h.length - 1][4];
    const format = v => price < 1 ? v.toFixed(8) : price < 10 ? v.toFixed(6) : price < 100 ? v.toFixed(4) : v.toFixed(2);

    // Volume
    const volume1hAtual = ohlcv1h[ohlcv1h.length - 1][5];
    const volume1hAnterior = ohlcv1h[ohlcv1h.length - 2][5];
    const volume1hStatus = volume1hAtual > volume1hAnterior ? `⬆️ +${((volume1hAtual - volume1hAnterior) / volume1hAnterior * 100).toFixed(1)}%` : `⬇️ ${((volume1hAtual - volume1hAnterior) / volume1hAnterior * 100).toFixed(1)}%`;

    // VWAP
    const vwap1h = calculateVWAP(ohlcv1h);
    const vwap15m = calculateVWAP(ohlcv15m);

    // Indicadores
    const rsi1h = calculateRSI(ohlcv1h.map(c => ({ close: c[4] })));
    const rsi15m = calculateRSI(ohlcv15m.map(c => ({ close: c[4] })));
    const rsi1hVal = rsi1h && rsi1h.length ? rsi1h[rsi1h.length - 1].toFixed(1) : '--';
    const rsi15mVal = rsi15m && rsi15m.length ? rsi15m[rsi15m.length - 1].toFixed(1) : '--';
    const rsi1hEmoji = rsi1hVal > 60 ? "🔴" : rsi1hVal < 40 ? "🟢" : "";
    const rsi15mEmoji = rsi15mVal > 60 ? "🔴" : rsi15mVal < 40 ? "🟢" : "";

    const estocasticoD = calculateStochastic(ohlcvDiario.map(c => ({ high: c[2], low: c[3], close: c[4] })), 5, 3, 3);
    const estocastico4h = calculateStochastic(ohlcv4h.map(c => ({ high: c[2], low: c[3], close: c[4] })), 5, 3, 3);
    const kDEmoji = getStochasticEmoji(estocasticoD?.k);
    const k4hEmoji = getStochasticEmoji(estocastico4h?.k);

    // LSR e Open Interest
    const lsrData = await fetchLSR(symbol);
    const oi15m = await fetchOpenInterest(symbol, '15m');
    const fundingRateData = await fetchFundingRate(symbol);
    const fundingRate = fundingRateData.current !== null ? (fundingRateData.current * 100).toFixed(4) : '--';

    // Zonas de estrutura
    const zonas = detectarQuebraEstrutura(ohlcv15m.map(c => ({ high: c[2], low: c[3], volume: c[5] })));
    const fibLevels = calculateFibonacciLevels(ohlcvDiario);

    // Alvos
    const targets = determineTargets(
      fibLevels, 
      zonas, 
      rsi1hVal, 
      rsi15mVal, 
      calculateCVD(ohlcv15m) > 0 ? "⬆️ Bullish" : "⬇️ Bearish", 
      calculateOBV(ohlcv15m) > 0 ? "⬆️ Bullish" : "⬇️ Bearish", 
      estocasticoD, 
      estocastico4h, 
      analyzeWyckoff(ohlcvDiario, ohlcv4h, ohlcvDiario[ohlcvDiario.length - 1][5], ohlcvDiario[ohlcvDiario.length - 2][5]), 
      analyzeElliott(ohlcv4h), 
      await fetchOrderBook(symbol), 
      lsrData,
      price
    );

    // Montar relatório conciso
    texto += `*${symbol}*\n` +
      `💲 *Preço*: ${format(price)}\n` +
      `📊 *Volume 1H*: ${volume1hStatus}\n` +
      `📈 *VWAP 1H*: ${vwap1h.vwap || '--'} (Região: ${vwap1h.min || '--'} - ${vwap1h.max || '--'})\n` +
      `📈 *VWAP 15M*: ${vwap15m.vwap || '--'} (Região: ${vwap15m.min || '--'} - ${vwap15m.max || '--'})\n` +
      `📈 *RSI 1H*: ${rsi1hVal}${rsi1hEmoji}\n` +
      `📈 *RSI 15M*: ${rsi15mVal}${rsi15mEmoji}\n` +
      `📊 *Stoch D %K*: ${estocasticoD ? estocasticoD.k.toFixed(1) : '--'}${kDEmoji}\n` +
      `📊 *Stoch 4H %K*: ${estocastico4h ? estocastico4h.k.toFixed(1) : '--'}${k4hEmoji}\n` +
      `📉 *LSR Contas*: ${lsrData.account.value?.toFixed(2) || '--'} ${lsrData.account.status}\n` +
      `📉 *LSR Posições*: ${lsrData.position.value?.toFixed(2) || '--'} ${lsrData.position.status}\n` +
      `📈 *OI 15m*: ${oi15m.value?.toFixed(2) || '--'} ${oi15m.status}\n` +
      `📊 *Funding Rate*: ${fundingRate}%\n` +
      `🔹 *Suporte*: ${format(zonas.estruturaBaixa) || '--'}\n` +
      `🔹 *Resistência*: ${format(zonas.estruturaAlta) || '--'}\n` +
      `\n🎯 *Melhor Zona de Compra*\n` +
      (targets.bestBuyZone ? `*${targets.bestBuyZone.label} (${targets.bestBuyZone.level})*: ${targets.bestBuyZone.explanation}` : 'Nenhuma identificada.') +
      `\n🎯 *Melhor Zona de Venda*\n` +
      (targets.bestSellZone ? `*${targets.bestSellZone.label} (${targets.bestSellZone.level})*: ${targets.bestSellZone.explanation}` : 'Nenhuma identificada.') +
      `\n\n🎯 *Possíveis Pontos de Rompimento*\n` +
      `📈 *Acima*\n` +
      (targets.breakoutAbove.length > 0 ? targets.breakoutAbove.map(b => `*${b.label} (${format(b.level)})*: ${b.explanation}`).join('\n') : 'Nenhum identificado.') +
      `\n📉 *Abaixo*\n` +
      (targets.breakoutBelow.length > 0 ? targets.breakoutBelow.map(b => `*${b.label} (${format(b.level)})*: ${b.explanation}`).join('\n') : 'Nenhum identificado.') +
      `\n\n🎯 *Alvos de Compra*\n` +
      (targets.buyExplanations.length > 0 ? targets.buyExplanations.map(e => e.split(': ')[0] + ': ' + e.split(': ')[1]).join('\n') : 'Nenhum identificado.') +
      `\n\n🎯 *Alvos de Venda*\n` +
      (targets.sellExplanations.length > 0 ? targets.sellExplanations.map(e => e.split(': ')[0] + ': ' + e.split(': ')[1]).join('\n') : 'Nenhum identificado.');

    await bot.api.sendMessage(chatId, texto, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  } catch (e) {
    logger.error(`Erro no relatório para ${symbol}: ${e.message}`);
    await bot.api.sendMessage(chatId, `⚠️ Erro ao gerar relatório: ${e.message}`);
  }
}

// Configurar comando /info
bot.on(['message:text', 'channel_post:text']).command('info', async (ctx) => {
  try {
    logger.info('Atualização recebida para /info:', {
      update: JSON.stringify(ctx.update, null, 2),
      chatId: ctx.chat?.id,
      messageText: ctx.message?.text || ctx.channelPost?.text
    });

    const text = ctx.message?.text || ctx.channelPost?.text;
    if (!text) {
      await ctx.reply('⚠️ Nenhuma mensagem válida recebida. Use: /info <par>, ex.: /info BTCUSDT');
      return;
    }

    const args = text.split(' ').slice(1);
    const symbol = args[0]?.toUpperCase();

    if (!symbol) {
      await ctx.reply('Por favor, forneça um par de moedas. Exemplo: /info BTCUSDT');
      return;
    }

    const normalizedSymbol = symbol.includes('/') ? symbol : `${symbol.slice(0, -4)}/${symbol.slice(-4)}`;

    await ctx.reply(`🔄 Gerando análise para ${normalizedSymbol}...`);
    await sendStatusReport(normalizedSymbol, ctx.chat.id);
  } catch (e) {
    logger.error(`Erro no comando /info: ${e.message}`, { stack: e.stack });
    await ctx.reply(`⚠️ Erro ao processar o comando: ${e.message}`);
  }
});

// Função principal
async function main() {
  logger.info('Iniciando bot de análise de criptomoedas');
  try {
    bot.catch((err, ctx) => {
      logger.error(`Erro no bot: ${err.message}`, {
        stack: err.stack,
        update: ctx.update
      });
      if (ctx.chat) {
        ctx.reply('⚠️ Ocorreu um erro interno. Tente novamente mais tarde.');
      }
    });

    logger.info('Bot configurado, iniciando...');
    await bot.api.sendMessage(process.env.TELEGRAM_CHAT_ID, '🤖 Titanium Análise  Crypto');
    await bot.start();
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`, { stack: e.stack });
  }
}

main();
