# QLE — Binance USDⓈ-M market scanner

QLE is a local dashboard for active Binance USDⓈ-M USDT perpetual contracts. It streams public market data, computes technical indicators for a selected contract, displays public crypto-news RSS headlines, and includes a local-only paper-trading simulator.

It does not sign Binance requests, read API credentials, access a private account, or place/cancel orders on Binance. The existing Ed25519 PEM is neither needed nor accessed by this dashboard. Do not copy private keys into the browser or commit them.

## Run locally

Python 3.10+ is required.

```bash
python3 -m pip install -r requirements.txt
python3 futures_server.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). The dashboard and its `/api/*` routes must be served by `futures_server.py`; `python3 -m http.server` and GitHub Pages serve only static files and cannot provide `/api/contracts`. In a remote workspace such as Codespaces, run `QLE_HOST=0.0.0.0 python3 futures_server.py`, then open port 8000 from the forwarded ports panel. Public market data and news require an internet connection. Service-worker installation requires localhost or HTTPS.

Run the backend and paper-trading tests with:

```bash
pytest -q
node --test test_paper_trader.cjs
```

## Install on iPhone

Open the application's **HTTPS** URL in Safari, tap **Shto në ekran** (or Safari's Share button → **Add to Home Screen** → **Add**), then launch QLE from the new home-screen icon. iOS does not show the Android-style automatic install prompt, so QLE displays these Safari steps from its install button. The app uses a dedicated Apple touch icon and opens in standalone mode.

The app must be hosted at an HTTPS URL reachable from the iPhone. GitHub Pages can host an installable static shell, but it does not run the Python API; the dashboard needs the Python backend for live data. For a full installable app, serve the Python application behind HTTPS and open that public URL in Safari.

To check the backend, open [http://127.0.0.1:8000/api/health](http://127.0.0.1:8000/api/health) and [http://127.0.0.1:8000/api/contracts](http://127.0.0.1:8000/api/contracts). The second endpoint should return JSON containing a non-empty `contracts` list when Binance USDⓈ-M is reachable. The dashboard retries a failed contract request automatically.

The [`.env.example`](./.env.example) file documents optional settings; the server does not automatically load `.env` or credentials. `QLE_HOST`, `QLE_PORT`, and `QLE_LOG_LEVEL` are read from the process environment.

## Deploy the live app to Render

GitHub Pages hosts only static files and cannot run the Python API or WebSocket. To publish the complete live dashboard, push the project to GitHub, create a **Blueprint** in Render for the repository, and apply the included [`render.yaml`](./render.yaml). Render builds the Python service and serves the dashboard, `/api/*`, and `/ws` from the same HTTPS URL. Open that Render service URL (not the GitHub Pages URL), then verify `/api/health` and `/api/contracts`.

The Render free web service may sleep when idle, so the first request after inactivity can take longer while it starts. GitHub Pages can still publish a static installable shell, but that URL will not have live Binance data; use the Render URL for the full app.

## Live data

- Contract list: Binance USDⓈ-M exchange information, filtered to `TRADING`, `PERPETUAL`, `USDT`.
- Scanner data: all-market 24-hour tickers, mark prices/next funding, best bid/ask and public liquidations. Binance WebSocket is the primary low-latency feed; public REST snapshots are used only when no WebSocket event has arrived recently.
- Selected contract: OHLCV candles, a top-20 order-book snapshot, open interest, funding history, global account long/short ratio and taker buy/sell ratio. These details refresh every 10 seconds; live ticker and book events update the selected view between refreshes.
- Indicators from the selected interval's returned candles: EMA 9/20/50/200, Wilder RSI 14, MACD 12/26/9, ATR 14, ADX 14, Bollinger 20, Stochastic 14, VWAP and taker buy/sell volume ratio.
- News: public CoinDesk and Cointelegraph RSS feeds, checked every 5 minutes. RSS titles may be delayed, incomplete, or unavailable; this is not a real-time newswire.

The scanner lists the whole active contract universe. Open interest is fetched one symbol at a time to limit API request weight. Historical account/taker ratios and funding are loaded only for the selected contract.

## Local paper trading

- The demo starts with a virtual $50 balance and scans live ticker updates across the active contract list. It opens at most three virtual positions, at most one new position every 30 seconds, and uses a shared cross-margin-style paper balance. Positions use simulated stop-loss/take-profit exits and 0.05% fees per fill.
- A paper entry requires at least 45 seconds of sampled price history, short-term momentum aligned with the 24-hour direction, and at least $5 million in 24-hour quote volume. These are experimental screening rules, not a validated strategy.
- The leverage selector (5x–100x) changes only the simulator. It does not retrieve Binance leverage brackets, set exchange leverage, or affect any Binance account. Use 5x for the conservative default.
- Demo balance, positions, and recent fills are saved in this browser's local storage. Clicking **Ndal auto demo** stops new entries; existing simulated positions continue to be monitored for exits.
- The demo does not create USDⓈ-M orders and does not model exchange liquidation, maintenance-margin tiers, slippage, or funding charges.

## Important limits

- “All data” does not mean every Binance internal event. Book depth is a snapshot, the liquidation stream is exchange-aggregated, RSS is not a guaranteed real-time newswire, and indicators are calculations over the selected candle history.
- QLE/Quantum26 scores are experimental heuristics, not calibrated forecasts or trading instructions. Indicators can disagree; values may be missing while Binance sources reconnect or rate-limit requests.
- No bot or formula can reliably know everything happening across every market. Binance order execution, exchange cross-margin changes, exchange leverage changes, and authenticated Binance endpoints are not implemented.
