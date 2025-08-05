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
  PARES_MONITORADOS: (process.env.COINS || "BTCUSDT,ETHUSDT,BNBUSDT,ENJUSDT").split(","),
};

// ================= LOGGER ================= //
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console()
  ],
});

// ================= INICIALIZAÇÃO ================= //
const binance = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
  enableRateLimit: true,
});
const bot = new Bot(config.TELEGRAM_BOT_TOKEN);

// Parâmetros do CCI, EMAs, RSI e Suporte/Resistência
const cciLength = 20;
const emaShortLength = 4;
const emaLongLength = 13;
const rsiLength = 14; // Período padrão para RSI
const supportResistanceLength = 50; // Período para cálculo de suporte e resistência
const timeframe15m = '15m';
const timeframe1h = '1h';

// Estado para rastrear o último sinal enviado
const lastSignals = {};

// ================= FUNÇÕES DE CÁLCULO ================= //
function calculateCCI(ohlcv) {
  const typicalPrices = ohlcv.map(candle => (candle[2] + candle[3] + candle[4]) / 3); // hlc3
  const cci = TechnicalIndicators.CCI.calculate({
    high: ohlcv.map(c => c[2]),
    low: ohlcv.map(c => c[3]),
    close: ohlcv.map(c => c[4]),
    period: cciLength,
  });
  return cci;
}

function calculateEMA(data, period) {
  return TechnicalIndicators.EMA.calculate({ period, values: data });
}

function calculateRSI(ohlcv, period = rsiLength) {
  const rsi = TechnicalIndicators.RSI.calculate({
    values: ohlcv.map(c => c[4]), // Usar preços de fechamento
    period,
  });
  return rsi;
}

function calculateSupportResistance(ohlcv, period = supportResistanceLength) {
  const recentCandles = ohlcv.slice(-period); // Últimas 'period' velas
  const highs = recentCandles.map(c => c[2]); // Máximas
  const lows = recentCandles.map(c => c[3]);  // Mínimas
  const resistance = Math.max(...highs); // Maior máxima
  const support = Math.min(...lows);    // Menor mínima
  return { support, resistance };
}

// ================= MONITORAMENTO INDIVIDUAL ================= //
async function monitorPair(symbol, index) {
  const symbolWithSlash = symbol.replace('USDT', '/USDT'); // Converter BTCUSDT para BTC/USDT
  try {
    logger.info(`Verificando ${symbol} (${symbolWithSlash})...`);

    // Obter OHLCV para 15m
    let ohlcv15m;
    try {
      ohlcv15m = await binance.fetchOHLCV(symbolWithSlash, timeframe15m, undefined, Math.max(cciLength + emaLongLength + 1, supportResistanceLength));
      if (!ohlcv15m || ohlcv15m.length < Math.max(cciLength + emaLongLength, supportResistanceLength)) {
        logger.warn(`Dados insuficientes para ${symbol} (15m)`);
        await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, `⚠️ Dados insuficientes para ${symbol} (15m).`);
        return;
      }
    } catch (error) {
      logger.warn(`Par ${symbol} (${symbolWithSlash}) não encontrado ou erro na API (15m): ${error.message}`);
      await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, `⚠️ Par ${symbol} não encontrado na Binance (15m).`);
      return;
    }

    // Obter OHLCV para 1h (para RSI)
    let ohlcv1h;
    try {
      ohlcv1h = await binance.fetchOHLCV(symbolWithSlash, timeframe1h, undefined, rsiLength + 1);
      if (!ohlcv1h || ohlcv1h.length < rsiLength) {
        logger.warn(`Dados insuficientes para ${symbol} (1h)`);
        await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, `⚠️ Dados insuficientes para ${symbol} (1h).`);
        return;
      }
    } catch (error) {
      logger.warn(`Par ${symbol} (${symbolWithSlash}) não encontrado ou erro na API (1h): ${error.message}`);
      await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, `⚠️ Par ${symbol} não encontrado na Binance (1h).`);
      return;
    }

    // Calcular CCI (15m)
    const cci = calculateCCI(ohlcv15m);
    if (!cci || cci.length < 2) {
      logger.warn(`CCI não calculado para ${symbol} (15m)`);
      return;
    }

    // Calcular RSI para 15m e 1h
    const rsi15m = calculateRSI(ohlcv15m);
    const rsi1h = calculateRSI(ohlcv1h);
    if (!rsi15m || rsi15m.length < 1 || !rsi1h || rsi1h.length < 1) {
      logger.warn(`RSI não calculado para ${symbol}`);
      return;
    }

    // Calcular EMAs sobre CCI (15m)
    const emaShort = calculateEMA(cci, emaShortLength);
    const emaLong = calculateEMA(cci, emaLongLength);

    if (emaShort.length < 2 || emaLong.length < 2) {
      logger.warn(`EMAs não calculadas para ${symbol}`);
      return;
    }

    // Calcular Suporte e Resistência (15m)
    const { support, resistance } = calculateSupportResistance(ohlcv15m);

    const emaShortCurrent = emaShort[emaShort.length - 1];
    const emaShortPrevious = emaShort[emaShort.length - 2];
    const emaLongCurrent = emaLong[emaLong.length - 1];
    const emaLongPrevious = emaLong[emaLong.length - 2];

    // Verificar cruzamentos
    const crossover = emaShortPrevious <= emaLongPrevious && emaShortCurrent > emaLongCurrent;
    const crossunder = emaShortPrevious >= emaLongPrevious && emaShortCurrent < emaLongCurrent;

    // Obter preço atual
    let ticker;
    try {
      ticker = await binance.fetchTicker(symbolWithSlash);
      if (!ticker || ticker.last === undefined) {
        logger.warn(`Preço não disponível para ${symbol}`);
        return;
      }
    } catch (error) {
      logger.error(`Erro ao obter ticker para ${symbol}: ${error.message}`);
      return;
    }

    const price = ticker.last.toFixed(8);
    const cciValue = cci[cci.length - 1].toFixed(2);
    const rsi15mValue = rsi15m[rsi15m.length - 1].toFixed(2);
    const rsi1hValue = rsi1h[rsi1h.length - 1].toFixed(2);
    const supportValue = support.toFixed(8);
    const resistanceValue = resistance.toFixed(8);

    // Enviar alertas com critério de RSI e formato profissional
    if (crossover && rsi1hValue < 55 && lastSignals[symbol] !== 'COMPRA') {
      const message = `💹 *CCI Cross Bull: ${symbol}*
- *Preço Atual*: $${price}
- *CCI (15m)*: ${cciValue}
- *RSI (15m)*: ${rsi15mValue}
- *RSI (1h)*: ${rsi1hValue}
- *Suporte *: $${supportValue}
- *Resistência *: $${resistanceValue}
*Data*: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
      await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      lastSignals[symbol] = 'COMPRA';
      logger.info(`Sinal de COMPRA enviado para ${symbol}`);
    } else if (crossunder && rsi1hValue > 60 && lastSignals[symbol] !== 'VENDA') {
      const message = `🔻 *CCI Cross Bear: ${symbol}*
- *Preço Atual*: $${price}
- *CCI (15m)*: ${cciValue}
- *RSI (15m)*: ${rsi15mValue}
- *RSI (1h)*: ${rsi1hValue}
- *Suporte *: $${supportValue}
- *Resistência*: $${resistanceValue}
*Data*: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
      await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
      lastSignals[symbol] = 'VENDA';
      logger.info(`Sinal de VENDA enviado para ${symbol}`);
    }
  } catch (error) {
    logger.error(`Erro ao monitorar ${symbol}: ${error.message}`);
    await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, `❌ Erro ao monitorar ${symbol}: ${error.message}`);
  }
}

