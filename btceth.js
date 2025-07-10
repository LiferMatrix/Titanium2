require('dotenv').config();
const ccxt = require('ccxt');
const TechnicalIndicators = require('technicalindicators');
const { Bot } = require('grammy');
const winston = require('winston');
const axios = require('axios');

// ================= CONFIGURAÇÃO ================= //
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PARES_MONITORADOS = ['BTCUSDT', 'ETHUSDT', 'BTCDOMUSDT']; // BTC, ETH e BTCDOM
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
    new winston.transports.File({ filename: 'rsi_alert_bot.log' }),
    new winston.transports.Console()
  ]
});

// Declaração explícita no início do script
const ultimoEstocastico = {};

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

  logger.debug(`Stochastic Input - Highs: ${highs.slice(-periodK)}, Lows: ${lows.slice(-periodK)}, Closes: ${closes.slice(-periodK)}`);

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
  logger.debug(`Stochastic Output - %K: ${lastResult.k}, %D: ${lastResult.d}`);

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
    // LSR de contas (globalLongShortAccountRatio)
    const accountRes = await axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', {
      params: { symbol: symbol.replace('/', ''), period: '15m', limit: 2 }
    });
    const accountLSR = accountRes.data && accountRes.data.length >= 2 ? {
      value: parseFloat(accountRes.data[0].longShortRatio),
      status: parseFloat(accountRes.data[0].longShortRatio) > parseFloat(accountRes.data[1].longShortRatio) ? "⬆️ Subindo" : "⬇️ Caindo",
      percentChange: accountRes.data[1].longShortRatio > 0 ? ((parseFloat(accountRes.data[0].longShortRatio) - parseFloat(accountRes.data[1].longShortRatio)) / parseFloat(accountRes.data[1].longShortRatio) * 100).toFixed(2) : 0
    } : { value: null, status: "🔹 Indisponível", percentChange: 0 };

    // LSR de posições (topLongShortPositionRatio)
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
    const orderBook = await exchangeSpot.fetchOrderBook(symbol, 10); // 10 melhores bids e asks
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

