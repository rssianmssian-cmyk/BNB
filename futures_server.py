#!/usr/bin/env python3
"""Local, read-only Binance USDⓈ-M market-data server for the QLE dashboard."""

from __future__ import annotations

import asyncio
import html
import json
import logging
import os
import time
import xml.etree.ElementTree as ET
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from aiohttp import ClientError, ClientSession, ClientTimeout, WSMsgType, web


ROOT = Path(__file__).resolve().parent
REST_BASE = "https://fapi.binance.com"
STREAM_URL = (
    "wss://fstream.binance.com/stream?streams="
    "!ticker@arr/!markPrice@arr@1s/!bookTicker/!forceOrder@arr"
)
INTERVALS = {"1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"}
RSS_FEEDS = (
    ("CoinDesk", "https://www.coindesk.com/arc/outboundfeeds/rss/"),
    ("Cointelegraph", "https://cointelegraph.com/rss"),
)
LOG = logging.getLogger("qle.futures")
RUNTIME_KEY = web.AppKey("runtime", dict)

market_state = {
    "tickers": {},
    "marks": {},
    "books": {},
    "openInterest": {},
    "liquidations": deque(maxlen=200),
    "feedStatus": "connecting",
    "feedSource": None,
    "wsUpdatedAt": 0.0,
    "updatedAt": None,
}
clients: set[web.WebSocketResponse] = set()


def _number(value: object, default: float = 0.0) -> float:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return default
    return result if result == result and abs(result) != float("inf") else default


def active_usdt_perpetuals(exchange_info: dict) -> list[dict]:
    """Return only currently trading Binance USDⓈ-M USDT perpetual contracts."""
    contracts = []
    for symbol in exchange_info.get("symbols", []):
        if (
            symbol.get("status") == "TRADING"
            and symbol.get("contractType") == "PERPETUAL"
            and symbol.get("quoteAsset") == "USDT"
        ):
            contracts.append(
                {
                    "symbol": symbol["symbol"],
                    "baseAsset": symbol.get("baseAsset", ""),
                    "quoteAsset": "USDT",
                    "pricePrecision": symbol.get("pricePrecision", 8),
                    "quantityPrecision": symbol.get("quantityPrecision", 8),
                }
            )
    return sorted(contracts, key=lambda contract: contract["symbol"])


def _ema(values: list[float], period: int) -> list[float | None]:
    result: list[float | None] = [None] * len(values)
    if len(values) < period:
        return result
    average = sum(values[:period]) / period
    result[period - 1] = average
    multiplier = 2 / (period + 1)
    for index in range(period, len(values)):
        average = (values[index] - average) * multiplier + average
        result[index] = average
    return result


def _rsi(values: list[float], period: int = 14) -> float | None:
    if len(values) <= period:
        return None
    changes = [values[index] - values[index - 1] for index in range(1, len(values))]
    gain = sum(max(change, 0) for change in changes[:period]) / period
    loss = sum(max(-change, 0) for change in changes[:period]) / period
    for change in changes[period:]:
        gain = (gain * (period - 1) + max(change, 0)) / period
        loss = (loss * (period - 1) + max(-change, 0)) / period
    if loss == 0:
        return 100.0 if gain > 0 else 50.0
    return 100 - 100 / (1 + gain / loss)


