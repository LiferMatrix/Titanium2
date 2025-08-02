require('dotenv').config();
const ccxt = require('ccxt');
const TechnicalIndicators = require('technicalindicators');
const { Bot } = require('grammy');
const winston = require('winston');

// ================= CONFIGURAÇÃO ================= //
const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  PARES_MONITORADOS: (process.env.COINS || "BTCUSDT,ETHUSDT,BNBUSDT").split(","),
  INTERVALO_ALERTA_5M_MS: 300000, // 5 minutos
  TEMPO_COOLDOWN_MS: 15 * 60 * 1000, // 15 minutos
  RSI_PERIOD: 14,
  RSI_HIGH_THRESHOLD: 75,
  RSI_LOW_THRESHOLD: 25,
  CACHE_TTL: 10 * 60 * 1000, // 10 minutos
  MAX_CACHE_SIZE: 100,
  RECONNECT_MAX_ATTEMPTS: 10,
  RECONNECT_DELAY_BASE_MS: 2000,
};

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
  transports: [
    new winston.transports.File({ filename: 'rsi_alert_bot.log' }),
    new winston.transports.Console()
  ]
});

// Estado global
const state = {
  ultimoAlertaPorAtivo: {},
  dataCache: new Map(),
  isConnected: false,
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
        logger.warn(`Erro de rede detectado: ${e.message}. Tentando reconectar...`);
        await reconnect();
      }
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

async function reconnect() {
  let attempts = 0;
  while (attempts < config.RECONNECT_MAX_ATTEMPTS && !state.isConnected) {
    attempts++;
    const delay = Math.pow(2, attempts - 1) * config.RECONNECT_DELAY_BASE_MS;
    logger.info(`Tentativa de reconexão ${attempts}/${config.RECONNECT_MAX_ATTEMPTS}, aguardando ${delay}ms`);

    try {
      // Testar conexão com Binance
      await exchangeSpot.fetchTime();
      logger.info('Conexão com Binance bem-sucedida');

      // Testar conexão com Telegram
      await bot.api.getMe();
      logger.info('Conexão com Telegram bem-sucedida');

      state.isConnected = true;
      logger.info('Reconexão bem-sucedida');
      return;
    } catch (e) {
      logger.error(`Falha na reconexão (tentativa ${attempts}): ${e.message}`);
      if (attempts === config.RECONNECT_MAX_ATTEMPTS) {
        logger.error('Número máximo de tentativas de reconexão atingido. Encerrando processo.');
        process.exit(1);
      }
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Reinicializar cliente do Telegram e Exchange em caso de falha persistente
  try {
    bot = new Bot(config.TELEGRAM_BOT_TOKEN);
    exchangeSpot = new ccxt.binance({
      apiKey: process.env.BINANCE_API_KEY,
      secret: process.env.BINANCE_SECRET_KEY,
      enableRateLimit: true,
      timeout: 30000,
      options: { defaultType: 'spot' }
    });
    logger.info('Clientes Binance e Telegram reinicializados');
  } catch (e) {
    logger.error(`Erro ao reinicializar clientes: ${e.message}`);
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
  if (!data || data.length < config.RSI_PERIOD + 1) return [];
  const rsi = TechnicalIndicators.RSI.calculate({
    period: config.RSI_PERIOD,
    values: data.map(d => d.close || d[4])
  });
  return rsi.filter(v => !isNaN(v));
}

// ================= FUNÇÕES DE ALERTAS ================= //
async function sendAlertRSI(symbol, data) {
  const { ohlcv5m, ohlcv15m, ohlcv1h, price, rsi5m, rsi15m, rsi1h } = data;
  const agora = Date.now();
  if (state.ultimoAlertaPorAtivo[symbol]?.['rsi'] && agora - state.ultimoAlertaPorAtivo[symbol]['rsi'] < config.TEMPO_COOLDOWN_MS) return;

  const precision = price < 1 ? 8 : price < 10 ? 6 : price < 100 ? 4 : 2;
  const format = v => isNaN(v) ? 'N/A' : v.toFixed(precision);
  const tradingViewLink = `https://www.tradingview.com/chart/?symbol=BINANCE:${symbol.replace('/', '')}&interval=5`;

  const isExhaustionSignal = rsi5m > config.RSI_HIGH_THRESHOLD && 
                            rsi15m > config.RSI_HIGH_THRESHOLD && 
                            rsi1h > config.RSI_HIGH_THRESHOLD;
  const isOversoldSignal = rsi5m < config.RSI_LOW_THRESHOLD && 
                          rsi15m < config.RSI_LOW_THRESHOLD && 
                          rsi1h < config.RSI_LOW_THRESHOLD;

  let alertText = `🔹Ativo: *${symbol}* [- TradingView](${tradingViewLink})\n` +
                  `💲 Preço: ${format(price)}\n` +
                  `🔹 RSI 5m: ${rsi5m.toFixed(2)}\n` +
                  `🔹 RSI 15m: ${rsi15m.toFixed(2)}\n` +
                  `🔹 RSI 1h: ${rsi1h.toFixed(2)}\n` +
                  `☑︎ Monitor 🤖 @J4Rviz\n`;

  if (isExhaustionSignal) {
    try {
      await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, `🔴*Exaustão - Realizar Lucros/Parcial\n\n${alertText}`, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }));
      if (!state.ultimoAlertaPorAtivo[symbol]) state.ultimoAlertaPorAtivo[symbol] = {};
      state.ultimoAlertaPorAtivo[symbol]['rsi'] = agora;
      logger.info(`Alerta de exaustão enviado para ${symbol}: RSI 5m=${rsi5m.toFixed(2)}, RSI 15m=${rsi15m.toFixed(2)}, RSI 1h=${rsi1h.toFixed(2)}`);
    } catch (e) {
      logger.error(`Erro ao enviar alerta de exaustão para ${symbol}: ${e.message}`);
      await reconnect();
    }
  } else if (isOversoldSignal) {
    try {
      await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, `🟢*Analisar- RSI Baixo\n\n${alertText}`, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      }));
      if (!state.ultimoAlertaPorAtivo[symbol]) state.ultimoAlertaPorAtivo[symbol] = {};
      state.ultimoAlertaPorAtivo[symbol]['rsi'] = agora;
      logger.info(`Alerta de sobrevenda enviado para ${symbol}: RSI 5m=${rsi5m.toFixed(2)}, RSI 15m=${rsi15m.toFixed(2)}, RSI 1h=${rsi1h.toFixed(2)}`);
    } catch (e) {
      logger.error(`Erro ao enviar alerta de sobrevenda para ${symbol}: ${e.message}`);
      await reconnect();
    }
  }
}

