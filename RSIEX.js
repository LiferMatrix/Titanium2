require('dotenv').config();
const ccxt = require('ccxt');
const { Bot } = require('grammy');

// ================= CONFIGURAÇÃO ================= //
const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  PARES_MONITORADOS: (process.env.COINS || "BSWUSDT,THEUSDT,BTCUSDT").split(","), // Focado em BSWUSDT e THEUSDT
  INTERVALO_ALERTA_MS: 600000, // 10 minutos
  TEMPO_COOLDOWN_MS: 10 * 60 * 1000, // 10 minutos
  RSI_PERIOD: 14,
  RSI_HIGH_THRESHOLD: 75,
  RSI_LOW_THRESHOLD: 25,
  MIN_CANDLES: 20,
  CANDLES_TO_FETCH: 30,
};

// Logger com debug detalhado
const logger = {
  info: console.log,
  warn: console.warn,
  error: console.error,
  debug: (msg, data) => console.log(`[DEBUG] ${msg}`, JSON.stringify(data, null, 2))
};

// Estado global
const state = {
  ultimoAlertaPorAtivo: {},
  isConnected: false,
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
let bot = new Bot(config.TELEGRAM_BOT_TOKEN);
let exchangeSpot = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_SECRET_KEY,
  enableRateLimit: true,
  timeout: 30000,
  options: { defaultType: 'spot' }
});