def technical_indicators(candles: list[dict]) -> dict:
    """Compute standard indicators from chronological OHLCV candles."""
    if not candles:
        return {}
    close = [candle["close"] for candle in candles]
    high = [candle["high"] for candle in candles]
    low = [candle["low"] for candle in candles]
    volume = [candle["volume"] for candle in candles]
    typical = [(h + l + c) / 3 for h, l, c in zip(high, low, close)]

    tr = []
    plus_dm = []
    minus_dm = []
    for index in range(len(candles)):
        previous_close = close[index - 1] if index else close[index]
        tr.append(max(high[index] - low[index], abs(high[index] - previous_close), abs(low[index] - previous_close)))
        up_move = high[index] - high[index - 1] if index else 0
        down_move = low[index - 1] - low[index] if index else 0
        plus_dm.append(up_move if up_move > down_move and up_move > 0 else 0)
        minus_dm.append(down_move if down_move > up_move and down_move > 0 else 0)

    ema12 = _ema(close, 12)
    ema26 = _ema(close, 26)
    macd_line = [
        fast - slow if fast is not None and slow is not None else None
        for fast, slow in zip(ema12, ema26)
    ]
    valid_macd = [value for value in macd_line if value is not None]
    macd_signal_values = _ema(valid_macd, 9)
    macd = macd_line[-1]
    macd_signal = macd_signal_values[-1] if macd_signal_values else None

    period = 14
    atr = sum(tr[-period:]) / period if len(tr) >= period else None
    adx = None
    if len(tr) >= period * 2:
        dx_values = []
        for end in range(period, len(tr)):
            true_range = sum(tr[end - period + 1 : end + 1])
            if true_range <= 0:
                continue
            positive = sum(plus_dm[end - period + 1 : end + 1]) / true_range * 100
            negative = sum(minus_dm[end - period + 1 : end + 1]) / true_range * 100
            total = positive + negative
            if total:
                dx_values.append(abs(positive - negative) / total * 100)
        if len(dx_values) >= period:
            adx = sum(dx_values[-period:]) / period

    bollinger = {}
    if len(close) >= 20:
        sample = close[-20:]
        average = sum(sample) / 20
        deviation = (sum((value - average) ** 2 for value in sample) / 20) ** 0.5
        bollinger = {"upper": average + 2 * deviation, "middle": average, "lower": average - 2 * deviation}

    stoch = None
    if len(close) >= period:
        period_high, period_low = max(high[-period:]), min(low[-period:])
        if period_high > period_low:
            stoch = (close[-1] - period_low) / (period_high - period_low) * 100

    vwap_volume = sum(volume)
    vwap = sum(price * amount for price, amount in zip(typical, volume)) / vwap_volume if vwap_volume else None
    quote_volume = sum(candle["quoteVolume"] for candle in candles)
    taker_buy = sum(candle["takerBuyVolume"] for candle in candles)
    return {
        "ema9": _ema(close, 9)[-1],
        "ema20": _ema(close, 20)[-1],
        "ema50": _ema(close, 50)[-1],
        "ema200": _ema(close, 200)[-1],
        "rsi14": _rsi(close),
        "macd": macd,
        "macdSignal": macd_signal,
        "macdHistogram": macd - macd_signal if macd is not None and macd_signal is not None else None,
        "atr14": atr,
        "atrPercent": atr / close[-1] * 100 if atr is not None and close[-1] else None,
        "adx14": adx,
        "bollinger20": bollinger or None,
        "stochastic14": stoch,
        "vwap": vwap,
        "takerBuySellRatio": taker_buy / (sum(candle["volume"] for candle in candles) - taker_buy)
        if 0 < taker_buy < sum(candle["volume"] for candle in candles)
        else None,
        "quoteVolume": quote_volume,
    }


def parse_rss(xml_text: str, source: str) -> list[dict]:
    """Parse RSS 2.0 and Atom headlines without exposing feed markup."""
    root = ET.fromstring(xml_text)
    entries = root.findall(".//item")
    atom_ns = "{http://www.w3.org/2005/Atom}"
    if not entries:
        entries = root.findall(f".//{atom_ns}entry")
    headlines = []
    for entry in entries:
        title = entry.findtext("title") or entry.findtext(f"{atom_ns}title") or ""
        link_element = entry.find("link")
        if link_element is None:
            link_element = entry.find(f"{atom_ns}link")
        link = (
            link_element.get("href", "")
            if link_element is not None and link_element.get("href")
            else link_element.text if link_element is not None else ""
        )
        published = (
            entry.findtext("pubDate")
            or entry.findtext(f"{atom_ns}published")
            or entry.findtext(f"{atom_ns}updated")
            or ""
        )
        title = html.unescape(" ".join(title.split()))
        if title and link.startswith(("https://", "http://")):
            headlines.append({"title": title, "url": link, "published": published, "source": source})
    return headlines


async def _json_request(request: web.Request, path: str, params: dict | None = None):
    session: ClientSession = request.app["session"]
    return await _json_request_with_session(session, path, params)


async def _json_request_with_session(session: ClientSession, path: str, params: dict | None = None):
    async with session.get(f"{REST_BASE}{path}", params=params) as response:
        if response.status >= 400:
            detail = (await response.text())[:300]
            raise RuntimeError(f"Binance HTTP {response.status}: {detail}")
        return await response.json()


async def _contract_universe(app: web.Application, force: bool = False) -> list[dict]:
    runtime = app[RUNTIME_KEY]
    if not force and runtime["contracts"] and time.monotonic() - runtime["contracts_at"] < 3600:
        return runtime["contracts"]
    async with app["session"].get(f"{REST_BASE}/fapi/v1/exchangeInfo") as response:
        response.raise_for_status()
        info = await response.json()
    runtime["contracts"] = active_usdt_perpetuals(info)
    runtime["contract_symbols"] = {contract["symbol"] for contract in runtime["contracts"]}
    runtime["contracts_at"] = time.monotonic()
    return runtime["contracts"]


