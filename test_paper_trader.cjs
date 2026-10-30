'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const PaperTrader = require('./paper_trader.js');

function risingTicker(symbol, price, time) {
  return { s: symbol, c: String(price * (1 + time / 6000000)), P: '2', q: '10000000' };
}

test('opens a bounded paper position only after sustained liquid-market momentum', () => {
  const account = PaperTrader.createAccount();
  let events = [];
  for (let time = 0; time <= 70000; time += 10000) {
    events.push(...PaperTrader.update(account, [risingTicker('BTCUSDT', 100, time)], time));
  }

  assert.equal(events.filter(event => event.type === 'OPEN').length, 1);
  assert.equal(events.find(event => event.type === 'OPEN').leverage, 5);
  assert.equal(Object.keys(account.positions).length, 1);
  assert.ok(events.find(event => event.type === 'OPEN').margin <= PaperTrader.STARTING_BALANCE * 0.1);
  assert.equal(account.trades.filter(trade => trade.type === 'OPEN').length, 1);
});

test('closes on stop loss and accounts for both paper fees', () => {
  const account = PaperTrader.createAccount();
  let entry;
  for (let time = 0; time <= 70000; time += 10000) {
    const events = PaperTrader.update(account, [risingTicker('BTCUSDT', 100, time)], time);
    entry ||= events.find(event => event.type === 'OPEN');
  }
  assert.ok(entry);

  const stoppedPrice = entry.price * 0.993;
  const events = PaperTrader.update(account, [
    { s: 'BTCUSDT', c: String(stoppedPrice), P: '2', q: '10000000' }
  ], 80000);

  assert.equal(events[0].type, 'CLOSE');
  assert.equal(events[0].reason, 'stop-loss');
  assert.equal(Object.keys(account.positions).length, 0);
  assert.equal(account.trades.length, 2);
  assert.ok(account.feesPaid > 0);
  assert.ok(account.walletBalance < PaperTrader.STARTING_BALANCE);
});

test('pausing blocks new entries but keeps monitoring open positions', () => {
  const account = PaperTrader.createAccount();
  account.autoEnabled = false;

  for (let time = 0; time <= 70000; time += 10000) {
    const events = PaperTrader.update(account, [risingTicker('BTCUSDT', 100, time)], time);
    assert.equal(events.some(event => event.type === 'OPEN'), false);
  }
  assert.equal(Object.keys(account.positions).length, 0);

  account.autoEnabled = true;
  const entry = PaperTrader.update(account, [risingTicker('BTCUSDT', 100, 80000)], 80000)
    .find(event => event.type === 'OPEN');
  assert.ok(entry);

  account.autoEnabled = false;
  const events = PaperTrader.update(account, [
    { s: 'BTCUSDT', c: String(entry.price * 0.993), P: '2', q: '10000000' }
  ], 90000);

  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'CLOSE');
  assert.equal(events[0].reason, 'stop-loss');
  assert.equal(Object.keys(account.positions).length, 0);
});

test('limits concurrent positions and validates leverage choices', () => {
  const account = PaperTrader.createAccount();
  PaperTrader.setLeverage(account, 100);
  let time = 0;
  let maxOpen = 0;
  for (let index = 0; index < 8; index += 1) {
    const tickers = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((symbol, symbolIndex) =>
      risingTicker(symbol, 100 + symbolIndex, time));
    PaperTrader.update(account, tickers, time);
    maxOpen = Math.max(maxOpen, Object.keys(account.positions).length);
    time += 30000;
  }

  assert.equal(maxOpen, PaperTrader.MAX_POSITIONS);
  assert.ok(account.trades.filter(trade => trade.type === 'OPEN').every(trade => trade.leverage === 100));
  const usedMargin = Object.values(account.positions).reduce((total, position) => total + position.margin, 0);
  assert.ok(usedMargin <= PaperTrader.equity(account) * 0.3);
  assert.throws(() => PaperTrader.setLeverage(account, 25), RangeError);
});

test('restores persisted account without stale market history', () => {
  const account = PaperTrader.createAccount();
  account.priceHistory.BTCUSDT = [{ time: 1, price: 2 }];

  const restored = PaperTrader.restoreAccount(PaperTrader.accountSnapshot(account));

  assert.deepEqual(restored.priceHistory, {});
  assert.equal(restored.walletBalance, PaperTrader.STARTING_BALANCE);
  assert.throws(() => PaperTrader.restoreAccount({}), TypeError);
});