// ================= MONITORAMENTO ESCALONADO ================= //
async function monitorCCICrossovers() {
  for (let i = 0; i < config.PARES_MONITORADOS.length; i++) {
    const symbol = config.PARES_MONITORADOS[i];
    // Escalonar com atraso de 5 segundos para evitar sobrecarga
    setTimeout(() => monitorPair(symbol, i), i * 5000);
  }
}

// ================= INICIALIZAÇÃO DO BOT ================= //
async function startBot() {
  try {
    // Limitar a mensagem inicial para evitar erro de comprimento
    const pairCount = config.PARES_MONITORADOS.length;
    const pairsList = pairCount > 5 ? `${config.PARES_MONITORADOS.slice(0, 5).join(', ')} e mais ${pairCount - 5} pares` : config.PARES_MONITORADOS.join(', ');
    await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, `✅ *Titanium Iniciado*\nMonitorando ${pairCount} pares: ${pairsList}`, { parse_mode: 'Markdown' });
    logger.info('Bot iniciado com sucesso');
  } catch (error) {
    logger.error(`Erro ao iniciar o bot: ${error.message}`);
    await bot.api.sendMessage(config.TELEGRAM_CHAT_ID, `❌ Erro ao iniciar o bot: ${error.message}`);
  }

  // Monitorar a cada 15 minutos
  setInterval(monitorCCICrossovers, 15 * 60 * 1000);
  monitorCCICrossovers(); // Executar imediatamente na inicialização
}

// ================= COMANDOS DO TELEGRAM ================= //
bot.command('price', async (ctx) => {
  const coin = ctx.match ? ctx.match.toUpperCase() + 'USDT' : null;
  if (!coin) {
    await ctx.reply('Uso: /price <símbolo> (ex: /price ENJ)');
    return;
  }
  const coinWithSlash = coin.replace('USDT', '/USDT');
  try {
    const ticker = await binance.fetchTicker(coinWithSlash);
    if (ticker && ticker.last !== undefined) {
      await ctx.reply(`${coin}: $${ticker.last.toFixed(2)}`);
      logger.info(`Consulta de preço para ${coin}`);
    } else {
      await ctx.reply(`❌ Par ${coin} não encontrado.`);
    }
  } catch (error) {
    await ctx.reply(`❌ Erro ao obter preço para ${coin}: ${error.message}`);
    logger.error(`Erro na consulta de preço para ${coin}: ${error.message}`);
  }
});

// Iniciar o bot
startBot();

bot.start();
logger.info('Bot está rodando...');