async def contracts_handler(request: web.Request) -> web.Response:
    try:
        contracts = await _contract_universe(request.app)
    except (ClientError, RuntimeError, asyncio.TimeoutError) as error:
        LOG.warning("Binance exchange information unavailable: %s", error)
        raise web.HTTPBadGateway(text=f"Binance exchange information unavailable: {error}") from error
    return web.json_response({"contracts": contracts, "count": len(contracts), "updatedAt": _utc_now()})


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def news_handler(request: web.Request) -> web.Response:
    runtime = request.app[RUNTIME_KEY]
    if not runtime["news_updated"] or time.monotonic() - runtime["news_at"] > 600:
        await refresh_news(request.app)
    return web.json_response({"items": runtime["news"], "sources": runtime["news_status"], "updatedAt": runtime["news_updated"]})


async def health_handler(request: web.Request) -> web.Response:
    return web.json_response(
        {
            "status": market_state["feedStatus"],
            "feedSource": market_state["feedSource"],
            "updatedAt": market_state["updatedAt"],
            "contractCount": len(request.app[RUNTIME_KEY]["contracts"]),
            "connectedDashboardClients": len(clients),
            "authenticatedRequests": False,
            "orderExecutionEnabled": False,
        }
    )


def _parse_candles(rows: list[list]) -> list[dict]:
    return [
        {
            "time": int(row[0]),
            "open": _number(row[1]),
            "high": _number(row[2]),
            "low": _number(row[3]),
            "close": _number(row[4]),
            "volume": _number(row[5]),
            "quoteVolume": _number(row[7]),
            "trades": int(_number(row[8])),
            "takerBuyVolume": _number(row[9]),
        }
        for row in rows
    ]


async def market_handler(request: web.Request) -> web.Response:
    symbol = request.match_info["symbol"].upper()
    interval = request.query.get("interval", "5m")
    if not symbol.isalnum() or len(symbol) > 30 or interval not in INTERVALS:
        raise web.HTTPBadRequest(text="Symbol ose interval i pavlefshëm")
    try:
        if symbol not in request.app[RUNTIME_KEY]["contract_symbols"]:
            await _contract_universe(request.app)
        if symbol not in request.app[RUNTIME_KEY]["contract_symbols"]:
            raise web.HTTPNotFound(text="Kontrata nuk është aktive USDⓈ-M USDT perpetual")
    except (ClientError, RuntimeError, asyncio.TimeoutError) as error:
        LOG.warning("Binance exchange information unavailable for %s: %s", symbol, error)
        raise web.HTTPBadGateway(text=f"Binance exchange information unavailable: {error}") from error

    endpoints = {
        "candles": ("/fapi/v1/klines", {"symbol": symbol, "interval": interval, "limit": 200}),
        "depth": ("/fapi/v1/depth", {"symbol": symbol, "limit": 20}),
        "openInterest": ("/fapi/v1/openInterest", {"symbol": symbol}),
        "fundingHistory": ("/fapi/v1/fundingRate", {"symbol": symbol, "limit": 8}),
        "accountRatio": ("/futures/data/globalLongShortAccountRatio", {"symbol": symbol, "period": interval, "limit": 1}),
        "takerRatio": ("/futures/data/takerlongshortRatio", {"symbol": symbol, "period": interval, "limit": 1}),
    }
    results = await asyncio.gather(
        *(_json_request(request, path, params) for path, params in endpoints.values()),
        return_exceptions=True,
    )
    values, errors = {}, {}
    for name, result in zip(endpoints, results):
        if isinstance(result, Exception):
            errors[name] = str(result)[:300]
        else:
            values[name] = result
    if "candles" not in values or "depth" not in values:
        raise web.HTTPBadGateway(
            text=json.dumps({"message": "Binance candles/order book unavailable", "sources": errors}),
            content_type="application/json",
        )

    candles = _parse_candles(values["candles"])
    book = values["depth"]
    bids = [[_number(row[0]), _number(row[1])] for row in book.get("bids", [])]
    asks = [[_number(row[0]), _number(row[1])] for row in book.get("asks", [])]
    bid_qty, ask_qty = sum(row[1] for row in bids), sum(row[1] for row in asks)
    best_bid = bids[0][0] if bids else None
    best_ask = asks[0][0] if asks else None
    mid = (best_bid + best_ask) / 2 if best_bid and best_ask else None
    open_interest = values.get("openInterest")
    account_ratio = values.get("accountRatio", [])
    taker_ratio = values.get("takerRatio", [])
    return web.json_response(
        {
            "symbol": symbol,
            "interval": interval,
            "candles": candles,
            "indicators": technical_indicators(candles),
            "orderBook": {
                "bids": bids[:10],
                "asks": asks[:10],
                "bestBid": best_bid,
                "bestAsk": best_ask,
                "spread": best_ask - best_bid if best_bid is not None and best_ask is not None else None,
                "spreadBps": (best_ask - best_bid) / mid * 10000 if mid and best_bid is not None and best_ask is not None else None,
                "imbalance": (bid_qty - ask_qty) / (bid_qty + ask_qty) if bid_qty + ask_qty else None,
            },
            "openInterest": open_interest,
            "fundingHistory": values.get("fundingHistory"),
            "accountLongShortRatio": account_ratio[-1] if account_ratio else None,
            "takerLongShortRatio": taker_ratio[-1] if taker_ratio else None,
            "markPrice": market_state["marks"].get(symbol),
            "ticker": market_state["tickers"].get(symbol),
            "sources": {name: {"ok": name in values, "error": errors.get(name)} for name in endpoints},
            "updatedAt": _utc_now(),
        }
    )


