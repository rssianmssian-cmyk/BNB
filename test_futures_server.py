import asyncio

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

import futures_server
from futures_server import (
    _cache_market_event,
    _normalize_rest_market_data,
    RUNTIME_KEY,
    active_usdt_perpetuals,
    market_state,
    parse_rss,
    technical_indicators,
    _is_websocket_price_event,
)


def test_contract_endpoint_reports_upstream_timeout_as_bad_gateway(monkeypatch):
    async def timeout_contract_universe(*_args, **_kwargs):
        raise asyncio.TimeoutError

    monkeypatch.setattr(futures_server, "_contract_universe", timeout_contract_universe)

    async def request_contracts():
        app = web.Application()
        app[RUNTIME_KEY] = {"contract_symbols": set()}
        app.router.add_get("/api/contracts", futures_server.contracts_handler)
        app.router.add_get("/api/market/{symbol}", futures_server.market_handler)
        client = TestClient(TestServer(app))
        await client.start_server()
        try:
            responses = []
            for path in ("/api/contracts", "/api/market/BTCUSDT"):
                response = await client.get(path)
                responses.append((response.status, await response.text()))
            return responses
        finally:
            await client.close()

    responses = asyncio.run(request_contracts())

    for status, body in responses:
        assert status == 502
        assert "Binance exchange information unavailable" in body


def test_active_usdt_perpetual_filter_excludes_inactive_and_non_usdt_contracts():
    response = {
        "symbols": [
            {"symbol": "BTCUSDT", "baseAsset": "BTC", "quoteAsset": "USDT", "contractType": "PERPETUAL", "status": "TRADING"},
            {"symbol": "ETHUSDT_260925", "baseAsset": "ETH", "quoteAsset": "USDT", "contractType": "CURRENT_QUARTER", "status": "TRADING"},
            {"symbol": "BNBUSDT", "baseAsset": "BNB", "quoteAsset": "USDT", "contractType": "PERPETUAL", "status": "BREAK"},
            {"symbol": "BTCUSD_PERP", "baseAsset": "BTC", "quoteAsset": "USD", "contractType": "PERPETUAL", "status": "TRADING"},
            {"symbol": "ETHUSDT", "baseAsset": "ETH", "quoteAsset": "USDT", "contractType": "PERPETUAL", "status": "TRADING"},
        ]
    }

    contracts = active_usdt_perpetuals(response)

    assert [contract["symbol"] for contract in contracts] == ["BTCUSDT", "ETHUSDT"]


def test_technical_indicators_use_candle_history():
    candles = [
        {
            "open": 100 + index,
            "high": 102 + index,
            "low": 99 + index,
            "close": 101 + index,
            "volume": 10,
            "quoteVolume": 1000 + index * 10,
            "takerBuyVolume": 6,
        }
        for index in range(220)
    ]

    indicators = technical_indicators(candles)

    assert indicators["ema9"] == pytest.approx(316)
    assert indicators["ema20"] == pytest.approx(310.5)
    assert indicators["ema50"] == pytest.approx(295.5)
    assert indicators["rsi14"] == 100
    assert indicators["macd"] > 0
    assert indicators["atr14"] == pytest.approx(3)
    assert indicators["bollinger20"]["middle"] == pytest.approx(310.5)
    assert indicators["stochastic14"] == pytest.approx(93.75)
    assert indicators["takerBuySellRatio"] == pytest.approx(1.5)


def test_rss_parser_sanitizes_title_and_accepts_atom():
    xml = """<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry><title>Bitcoin &amp; markets</title>
        <link href="https://example.com/story"/>
        <updated>2026-10-29T10:00:00Z</updated>
      </entry>
      <entry><title>Unsafe link</title><link href="javascript:alert(1)"/></entry>
    </feed>"""

    headlines = parse_rss(xml, "Example")

    assert headlines == [
        {
            "title": "Bitcoin & markets",
            "url": "https://example.com/story",
            "published": "2026-10-29T10:00:00Z",
            "source": "Example",
        }
    ]


def test_public_stream_updates_ticker_mark_and_liquidation_snapshots():
    market_state["tickers"].clear()
    market_state["marks"].clear()
    market_state["liquidations"].clear()

    ticker_event = _cache_market_event("!ticker@arr", [{"s": "BTCUSDT", "c": "65000"}])
    mark_event = _cache_market_event("!markPrice@arr@1s", [{"s": "BTCUSDT", "p": "65001", "r": "0.0001"}])
    book_event = _cache_market_event("!bookTicker", {"s": "BTCUSDT", "b": "64999", "a": "65001"})
    liquidation_event = _cache_market_event(
        "!forceOrder@arr",
        {"E": 1000, "o": {"s": "BTCUSDT", "S": "SELL", "ap": "64900", "z": "0.2"}},
    )

    assert ticker_event["type"] == "tickers"
    assert market_state["tickers"]["BTCUSDT"]["c"] == "65000"
    assert market_state["marks"]["BTCUSDT"]["p"] == "65001"
    assert _is_websocket_price_event(ticker_event)
    assert _is_websocket_price_event(mark_event)
    assert not _is_websocket_price_event(book_event)
    assert not _is_websocket_price_event(liquidation_event)
    assert book_event["data"][0]["b"] == "64999"
    assert liquidation_event["data"][0]["side"] == "SELL"
    assert len(market_state["liquidations"]) == 1


def test_rest_market_snapshots_normalize_and_filter_contracts():
    tickers, marks, books = _normalize_rest_market_data(
        [
            {"symbol": "BTCUSDT", "lastPrice": "65000", "priceChangePercent": "1.5", "quoteVolume": "1000"},
            {"symbol": "ETHBTC", "lastPrice": "0.05"},
        ],
        [
            {"symbol": "BTCUSDT", "markPrice": "65001", "lastFundingRate": "0.0001", "indexPrice": "64999", "nextFundingTime": 1000},
        ],
        [
            {"symbol": "BTCUSDT", "bidPrice": "64999", "bidQty": "2", "askPrice": "65001", "askQty": "3"},
        ],
        {"BTCUSDT"},
    )

    assert tickers == [{"s": "BTCUSDT", "c": "65000", "P": "1.5", "q": "1000"}]
    assert marks == [{"s": "BTCUSDT", "p": "65001", "r": "0.0001", "i": "64999", "T": 1000}]
    assert books == [{"s": "BTCUSDT", "b": "64999", "B": "2", "a": "65001", "A": "3"}]
