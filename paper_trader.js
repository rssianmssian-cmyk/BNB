'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.QLEPaperTrader = api;
})(globalThis, function () {
  const VERSION = 1;
  const STARTING_BALANCE = 50;
  const MAX_POSITIONS = 3;
  const MARGIN_PER_POSITION = 0.1;
  const MAX_MARGIN_FRACTION = 0.3;
  const ENTRY_INTERVAL_MS = 30000;
  const COOLDOWN_MS = 120000;
  const SAMPLE_INTERVAL_MS = 10000;
  const MIN_HISTORY_MS = 45000;
  const MAX_HISTORY_MS = 900000;
  const MIN_24H_VOLUME = 5000000;
  const MIN_MOMENTUM = 0.0012;
  const STOP_PERCENT = 0.006;
  const TAKE_PERCENT = 0.012;
  const FEE_RATE = 0.0005;
  const LEVERAGES = [5, 10, 20, 50, 100];

  function createAccount() {
    return {
      version: VERSION,
      walletBalance: STARTING_BALANCE,
      realizedPnl: 0,
      feesPaid: 0,
      leverage: 5,
      autoEnabled: true,
      positions: {},
      trades: [],
      cooldowns: {},
      priceHistory: {},
      lastEntryAt: 0
    };
  }

  function restoreAccount(saved) {
    if (!saved || saved.version !== VERSION ||
        !Number.isFinite(saved.walletBalance) ||
        !Number.isFinite(saved.realizedPnl) ||
        !Number.isFinite(saved.feesPaid) ||
        !LEVERAGES.includes(saved.leverage) ||
        typeof saved.autoEnabled !== 'boolean' ||
        !saved.positions || typeof saved.positions !== 'object' ||
        !Array.isArray(saved.trades) ||
        !saved.cooldowns || typeof saved.cooldowns !== 'object') {
      throw new TypeError('Invalid saved paper-trading account');
    }
    return {
      ...saved,
      priceHistory: {},
      lastEntryAt: Number.isFinite(saved.lastEntryAt) ? saved.lastEntryAt : 0
    };
  }

  function accountSnapshot(account) {
    const { priceHistory, ...snapshot } = account;
    return snapshot;
  }

  function equity(account) {
    return account.walletBalance + Object.values(account.positions)
      .reduce((total, position) => total + (position.unrealizedPnl || 0), 0);
  }

  function update(account, tickers, now = Date.now()) {
    const events = [];
    const quotes = [];

    for (const ticker of tickers) {
      const symbol = ticker?.s;
      const price = Number(ticker?.c);
      if (!symbol || !Number.isFinite(price) || price <= 0) continue;

      const history = account.priceHistory[symbol] || (account.priceHistory[symbol] = []);
      const last = history.at(-1);
      if (!last || now - last.time >= SAMPLE_INTERVAL_MS) {
        history.push({ time: now, price });
      } else {
        last.price = price;
      }
      while (history.length && now - history[0].time > MAX_HISTORY_MS) history.shift();

      quotes.push({ symbol, price, ticker, signal: signalFor(ticker, history, now) });
    }

    for (const quote of quotes) {
      const position = account.positions[quote.symbol];
      if (!position) continue;
      position.unrealizedPnl = position.side === 'LONG'
        ? (quote.price - position.entryPrice) * position.quantity
        : (position.entryPrice - quote.price) * position.quantity;
      position.markPrice = quote.price;

      const stopHit = position.side === 'LONG'
        ? quote.price <= position.stopPrice
        : quote.price >= position.stopPrice;
      const takeHit = position.side === 'LONG'
        ? quote.price >= position.takePrice
        : quote.price <= position.takePrice;
      const reversed = quote.signal && quote.signal.side !== position.side;
      if (stopHit || takeHit || reversed) {
        events.push(closePosition(account, position, quote.price, now,
          stopHit ? 'stop-loss' : takeHit ? 'take-profit' : 'signal-reversal'));
      }
    }

    const openCandidates = quotes
      .filter(quote => !account.positions[quote.symbol] &&
        quote.signal &&
        (account.cooldowns[quote.symbol] || 0) <= now)
      .sort((a, b) => b.signal.strength - a.signal.strength);

    if (account.autoEnabled &&
        Object.keys(account.positions).length < MAX_POSITIONS &&
        openCandidates.length &&
        now - account.lastEntryAt >= ENTRY_INTERVAL_MS) {
      const quote = openCandidates[0];
      const event = openPosition(account, quote.symbol, quote.signal.side, quote.price, now);
      if (event) events.push(event);
    }

    return events;
  }

  function signalFor(ticker, history, now) {
    if (history.length < 4) return null;
    let reference = null;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      if (history[index].time <= now - MIN_HISTORY_MS) {
        reference = history[index];
        break;
      }
    }
    if (!reference || now - reference.time > MIN_HISTORY_MS + SAMPLE_INTERVAL_MS * 2) return null;

    const price = Number(ticker.c);
    const momentum = price / reference.price - 1;
    const dailyChange = Number(ticker.P) / 100;
    const quoteVolume = Number(ticker.q);
    if (!Number.isFinite(dailyChange) || !Number.isFinite(quoteVolume) ||
        quoteVolume < MIN_24H_VOLUME || Math.abs(momentum) < MIN_MOMENTUM ||
        Math.abs(dailyChange) < 0.003 || Math.sign(momentum) !== Math.sign(dailyChange)) {
      return null;
    }
    return { side: momentum > 0 ? 'LONG' : 'SHORT', strength: Math.abs(momentum) };
  }

  function openPosition(account, symbol, side, price, now) {
    const currentEquity = equity(account);
    const usedMargin = Object.values(account.positions)
      .reduce((total, position) => total + position.margin, 0);
    const availableMargin = Math.max(0, currentEquity - usedMargin);
    const margin = Math.min(
      currentEquity * MARGIN_PER_POSITION,
      currentEquity * MAX_MARGIN_FRACTION - usedMargin,
      availableMargin
    );
    if (!Number.isFinite(margin) || margin <= 0) return null;

    const notional = margin * account.leverage;
    const quantity = notional / price;
    const fee = notional * FEE_RATE;
    const position = {
      symbol,
      side,
      leverage: account.leverage,
      margin,
      quantity,
      entryPrice: price,
      markPrice: price,
      stopPrice: side === 'LONG' ? price * (1 - STOP_PERCENT) : price * (1 + STOP_PERCENT),
      takePrice: side === 'LONG' ? price * (1 + TAKE_PERCENT) : price * (1 - TAKE_PERCENT),
      unrealizedPnl: 0,
      openedAt: now
    };
    account.walletBalance -= fee;
    account.feesPaid += fee;
    account.positions[symbol] = position;
    account.lastEntryAt = now;
    const event = { type: 'OPEN', symbol, side, price, quantity, leverage: position.leverage, margin, fee, time: now };
    appendTrade(account, event);
    return event;
  }

  function closePosition(account, position, price, now, reason) {
    const pnl = position.side === 'LONG'
      ? (price - position.entryPrice) * position.quantity
      : (position.entryPrice - price) * position.quantity;
    const fee = position.quantity * price * FEE_RATE;
    account.walletBalance += pnl - fee;
    account.realizedPnl += pnl;
    account.feesPaid += fee;
    delete account.positions[position.symbol];
    account.cooldowns[position.symbol] = now + COOLDOWN_MS;
    const event = { type: 'CLOSE', symbol: position.symbol, side: position.side, price, pnl, fee, reason, time: now };
    appendTrade(account, event);
    return event;
  }

  function appendTrade(account, trade) {
    account.trades.push(trade);
    if (account.trades.length > 500) account.trades.splice(0, account.trades.length - 500);
  }

  function setLeverage(account, leverage) {
    const value = Number(leverage);
    if (!LEVERAGES.includes(value)) throw new RangeError('Demo leverage must be 5x, 10x, 20x, 50x, or 100x');
    account.leverage = value;
  }

  return {
    STARTING_BALANCE,
    MAX_POSITIONS,
    LEVERAGES,
    createAccount,
    restoreAccount,
    accountSnapshot,
    equity,
    update,
    setLeverage
  };
});