async def _broadcast(message: dict) -> None:
    if not clients:
        return
    encoded = json.dumps(message, separators=(",", ":"))
    stale = []
    for client in tuple(clients):
        try:
            await client.send_str(encoded)
        except (ConnectionError, RuntimeError):
            stale.append(client)
    for client in stale:
        clients.discard(client)


def _cache_market_event(stream: str, data: object) -> dict | None:
    now = _utc_now()
    if stream == "!ticker@arr" and isinstance(data, list):
        for item in data:
            market_state["tickers"][item["s"]] = item
        market_state["updatedAt"] = now
        return {"type": "tickers", "data": data, "updatedAt": now}
    if stream == "!markPrice@arr@1s" and isinstance(data, list):
        for item in data:
            market_state["marks"][item["s"]] = item
        market_state["updatedAt"] = now
        return {"type": "marks", "data": data, "updatedAt": now}
    if stream == "!bookTicker" and isinstance(data, (dict, list)):
        items = data if isinstance(data, list) else [data]
        for item in items:
            market_state["books"][item["s"]] = item
        market_state["updatedAt"] = now
        return {"type": "books", "data": items, "updatedAt": now}
    if stream == "!forceOrder@arr":
        orders = data if isinstance(data, list) else [data]
        fresh = []
        for event in orders:
            order = event.get("o", {})
            if order.get("s"):
                item = {
                    "symbol": order["s"],
                    "side": order.get("S"),
                    "price": _number(order.get("ap") or order.get("p")),
                    "quantity": _number(order.get("z") or order.get("q")),
                    "time": int(_number(event.get("E") or order.get("T"))),
                }
                market_state["liquidations"].append(item)
                fresh.append(item)
        return {"type": "liquidations", "data": fresh, "updatedAt": now}
    return None


def _is_websocket_price_event(event: dict) -> bool:
    return event.get("type") in {"tickers", "marks"}


def _normalize_rest_market_data(
    tickers: list[dict], marks: list[dict], books: list[dict], symbols: set[str]
) -> tuple[list[dict], list[dict], list[dict]]:
    return (
        [
            {
                "s": item["symbol"],
                "c": item.get("lastPrice"),
                "P": item.get("priceChangePercent"),
                "q": item.get("quoteVolume"),
            }
            for item in tickers
            if item.get("symbol") in symbols
        ],
        [
            {
                "s": item["symbol"],
                "p": item.get("markPrice"),
                "r": item.get("lastFundingRate"),
                "i": item.get("indexPrice"),
                "T": item.get("nextFundingTime"),
            }
            for item in marks
            if item.get("symbol") in symbols
        ],
        [
            {
                "s": item["symbol"],
                "b": item.get("bidPrice"),
                "B": item.get("bidQty"),
                "a": item.get("askPrice"),
                "A": item.get("askQty"),
            }
            for item in books
            if item.get("symbol") in symbols
        ],
    )


