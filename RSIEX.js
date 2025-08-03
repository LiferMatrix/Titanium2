require('dotenv').config();
const ccxt = require('ccxt');
const TechnicalIndicators = require('technicalindicators');
const { Bot } = require('grammy');

// ================= CONFIGURAÇÃO ================= //
const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  PARES_MONITORADOS: (process.env.COINS || "BTCUSDT,ETHUSDT").split(","),
  INTERVALO_ALERTA_MS: 600000, // 10 minutos
  TEMPO_COOLDOWN_MS: 10 * 60 * 1000, // 10 minutos
  RSI_PERIOD: 14,
  RSI_HIGH_THRESHOLD: 70, // Mantido para teste (reverter para 75 se desejar)
  RSI_LOW_THRESHOLD: 30, // Mantido para teste (reverter para 25 se desejar)
  CACHE_TTL: 10 * 60 * 1000, // 10 minutos
  MAX_CACHE_SIZE: 50,
  RECONNECT_MAX_ATTEMPTS: 5,
  RECONNECT_DELAY_BASE_MS: 2000,
};

// Logger simplificado
const logger = {
  info: console.log,
  warn: console.warn,
  error: console.error
};

// Estado global
const state = {
  ultimoAlertaPorAtivo: {},
  dataCache: new Map(),
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
      if (e.message.includes('network') || e.message.includes('timeout') || e.message.includes('ENOTFOUND') || e.message.includes('ECONNREFUSED')) {
        logger.warn(`Erro de rede: ${e.message}. Tentando reconectar...`);
        await reconnect();
      }
      if (attempt === retries) {
        logger.error(`Falha após ${retries} tentativas: ${e.message}`);
        throw e;
      }
      const delay = Math.pow(2, attempt - 1) * delayBase;
      logger.info(`Tentativa ${attempt} falhou, retry após ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function reconnect() {
  let attempts = 0;
  while (attempts < config.RECONNECT_MAX_ATTEMPTS && !state.isConnected) {
    attempts++;
    const delay = Math.pow(2, attempts - 1) * config.RECONNECT_DELAY_BASE_MS;
    logger.info(`Reconexão ${attempts}/${config.RECONNECT_MAX_ATTEMPTS}, aguardando ${delay}ms`);

    try {
      await exchangeSpot.fetchTime();
      await bot.api.getMe();
      state.isConnected = true;
      logger.info('Reconexão bem-sucedida');
      return;
    } catch (e) {
      logger.error(`Falha na reconexão (tentativa ${attempts}): ${e.message}`);
      if (attempts === config.RECONNECT_MAX_ATTEMPTS) {
        logger.error('Máximo de tentativas de reconexão atingido. Encerrando.');
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

function getCachedData(key) {
  const cacheEntry = state.dataCache.get(key);
  if (cacheEntry && Date.now() - cacheEntry.timestamp < config.CACHE_TTL) {
    if (Array.isArray(cacheEntry.data) && cacheEntry.data.every(c => 
      Array.isArray(c) && c.length === 6 && !isNaN(c[4]) && !isNaN(c[5])
    )) {
      logger.info(`Usando cache válido para ${key}`);
      return cacheEntry.data;
    }
    logger.warn(`Dados inválidos no cache para ${key}, limpando...`);
    state.dataCache.delete(key);
  }
  return null;
}

function setCachedData(key, data) {
  if (state.dataCache.size >= config.MAX_CACHE_SIZE) {
    const oldestKey = state.dataCache.keys().next().value;
    state.dataCache.delete(oldestKey);
    logger.info(`Cache cheio, removido: ${oldestKey}`);
  }
  if (Array.isArray(data) && data.length > 0) {
    state.dataCache.set(key, { timestamp: Date.now(), data });
    logger.info(`Cache atualizado para ${key}`);
  } else {
    logger.warn(`Dados inválidos, não armazenados no cache para ${key}`);
  }
}

function clearCacheOnError(symbol) {
  ['5m', '15m', '1h'].forEach(timeframe => {
    state.dataCache.delete(`ohlcv_${symbol}_${timeframe}`);
    logger.info(`Cache limpo para ${symbol}_${timeframe} após erro`);
  });
}

// Escapar caracteres especiais para MarkdownV2
function escapeMarkdownV2(text) {
  const charsToEscape = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  return text.replace(new RegExp(`([${charsToEscape.join('\\')}])`, 'g'), '\\$1');
}

// ================= INDICADORES ================= //
function normalizeOHLCV(data) {
  if (!data || !Array.isArray(data) || data.length === 0) {
    logger.warn('Dados OHLCV inválidos ou vazios');
    return [];
  }
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
    logger.warn('Dados insuficientes para calcular RSI');
    return [];
  }
  const rsi = TechnicalIndicators.RSI.calculate({
    period: config.RSI_PERIOD,
    values: data.map(d => d.close)
  });
  return rsi.filter(v => !isNaN(v));
}

// ================= FUNÇÕES DE ALERTAS ================= //
async function sendAlertRSI(symbol, data) {
  const { ohlcv5m, ohlcv15m, ohlcv1h, price, rsi5m, rsi15m, rsi1h } = data;
  const agora = Date.now();
  if (state.ultimoAlertaPorAtivo[symbol]?.['rsi'] && agora - state.ultimoAlertaPorAtivo[symbol]['rsi'] < config.TEMPO_COOLDOWN_MS) {
    logger.info(`Cooldown ativo para ${symbol}`);
    return;
  }

  logger.info(`Verificando RSI para ${symbol}: 5m=${rsi5m.toFixed(2)}, 15m=${rsi15m.toFixed(2)}, 1h=${rsi1h.toFixed(2)}`);

  const precision = price < 1 ? 8 : price < 10 ? 6 : price < 100 ? 4 : 2;
  const isHigh = rsi5m > config.RSI_HIGH_THRESHOLD && rsi15m > config.RSI_HIGH_THRESHOLD && rsi1h > config.RSI_HIGH_THRESHOLD;
  const isLow = rsi5m < config.RSI_LOW_THRESHOLD && rsi15m < config.RSI_LOW_THRESHOLD && rsi1h < config.RSI_LOW_THRESHOLD;
  const emoji = isHigh ? '💥' : isLow ? '❎' : '';

  if (!isHigh && !isLow) {
    logger.info(`Nenhum alerta disparado para ${symbol}: RSI fora dos limiares (High: ${config.RSI_HIGH_THRESHOLD}, Low: ${config.RSI_LOW_THRESHOLD})`);
    return;
  }

  // Formatação ajustada para corresponder ao exemplo fornecido
  const alertText = `${emoji} ${isHigh ? 'Exaustão - Realizar Lucros/Parcial' : 'Analisar - RSI Baixo'}\n` +
                    `🔹Ativo: ${escapeMarkdownV2(symbol)}\n` +
                    `💲 Preço: ${price.toFixed(precision)}\n` +
                    `🔹 RSI 5m: ${rsi5m.toFixed(2)}\n` +
                    `🔹 RSI 15m: ${rsi15m.toFixed(2)}\n` +
                    `🔹 RSI 1h: ${rsi1h.toFixed(2)}\n` +
                    `${emoji} Monitor @J4Rviz`;

  try {
    logger.info(`Enviando alerta para ${symbol} (isHigh: ${isHigh}, isLow: ${isLow}): ${alertText}`);
    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, alertText, {
      parse_mode: 'MarkdownV2'
    }));
    state.ultimoAlertaPorAtivo[symbol] = { rsi: agora };
    logger.info(`Alerta ${isHigh ? 'exaustão' : 'sobrevenda'} enviado para ${symbol}: RSI 5m=${rsi5m.toFixed(2)}, 15m=${rsi15m.toFixed(2)}, 1h=${rsi1h.toFixed(2)}`);
  } catch (e) {
    logger.error(`Erro ao enviar alerta MarkdownV2 para ${symbol}: ${e.message}`);
    // Fallback para texto simples com formatação idêntica
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
      const cacheKey5m = `ohlcv_${symbol}_5m`;
      const cacheKey15m = `ohlcv_${symbol}_15m`;
      const cacheKey1h = `ohlcv_${symbol}_1h`;
      let ohlcv5mRaw, ohlcv15mRaw, ohlcv1hRaw;
      try {
        ohlcv5mRaw = getCachedData(cacheKey5m) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '5m', undefined, config.RSI_PERIOD + 1));
        ohlcv15mRaw = getCachedData(cacheKey15m) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '15m', undefined, config.RSI_PERIOD + 1));
        ohlcv1hRaw = getCachedData(cacheKey1h) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '1h', undefined, config.RSI_PERIOD + 1));
      } catch (e) {
        logger.error(`Erro ao buscar OHLCV para ${symbol}: ${e.message}`);
        clearCacheOnError(symbol);
        continue;
      }

      if (!ohlcv5mRaw || !ohlcv15mRaw || !ohlcv1hRaw) {
        logger.warn(`Dados OHLCV insuficientes para ${symbol}`);
        clearCacheOnError(symbol);
        continue;
      }

      setCachedData(cacheKey5m, ohlcv5mRaw);
      setCachedData(cacheKey15m, ohlcv15mRaw);
      setCachedData(cacheKey1h, ohlcv1hRaw);

      const ohlcv5m = normalizeOHLCV(ohlcv5mRaw);
      const ohlcv15m = normalizeOHLCV(ohlcv15mRaw);
      const ohlcv1h = normalizeOHLCV(ohlcv1hRaw);

      const rsi5mValues = calculateRSI(ohlcv5m);
      const rsi15mValues = calculateRSI(ohlcv15m);
      const rsi1hValues = calculateRSI(ohlcv1h);

      if (rsi5mValues.length && rsi15mValues.length && rsi1hValues.length) {
        const currentPrice = ohlcv5m[ohlcv5m.length - 1].close;
        const rsi5m = rsi5mValues[rsi5mValues.length - 1];
        const rsi15m = rsi15mValues[rsi15mValues.length - 1];
        const rsi1h = rsi1hValues[rsi1hValues.length - 1];
        logger.info(`RSI para ${symbol}: 5m=${rsi5m.toFixed(2)}, 15m=${rsi15m.toFixed(2)}, 1h=${rsi1h.toFixed(2)}`);
        await sendAlertRSI(symbol, {
          ohlcv5m,
          ohlcv15m,
          ohlcv1h,
          price: currentPrice,
          rsi5m,
          rsi15m,
          rsi1h
        });
      } else {
        logger.warn(`Indicadores RSI insuficientes para ${symbol}`);
      }
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
    setTimeout(main, config.RECONNECT_DELAY_BASE_MS);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));