async function checkConditions() {
  try {
    if (!state.isConnected) {
      logger.warn('Conexão não estabelecida, tentando reconectar antes de verificar condições');
      await reconnect();
    }
    await limitConcurrency(config.PARES_MONITORADOS, async (symbol) => {
      const cacheKeyPrefix = `ohlcv_${symbol}`;
      const ohlcv5mRaw = getCachedData(`${cacheKeyPrefix}_5m`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '5m', undefined, config.RSI_PERIOD + 1));
      const ohlcv15mRaw = getCachedData(`${cacheKeyPrefix}_15m`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '15m', undefined, config.RSI_PERIOD + 1));
      const ohlcv1hRaw = getCachedData(`${cacheKeyPrefix}_1h`) || await withRetry(() => exchangeSpot.fetchOHLCV(symbol, '1h', undefined, config.RSI_PERIOD + 1));
      
      setCachedData(`${cacheKeyPrefix}_5m`, ohlcv5mRaw);
      setCachedData(`${cacheKeyPrefix}_15m`, ohlcv15mRaw);
      setCachedData(`${cacheKeyPrefix}_1h`, ohlcv1hRaw);

      if (!ohlcv5mRaw || !ohlcv15mRaw || !ohlcv1hRaw) {
        logger.warn(`Dados OHLCV insuficientes para ${symbol}, pulando...`);
        return;
      }

      const ohlcv5m = normalizeOHLCV(ohlcv5mRaw);
      const ohlcv15m = normalizeOHLCV(ohlcv15mRaw);
      const ohlcv1h = normalizeOHLCV(ohlcv1hRaw);

      const closes5m = ohlcv5m.map(c => c.close).filter(c => !isNaN(c));
      const currentPrice = closes5m[closes5m.length - 1];
      if (isNaN(currentPrice)) {
        logger.warn(`Preço atual inválido para ${symbol}, pulando...`);
        return;
      }

      const rsi5mValues = calculateRSI(ohlcv5m);
      const rsi15mValues = calculateRSI(ohlcv15m);
      const rsi1hValues = calculateRSI(ohlcv1h);

      if (!rsi5mValues.length || !rsi15mValues.length || !rsi1hValues.length) {
        logger.warn(`Indicadores RSI insuficientes para ${symbol}, pulando...`);
        return;
      }

      await sendAlertRSI(symbol, {
        ohlcv5m,
        ohlcv15m,
        ohlcv1h,
        price: currentPrice,
        rsi5m: rsi5mValues[rsi5mValues.length - 1],
        rsi15m: rsi15mValues[rsi15mValues.length - 1],
        rsi1h: rsi1hValues[rsi1hValues.length - 1],
      });
    }, 5);
  } catch (e) {
    logger.error(`Erro ao processar condições: ${e.message}`);
    await reconnect();
  }
}

async function main() {
  logger.info('Iniciando RSI Alert Bot');
  try {
    // Inicializar conexão
    await withRetry(() => bot.api.getMe());
    await withRetry(() => exchangeSpot.fetchTime());
    state.isConnected = true;
    logger.info('Conexão inicial com Binance e Telegram estabelecida');

    await withRetry(() => bot.api.sendMessage(config.TELEGRAM_CHAT_ID, '🤖 RSI alert 💹 Start...'));
    await checkConditions();
    setInterval(checkConditions, config.INTERVALO_ALERTA_5M_MS);
  } catch (e) {
    logger.error(`Erro ao iniciar bot: ${e.message}`);
    await reconnect();
    // Tentar reiniciar o main após reconexão
    setTimeout(main, config.RECONNECT_DELAY_BASE_MS);
  }
}

main().catch(e => logger.error(`Erro fatal: ${e.message}`));