async def _market_stream_loop(app: web.Application) -> None:
    session: ClientSession = app["session"]
    delay = 1
    while True:
        try:
            async with session.ws_connect(STREAM_URL, heartbeat=30, autoping=True) as upstream:
                delay = 1
                async for message in upstream:
                    if message.type == WSMsgType.TEXT:
                        try:
                            envelope = json.loads(message.data)
                            event = _cache_market_event(envelope.get("stream", ""), envelope.get("data"))
                        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
                            LOG.warning("Discarded malformed Binance market stream message")
                            continue
                        if event:
                            if _is_websocket_price_event(event):
                                market_state["wsUpdatedAt"] = time.monotonic()
                            market_state["feedSource"] = "websocket"
                            was_connected = market_state["feedStatus"] == "connected"
                            market_state["feedStatus"] = "connected"
                            await _broadcast(event)
                            if not was_connected:
                                await _broadcast({"type": "status", "status": "connected", "updatedAt": event["updatedAt"]})
                    elif message.type in (WSMsgType.CLOSED, WSMsgType.ERROR):
                        break
        except asyncio.CancelledError:
            raise
        except (ClientError, asyncio.TimeoutError, OSError) as error:
            LOG.warning("Binance public websocket disconnected: %s", error)
        await asyncio.sleep(delay)
        delay = min(delay * 2, 30)


async def _market_rest_poll_loop(app: web.Application) -> None:
    """Use public REST snapshots only while the faster WebSocket feed is stale."""
    session: ClientSession = app["session"]
    endpoints = (
        ("tickers", "/fapi/v1/ticker/24hr"),
        ("marks", "/fapi/v1/premiumIndex"),
        ("books", "/fapi/v1/ticker/bookTicker"),
    )
    while True:
        try:
            if market_state["wsUpdatedAt"] and time.monotonic() - market_state["wsUpdatedAt"] < 5:
                await asyncio.sleep(2)
                continue
            ws_updated_at = market_state["wsUpdatedAt"]
            await _contract_universe(app)
            results = await asyncio.gather(
                *(_json_request_with_session(session, path) for _, path in endpoints),
                return_exceptions=True,
            )
            if market_state["wsUpdatedAt"] != ws_updated_at or (
                ws_updated_at and time.monotonic() - ws_updated_at < 5
            ):
                await asyncio.sleep(2)
                continue
            successful = 0
            for (name, _), result in zip(endpoints, results):
                if isinstance(result, Exception):
                    LOG.warning("Binance REST %s snapshot unavailable: %s", name, result)
                    continue
                successful += 1

            if successful:
                market_state["feedSource"] = "rest-fallback"
                snapshots = [
                    result if not isinstance(result, Exception) else []
                    for result in results
                ]
                tickers, marks, books = _normalize_rest_market_data(
                    snapshots[0],
                    snapshots[1],
                    snapshots[2],
                    app[RUNTIME_KEY]["contract_symbols"],
                )
                for stream, data in (
                    ("!ticker@arr", tickers),
                    ("!markPrice@arr@1s", marks),
                    ("!bookTicker", books),
                ):
                    event = _cache_market_event(stream, data)
                    if event:
                        await _broadcast(event)

            status = "connected" if successful >= 2 else "reconnecting"
            if status != market_state["feedStatus"]:
                market_state["feedStatus"] = status
                await _broadcast({"type": "status", "status": status, "updatedAt": _utc_now()})
        except asyncio.CancelledError:
            raise
        except (ClientError, RuntimeError, asyncio.TimeoutError, KeyError) as error:
            LOG.warning("Binance REST market refresh failed: %s", error)
            if market_state["feedStatus"] != "reconnecting":
                market_state["feedStatus"] = "reconnecting"
                await _broadcast({"type": "status", "status": "reconnecting", "updatedAt": _utc_now()})
        await asyncio.sleep(10)


async def _open_interest_loop(app: web.Application) -> None:
    """Refresh all-symbol OI slowly to stay below Binance request-weight limits."""
    index = 0
    while True:
        try:
            contracts = await _contract_universe(app)
            if not contracts:
                await asyncio.sleep(30)
                continue
            contract = contracts[index % len(contracts)]
            data = await _json_request_with_session(app["session"], "/fapi/v1/openInterest", {"symbol": contract["symbol"]})
            item = {"symbol": contract["symbol"], "openInterest": _number(data.get("openInterest")), "time": _utc_now()}
            market_state["openInterest"][contract["symbol"]] = item
            await _broadcast({"type": "openInterest", "data": item})
            index += 1
            await asyncio.sleep(0.15)
        except asyncio.CancelledError:
            raise
        except (ClientError, RuntimeError, asyncio.TimeoutError, KeyError) as error:
            LOG.debug("Open-interest refresh deferred: %s", error)
            await asyncio.sleep(2)