async function sendStatusReport() {
  try {
    let texto = `🤖 *Relatório de Mercado*\n\n`;
    
    for (const symbol of PARES_MONITORADOS) {
      // Dados OHLCV
      const ohlcv1h = await exchangeSpot.fetchOHLCV(symbol, '1h', undefined, 20);
      const ohlcv15m = await exchangeSpot.fetchOHLCV(symbol, '15m', undefined, 20);
      const ohlcv3m = await exchangeSpot.fetchOHLCV(symbol, '3m', undefined, 10);
      const ohlcvDiario = await exchangeSpot.fetchOHLCV(symbol, '1d', undefined, 20);
      const ohlcv4h = await exchangeSpot.fetchOHLCV(symbol, '4h', undefined, 20);

      if (!ohlcv1h || !ohlcv3m || !ohlcv15m || !ohlcvDiario || !ohlcv4h) {
        logger.warn(`Dados insuficientes para ${symbol}`);
        texto += `⚠️ *${symbol}*: Dados insuficientes\n\n`;
        continue;
      }

      // Volume
      const volume1hAtual = ohlcv1h[ohlcv1h.length - 1][5];
      const volume1hAnterior = ohlcv1h[ohlcv1h.length - 2][5];
      const volumeSubindo1h = volume1hAtual > volume1hAnterior;
      const volume1hPercent = volume1hAnterior > 0 ? ((volume1hAtual - volume1hAnterior) / volume1hAnterior * 100).toFixed(2) : 0;
      const volume1hStatus = volumeSubindo1h ? `⬆️ Subindo (+${volume1hPercent}%)` : `⬇️ Caindo (${volume1hPercent}%)`;

      const volume24hAtual = ohlcvDiario[ohlcvDiario.length - 1][5];
      const volume24hAnterior = ohlcvDiario[ohlcvDiario.length - 2][5];
      const volumeSubindo24h = volume24hAtual > volume24hAnterior;
      const volume24hPercent = volume24hAnterior > 0 ? ((volume24hAtual - volume24hAnterior) / volume24hAnterior * 100).toFixed(2) : 0;
      const volume24hStatus = volumeSubindo24h ? `⬆️ Subindo (+${volume24hPercent}%)` : `⬇️ Caindo (${volume24hPercent}%)`;

      // LSR
      const lsrData = await fetchLSR(symbol);
      const accountLSRValue = lsrData.account.value !== null ? lsrData.account.value.toFixed(2) : '--';
      const accountLSRStatus = lsrData.account.status;
      const accountLSRPercent = lsrData.account.percentChange;
      const positionLSRValue = lsrData.position.value !== null ? lsrData.position.value.toFixed(2) : '--';
      const positionLSRStatus = lsrData.position.status;
      const positionLSRPercent = lsrData.position.percentChange;

      // Open Interest
      const oi5m = await fetchOpenInterest(symbol, '5m');
      const oi15m = await fetchOpenInterest(symbol, '15m');
      const oi1h = await fetchOpenInterest(symbol, '1h');
      const totalOI = await fetchTotalOpenInterest(symbol);

      // Funding Rate
      const fundingRateData = await fetchFundingRate(symbol);
      const fundingRate = fundingRateData.current !== null ? (fundingRateData.current * 100).toFixed(4) : '--';
      const fundingStatus = fundingRateData.status;

      // Order Book
      const orderBook = await fetchOrderBook(symbol);
      const price = ohlcv1h[ohlcv1h.length - 1][4];
      const format = v => price < 1 ? v.toFixed(8) : price < 10 ? v.toFixed(6) : price < 100 ? v.toFixed(4) : v.toFixed(2);

      // Indicadores
      const estocasticoD = calculateStochastic(ohlcvDiario.map(c => ({ high: c[2], low: c[3], close: c[4] })), 5, 3, 3);
      const estocastico4h = calculateStochastic(ohlcv4h.map(c => ({ high: c[2], low: c[3], close: c[4] })), 5, 3, 3);
      const zonas = detectarQuebraEstrutura(ohlcv15m.map(c => ({ high: c[2], low: c[3], volume: c[5] })));
      const rsi1h = calculateRSI(ohlcv1h.map(c => ({ close: c[4] })));
      const rsi15m = calculateRSI(ohlcv15m.map(c => ({ close: c[4] })));
      const cvd15m = calculateCVD(ohlcv15m);
      const obv15m = calculateOBV(ohlcv15m);

      const cvd15mStatus = cvd15m > 0 ? "⬆️ Bullish" : cvd15m < 0 ? "⬇️ Bearish" : "➡️ Neutro";
      const obv15mStatus = obv15m > 0 ? "⬆️ Bullish" : obv15m < 0 ? "⬇️ Bearish" : "➡️ Neutro";
      const rsi1hVal = rsi1h && rsi1h.length ? rsi1h[rsi1h.length - 1].toFixed(2) : '--';
      const rsi15mVal = rsi15m && rsi15m.length ? rsi15m[rsi15m.length - 1].toFixed(2) : '--';
      const rsi1hEmoji = rsi1h && rsi1h.length ? (rsi1h[rsi1h.length - 1] > 60 ? "🔴" : rsi1h[rsi1h.length - 1] < 40 ? "🟢" : "") : "";

      // Estocástico
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

      // Formatar Order Book
      const bidText = orderBook.bids.length > 0
        ? orderBook.bids.map(bid => `${format(bid.price)} (${bid.amount.toFixed(2)} ${symbol.split('USDT')[0]})`).join(', ')
        : '--';
      const askText = orderBook.asks.length > 0
        ? orderBook.asks.map(ask => `${format(ask.price)} (${ask.amount.toFixed(2)} ${symbol.split('USDT')[0]})`).join(', ')
        : '--';

      // Montar seção do relatório para o par
      texto += `*${symbol}*\n` +
        `💲 Preço: ${format(price)}\n` +
        `📊 Volume 1H: ${volume1hStatus}\n` +
        `📊 Volume 24H: ${volume24hStatus}\n` +
        `📉 LSR Contas: ${accountLSRValue} ${accountLSRStatus} (${accountLSRPercent}%)\n` +
        `📉 LSR Posições: ${positionLSRValue} ${positionLSRStatus} (${positionLSRPercent}%)\n` +
        `📈 OI Total: ${totalOI ? `$${parseFloat(totalOI).toLocaleString('en-US')}` : '--'} USDT\n` +
        `📈 OI 5m: ${oi5m.value ? oi5m.value.toFixed(2) : '--'} ${symbol.split('USDT')[0]} ${oi5m.status}\n` +
        `📈 OI 15m: ${oi15m.value ? oi15m.value.toFixed(2) : '--'} ${symbol.split('USDT')[0]} ${oi15m.status}\n` +
        `📈 OI 1h: ${oi1h.value ? oi1h.value.toFixed(2) : '--'} ${symbol.split('USDT')[0]} ${oi1h.status}\n` +
        `📊 Funding Rate: ${fundingRate}% ${fundingStatus}\n` +
        `📈 RSI 1H: ${rsi1hVal} ${rsi1hEmoji}\n` +
        `📈 RSI 15M: ${rsi15mVal}\n` +
        `📊 CVD 15M: ${cvd15m.toFixed(2)} ${cvd15mStatus}\n` +
        `📊 OBV 15M: ${obv15m.toFixed(2)} ${obv15mStatus}\n` +
        `📊 Stoch D %K: ${estocasticoD ? estocasticoD.k.toFixed(2) : '--'} ${kDEmoji} ${direcaoKD}\n` +
        `📊 Stoch D %D: ${estocasticoD ? estocasticoD.d.toFixed(2) : '--'} ${dDEmoji} ${direcaoDD}\n` +
        `📊 Stoch 4H %K: ${estocastico4h ? estocastico4h.k.toFixed(2) : '--'} ${k4hEmoji} ${direcaoK4h}\n` +
        `📊 Stoch 4H %D: ${estocastico4h ? estocastico4h.d.toFixed(2) : '--'} ${d4hEmoji} ${direcaoD4h}\n` +
        `🔹 Estrutura de Baixa: ${format(zonas.estruturaBaixa) || '--'} | 🔹 Rompimento de Alta: ${format(zonas.estruturaAlta) || '--'}\n` +
        `📖 *Order Book (Top 5)*\n` +
        `🟢 Bids: ${bidText}\n` +
        `🔴 Asks: ${askText}\n` +
        `📊 Volume Bids: ${orderBook.totalBidVolume.toFixed(2)} ${symbol.split('USDT')[0]} | Asks: ${orderBook.totalAskVolume.toFixed(2)} ${symbol.split('USDT')[0]}\n\n`;
    }

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
  logger.info('Iniciando monitor de status BTCUSDT, ETHUSDT e BTCDOMUSDT');
  try {
    await bot.api.sendMessage(TELEGRAM_CHAT_ID, '🤖 Titanium Radar - BTCUSDT, ETHUSDT, BTCDOMUSDT');
    await sendStatusReport(); // Envia relatório inicial
    setInterval(sendStatusReport, INTERVALO_RELATORIO_15M_MS); // A cada 15 minutos
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`);
  }
}

main();