// ================= UTILITÁRIOS ================= //
async function withRetry(fn, retries = 5, delayBase = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      logger.error(`Tentativa ${attempt} falhou: ${e.message}`);
      if (attempt === retries) {
        logger.error(`Falha após ${retries} tentativas`);
        throw e;
      }
      const delay = Math.pow(2, attempt - 1) * delayBase;
      logger.info(`Aguardando ${delay}ms antes da próxima tentativa`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function reconnect() {
  let attempts = 0;
  const maxAttempts = 5;
  while (attempts < maxAttempts && !state.isConnected) {
    attempts++;
    logger.info(`Reconexão ${attempts}/${maxAttempts}`);
    try {
      await exchangeSpot.fetchTime();
      await bot.api.getMe();
      state.isConnected = true;
      logger.info('Reconexão bem-sucedida');
      return;
    } catch (e) {
      logger.error(`Falha na reconexão (tentativa ${attempts}): ${e.message}`);
      if (attempts === maxAttempts) {
        logger.error('Máximo de tentativas de reconexão atingido. Encerrando.');
        process.exit(1);
      }
      const delay = Math.pow(2, attempts - 1) * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function escapeMarkdownV2(text) {
  const charsToEscape = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  return text.replace(new RegExp(`([${charsToEscape.join('\\')}])`, 'g'), '\\$1');
}

// ================= INDICADORES ================= //
function normalizeOHLCV(data, symbol, timeframe) {
  if (!data || !Array.isArray(data) || data.length < config.MIN_CANDLES) {
    logger.warn(`Dados OHLCV insuficientes para ${symbol} (${timeframe}): recebido ${data?.length || 0}, necessário ${config.MIN_CANDLES}`);
    return [];
  }

  const normalized = data
    .map(c => ({
      time: c[0],
      close: Number(c[4])
    }))
    .filter(c => !isNaN(c.close) && c.close > 0 && c.time > 0);

  if (normalized.length < config.MIN_CANDLES) {
    logger.warn(`Dados normalizados insuficientes para ${symbol} (${timeframe}): restante ${normalized.length}`);
    return [];
  }

  // Verificar continuidade dos timestamps
  const timeDiff = timeframe === '5m' ? 5 * 60 * 1000 : timeframe === '15m' ? 15 * 60 * 1000 : 60 * 60 * 1000;
  for (let i = 1; i < normalized.length; i++) {
    if (Math.abs(normalized[i].time - normalized[i - 1].time - timeDiff) > 1000) {
      logger.warn(`Discrepância nos timestamps para ${symbol} (${timeframe}): ${new Date(normalized[i - 1].time)} -> ${new Date(normalized[i].time)}`);
      return [];
    }
  }

  // Validar variação dos preços para detectar anomalias
  const closes = normalized.map(c => c.close);
  const maxPrice = Math.max(...closes);
  const minPrice = Math.min(...closes);
  if (maxPrice / minPrice > 10) {
    logger.warn(`Variação anormal nos preços para ${symbol} (${timeframe}): min=${minPrice}, max=${maxPrice}`);
    return [];
  }

  logger.debug(`Preços de fechamento para ${symbol} (${timeframe})`, normalized.slice(-config.RSI_PERIOD).map(c => ({ time: new Date(c.time), close: c.close })));
  return normalized;
}

// Função RSI suavizado (Smoothed RSI, compatível com TradingView)
function calculateSmoothedRSI(closes, period) {
  if (closes.length < period + 1) {
    logger.warn(`Dados insuficientes para RSI suavizado: recebido ${closes.length}, necessário ${period + 1}`);
    return [];
  }

  // Calcular ganhos e perdas
  const gains = [];
  const losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }

  // Primeira média (simples)
  let avgGain = gains.slice(0, period).reduce((sum, g) => sum + g, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((sum, l) => sum + l, 0) / period;

  // Médias suavizadas para os períodos subsequentes
  const rsiValues = [];
  for (let i = period; i < closes.length; i++) {
    const newGain = gains[i - 1];
    const newLoss = losses[i - 1];
    avgGain = (avgGain * (period - 1) + newGain) / period;
    avgLoss = (avgLoss * (period - 1) + newLoss) / period;
    const rs = avgLoss === 0 ? Infinity : avgGain / avgLoss;
    const rsi = rs === Infinity ? 100 : 100 - (100 / (1 + rs));
    rsiValues.push(rsi);
  }

  logger.debug(`RSI suavizado calculado para ${closes.length} candles`, {
    lastAvgGain: avgGain,
    lastAvgLoss: avgLoss,
    lastRS: avgLoss === 0 ? 'Infinity' : avgGain / avgLoss,
    rsi: rsiValues.slice(-1)
  });

  return rsiValues.filter(v => !isNaN(v) && v >= 0 && v <= 100);
}

function calculateRSI(data, symbol, timeframe) {
  if (!data || data.length < config.RSI_PERIOD + 1) {
    logger.warn(`Dados insuficientes para RSI em ${symbol} (${timeframe}): recebido ${data?.length || 0}, necessário ${config.RSI_PERIOD + 1}`);
    return [];
  }

  try {
    const closes = data.map(d => d.close);
    const rsiValues = calculateSmoothedRSI(closes, config.RSI_PERIOD);
    if (rsiValues.length === 0) {
      logger.warn(`Nenhum RSI válido calculado para ${symbol} (${timeframe})`);
      return [];
    }
    logger.debug(`RSI para ${symbol} (${timeframe})`, rsiValues.slice(-5));
    return rsiValues;
  } catch (e) {
    logger.error(`Erro ao calcular RSI para ${symbol} (${timeframe}): ${e.message}`);
    return [];
  }
}

// ================= FUNÇÕES DE ALERTAS ================= //
async function sendAlertRSI(symbol, data) {
  const { price, rsi5m, rsi15m, rsi1h } = data;
  const agora = Date.now();
  if (state.ultimoAlertaPorAtivo[symbol]?.['rsi'] && agora - state.ultimoAlertaPorAtivo[symbol]['rsi'] < config.TEMPO_COOLDOWN_MS) {
    logger.info(`Cooldown ativo para ${symbol}`);
    return;
  }

  if (isNaN(rsi5m) || isNaN(rsi15m) || isNaN(rsi1h) || rsi5m < 0 || rsi5m > 100 || rsi15m < 0 || rsi15m > 100 || rsi1h < 0 || rsi1h > 100) {
    logger.warn(`Valores RSI inválidos para ${symbol}: 5m=${rsi5m}, 15m=${rsi15m}, 1h=${rsi1h}`);
    return;
  }

  logger.info(`RSI para ${symbol}: 5m=${rsi5m.toFixed(2)}, 15m=${rsi15m.toFixed(2)}, 1h=${rsi1h.toFixed(2)}`);

  const precision = price < 1 ? 8 : price < 10 ? 6 : price < 100 ? 4 : 2;
  const isHigh = rsi5m > config.RSI_HIGH_THRESHOLD && rsi15m > config.RSI_HIGH_THRESHOLD && rsi1h > config.RSI_HIGH_THRESHOLD;
  const isLow = rsi5m < config.RSI_LOW_THRESHOLD && rsi15m < config.RSI_LOW_THRESHOLD && rsi1h < config.RSI_LOW_THRESHOLD;
  const emoji = isHigh ? '💥' : isLow ? '❎' : '';

  if (!isHigh && !isLow) {
    logger.info(`Nenhum alerta disparado para ${symbol}`);
    return;
  }

  const alertText = `${emoji} ${escapeMarkdownV2(isHigh ? 'Exaustão - Realizar Lucros/Parcial' : 'Analisar - RSI Baixo')}\n` +
                    `🔹Ativo: ${escapeMarkdownV2(symbol)}\n` +
                    `💲 Preço: ${price.toFixed(precision)}\n` +
                    `🔹 RSI 5m: ${rsi5m.toFixed(2)}\n` +
                    `🔹 RSI 15m: ${rsi15m.toFixed(2)}\n` +
                    `🔹 RSI 1h: ${rsi1h.toFixed(2)}\n` +
                    `${emoji} Monitor @J4Rviz`;

  try {
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, alertText, { parse_mode: 'MarkdownV2' }));
    state.ultimoAlertaPorAtivo[symbol] = { rsi: agora };
    logger.info(`Alerta ${isHigh ? 'exaustão' : 'sobrevenda'} enviado para ${symbol}`);
  } catch (e) {
    logger.error(`Erro ao enviar alerta para ${symbol}: ${e.message}`);
    const plainText = `${emoji} ${isHigh ? 'Exaustão - Realizar Lucros/Parcial' : 'Analisar - RSI Baixo'}\n` +
                      `🔹Ativo: ${symbol}\n` +
                      `💲 Preço: ${price.toFixed(precision)}\n` +
                      `🔹 RSI 5m: ${rsi5m.toFixed(2)}\n` +
                      `🔹 RSI 15m: ${rsi15m.toFixed(2)}\n` +
                      `🔹 RSI 1h: ${rsi1h.toFixed(2)}\n` +
                      `${emoji} Monitor @J4Rviz`;
    try {
      await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, plainText));
      logger.info(`Alerta em texto simples enviado para ${symbol}`);
    } catch (e2) {
      logger.error(`Erro ao enviar alerta em texto simples para ${symbol}: ${e2.message}`);
      await reconnect();
    }
  }
}

// ================= VERIFICAÇÃO ================= //
async function checkConditions() {
  try {
    if (!state.isConnected) {
      logger.warn('Conexão não estabelecida, tentando reconectar...');
      await reconnect();
    }
    for (const symbol of config.PARES_MONITORADOS) {
      logger.info(`Verificando ${symbol}`);
      let ohlcv5mRaw, ohlcv15mRaw, ohlcv1hRaw;
      try {
        // Buscar dados com timestamp atual para alinhamento
        const now = Date.now();
        ohlcv5mRaw = await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '5m', now - config.CANDLES_TO_FETCH * 5 * 60 * 1000, config.CANDLES_TO_FETCH));
        ohlcv15mRaw = await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '15m', now - config.CANDLES_TO_FETCH * 15 * 60 * 1000, config.CANDLES_TO_FETCH));
        ohlcv1hRaw = await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '1h', now - config.CANDLES_TO_FETCH * 60 * 60 * 1000, config.CANDLES_TO_FETCH));
      } catch (e) {
        logger.error(`Erro ao buscar OHLCV para ${symbol}: ${e.message}`);
        continue;
      }

      if (!ohlcv5mRaw || !ohlcv15mRaw || !ohlcv1hRaw) {
        logger.warn(`Dados OHLCV insuficientes para ${symbol}`);
        continue;
      }

      const ohlcv5m = normalizeOHLCV(ohlcv5mRaw, symbol, '5m');
      const ohlcv15m = normalizeOHLCV(ohlcv15mRaw, symbol, '15m');
      const ohlcv1h = normalizeOHLCV(ohlcv1hRaw, symbol, '1h');

      if (ohlcv5m.length < config.MIN_CANDLES || ohlcv15m.length < config.MIN_CANDLES || ohlcv1h.length < config.MIN_CANDLES) {
        logger.warn(`Dados insuficientes após normalização para ${symbol}: 5m=${ohlcv5m.length}, 15m=${ohlcv15m.length}, 1h=${ohlcv1h.length}`);
        continue;
      }

      const rsi5mValues = calculateRSI(ohlcv5m, symbol, '5m');
      const rsi15mValues = calculateRSI(ohlcv15m, symbol, '15m');
      const rsi1hValues = calculateRSI(ohlcv1h, symbol, '1h');

      if (rsi5mValues.length === 0 || rsi15mValues.length === 0 || rsi1hValues.length === 0) {
        logger.warn(`Indicadores RSI insuficientes para ${symbol}`);
        continue;
      }

      const currentPrice = ohlcv5m[ohlcv5m.length - 1].close;
      const rsi5m = rsi5mValues[rsi5mValues.length - 1];
      const rsi15m = rsi15mValues[rsi15mValues.length - 1];
      const rsi1h = rsi1hValues[rsi1hValues.length - 1];

      if (isNaN(rsi5m) || isNaN(rsi15m) || isNaN(rsi1h) || rsi5m < 0 || rsi5m > 100 || rsi15m < 0 || rsi15m > 100 || rsi1h < 0 || rsi1h > 100) {
        logger.warn(`Valores RSI fora do intervalo válido para ${symbol}: 5m=${rsi5m}, 15m=${rsi15m}, 1h=${rsi1h}`);
        continue;
      }

      await sendAlertRSI(symbol, {
        price: currentPrice,
        rsi5m,
        rsi15m,
        rsi1h
      });
    }
  } catch (e) {
    logger.error(`Erro em checkConditions: ${e.message}`);
    await reconnect();
  }
}

// ================= MAIN ================= //
async function main() {
  logger.info('Iniciando RSI Alert Bot');
  try {
    await withRetry(() => bot.api.getMe());
    await withRetry(() => exchangeSpot.fetchTime());
    state.isConnected = true;
    logger.info('Conexão inicial estabelecida');

    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, '🤖 RSI alert 💹 Start...'));
    await checkConditions();
    setInterval(checkConditions, config.INTERVALO_ALERTA_MS);
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`);
    await reconnect();
    setTimeout(main, 1000);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));