async def _news_refresh_loop(app: web.Application) -> None:
    while True:
        await refresh_news(app)
        await asyncio.sleep(300)


async def refresh_news(app: web.Application) -> None:
    async with app["news_lock"]:
        runtime = app[RUNTIME_KEY]
        if runtime["news_at"] and time.monotonic() - runtime["news_at"] < 300:
            return
        runtime["news_at"] = time.monotonic()
        session: ClientSession = app["session"]

        async def fetch_feed(source: str, url: str) -> tuple[list[dict], dict]:
            try:
                async with session.get(url, headers={"User-Agent": "QLE-Market-Research/1.0"}) as response:
                    response.raise_for_status()
                    parsed = parse_rss(await response.text(), source)
                    return parsed[:30], {"source": source, "ok": True, "count": len(parsed)}
            except (ClientError, asyncio.TimeoutError, ET.ParseError, ValueError) as error:
                LOG.warning("RSS source %s unavailable: %s", source, error)
                return [], {"source": source, "ok": False, "error": str(error)[:200]}

        results = await asyncio.gather(*(fetch_feed(source, url) for source, url in RSS_FEEDS))
        items = [item for entries, _ in results for item in entries]
        runtime["news"] = sorted(items, key=lambda item: item["published"], reverse=True)[:50]
        runtime["news_status"] = [status for _, status in results]
        runtime["news_updated"] = _utc_now()


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    socket = web.WebSocketResponse(heartbeat=25, max_msg_size=1024 * 1024)
    await socket.prepare(request)
    clients.add(socket)
    await socket.send_json(
        {
            "type": "snapshot",
            "tickers": market_state["tickers"],
            "marks": market_state["marks"],
            "books": market_state["books"],
            "openInterest": market_state["openInterest"],
            "liquidations": list(market_state["liquidations"]),
            "status": market_state["feedStatus"],
            "feedSource": market_state["feedSource"],
            "updatedAt": market_state["updatedAt"],
        }
    )
    async for message in socket:
        if message.type in (WSMsgType.CLOSE, WSMsgType.ERROR):
            break
    clients.discard(socket)
    return socket


async def _startup(app: web.Application) -> None:
    timeout = ClientTimeout(total=12, connect=5)
    app["session"] = ClientSession(timeout=timeout)
    app[RUNTIME_KEY] = {
        "contracts": [],
        "contract_symbols": set(),
        "contracts_at": 0.0,
        "news": [],
        "news_status": [{"source": name, "ok": False, "error": "Not loaded"} for name, _ in RSS_FEEDS],
        "news_at": 0.0,
        "news_updated": None,
    }
    app["news_lock"] = asyncio.Lock()
    for name, task in (
        ("market_task", _market_stream_loop(app)),
        ("market_rest_task", _market_rest_poll_loop(app)),
        ("open_interest_task", _open_interest_loop(app)),
        ("news_task", _news_refresh_loop(app)),
    ):
        app[name] = asyncio.create_task(task, name=f"qle-{name}")


async def _cleanup(app: web.Application) -> None:
    tasks = [app[key] for key in ("market_task", "market_rest_task", "open_interest_task", "news_task")]
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await app["session"].close()


def create_app() -> web.Application:
    app = web.Application(client_max_size=1024 * 1024)
    app.router.add_get("/api/contracts", contracts_handler)
    app.router.add_get("/api/health", health_handler)
    app.router.add_get("/api/news", news_handler)
    app.router.add_get("/api/market/{symbol}", market_handler)
    app.router.add_get("/ws", websocket_handler)
    app.router.add_get("/", lambda request: web.FileResponse(ROOT / "index.html"))
    for asset in (
        "index.html",
        "app.js",
        "paper_trader.js",
        "styles.css",
        "manifest.webmanifest",
        "icon.svg",
        "apple-touch-icon.png",
        "icon-192.png",
        "icon-512.png",
        "sw.js",
    ):
        app.router.add_get(f"/{asset}", lambda request, name=asset: web.FileResponse(ROOT / name))
    app.on_startup.append(_startup)
    app.on_cleanup.append(_cleanup)
    return app


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("QLE_LOG_LEVEL", "INFO"))
    web.run_app(
        create_app(),
        host=os.getenv("QLE_HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", os.getenv("QLE_PORT", "8000"))),
    )
