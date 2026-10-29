'use strict';
const $ = id => document.getElementById(id);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
const safe = (x, fallback = 0) => Number.isFinite(Number(x)) ? Number(x) : fallback;
const fmt = (x, d = 2) => Number.isFinite(Number(x)) ? Number(x).toLocaleString('en-US', {minimumFractionDigits:d, maximumFractionDigits:d}) : '—';
const money = x => `${x < 0 ? '-$' : '$'}${fmt(Math.abs(x), 2)}`;
const pct = x => `${fmt(x, 2)}%`;
const mean = a => a.length ? a.reduce((s,x)=>s+x,0)/a.length : 0;
const std = a => { const m=mean(a); return Math.sqrt(mean(a.map(x=>(x-m)**2))); };
const sigmoid = x => 1/(1+Math.exp(-clamp(x,-40,40)));
const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DEMO_STARTING_BALANCE = 50;
const DEMO_STORAGE_KEY = 'qle-paper-account-v1';

const state = {
  contracts: [], tickers: new Map(), marks: new Map(), books: new Map(), openInterest: new Map(),
  liquidations: [], selectedSymbol: 'BTCUSDT', detail: null, detailRequest: 0,
  socket: null, socketRetry: 1000, renderTimer: null, detailTimer: null, deferredInstall: null,
  demo: null, demoLastRender: 0, demoStorageWarningShown: false,
  contractsRetryDelay: 1000, contractsRetryTimer: null, contractsFailureShown: false
};

function toast(message) {
  const el=$('toast');el.textContent=message;el.classList.add('show');
  clearTimeout(toast._timer);toast._timer=setTimeout(()=>el.classList.remove('show'),3500);
}
async function fetchJson(url) {
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try {
    const response=await fetch(url,{cache:'no-store',signal:controller.signal});
    if(!response.ok)throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0,200)}`);
    return await response.json();
  } finally {clearTimeout(timeout)}
}
function setConnection(status) {
  const el=$('connection');el.classList.toggle('ok',status==='connected');
  el.innerHTML=`<i></i> ${status==='connected'?'Të dhënat live aktive':status==='reconnecting'?'Rilidhje me Binance…':'Duke lidhur backend-in lokal…'}`;
}
function scheduleRender() {
  if(state.renderTimer)return;
  state.renderTimer=setTimeout(()=>{state.renderTimer=null;renderMarket()},750);
}
function contractBySymbol(symbol) {
  return state.contracts.find(contract=>contract.symbol===symbol);
}
function currentTicker(symbol) {return state.tickers.get(symbol)||null}
function currentMark(symbol) {return state.marks.get(symbol)||null}
function currentBook(symbol) {return state.books.get(symbol)||null}
function currentPrice(symbol) {
  return safe(currentTicker(symbol)?.c,safe(currentMark(symbol)?.p,0));
}
function fundingRate(symbol) {
  const rate=Number(currentMark(symbol)?.r);
  return Number.isFinite(rate)?rate:null;
}
function setFeedTime(timestamp) {
  if(timestamp)$('updatedAt').textContent=`Feed Binance · ${new Date(timestamp).toLocaleTimeString()}`;
}
function initDemoAccount() {
  let saved=null;
  try {
    saved=localStorage.getItem(DEMO_STORAGE_KEY);
  } catch(error) {
    console.error('QLE paper account storage unavailable',error);
    toast('Ruajtja lokale e llogarisë demo nuk është e disponueshme.');
  }
  if(saved) {
    try {state.demo=QLEPaperTrader.restoreAccount(JSON.parse(saved))}
    catch(error) {
      console.error('QLE saved paper account could not be restored',error);
      state.demo=QLEPaperTrader.createAccount();
      toast('Llogaria demo e ruajtur ishte e pavlefshme; u krijua një llogari e re.');
    }
  } else {
    state.demo=QLEPaperTrader.createAccount();
  }
  renderDemoAccount();
}
function saveDemoAccount(force=false) {
  const now=Date.now();
  if(!force&&now-state.demoLastRender<5000)return;
  try {
    localStorage.setItem(DEMO_STORAGE_KEY,JSON.stringify(QLEPaperTrader.accountSnapshot(state.demo)));
    state.demoStorageWarningShown=false;
  } catch(error) {
    console.error('QLE paper account could not be saved',error);
    if(!state.demoStorageWarningShown) {
      state.demoStorageWarningShown=true;
      toast('Nuk u ruajt llogaria demo në këtë shfletues.');
    }
  }
  state.demoLastRender=now;
}
function renderDemoAccount() {
  if(!state.demo)return;
  const positions=Object.values(state.demo.positions);
  const equity=QLEPaperTrader.equity(state.demo);
  const unrealized=positions.reduce((total,position)=>total+position.unrealizedPnl,0);
  const usedMargin=positions.reduce((total,position)=>total+position.margin,0);
  $('demoBalance').textContent=money(state.demo.walletBalance);
  $('demoEquity').textContent=money(equity);
  $('demoPosition').textContent=positions.length
    ?positions.map(position=>`${position.side} ${position.symbol} ${position.leverage}x`).join(' · ')
    :'Asnjë pozicion i hapur';
  $('demoPnL').textContent=money(equity-DEMO_STARTING_BALANCE);
  $('demoTrades').textContent = String(state.demo.trades.length);
  $('demoRisk').textContent=`${positions.length}/${QLEPaperTrader.MAX_POSITIONS} · ${money(usedMargin)} margin`;
  $('demoAutoToggle').textContent=state.demo.autoEnabled?'Ndal auto demo':'Nis auto demo';
  $('demoAutoToggle').classList.toggle('danger',state.demo.autoEnabled);
  $('demoLeverage').value=String(state.demo.leverage);
  $('demoOpenPositions').innerHTML=positions.length
    ?positions.map(position=>`<div class="paper-position"><strong>${escapeHtml(position.side)} ${escapeHtml(position.symbol)}</strong><span>${position.leverage}x · margin ${money(position.margin)} · mark ${fmt(position.markPrice,position.markPrice<1?6:2)} · PnL ${money(position.unrealizedPnl)}</span></div>`).join('')
    :'<p class="muted">Auto-demo po skanon të gjitha kontratat live; pret sinjal të vlefshëm.</p>';
  $('demoOrderHistory').innerHTML=state.demo.trades.length
    ?state.demo.trades.slice(-8).reverse().map(trade=>`<div class="paper-position"><strong>${escapeHtml(trade.type)} ${escapeHtml(trade.side)} ${escapeHtml(trade.symbol)}</strong><span>${fmt(trade.leverage||state.demo.leverage,0)}x · ${fmt(trade.price,trade.price<1?6:2)} · ${new Date(trade.time).toLocaleTimeString()}${trade.reason?` · ${escapeHtml(trade.reason)}`:''}</span></div>`).join('')
    :'<p class="muted">Ende pa urdhra virtualë.</p>';
}
function updateDemoTrading(tickers) {
  if(!state.demo||!tickers?.length)return;
  const events=QLEPaperTrader.update(state.demo,tickers);
  for(const event of events) {
    const message=event.type==='OPEN'
      ?`Demo ${event.side} ${event.symbol} · ${event.leverage}x`
      :`Demo mbylli ${event.symbol} · ${event.reason}`;
    toast(message);
  }
  if(events.length||Date.now()-state.demoLastRender>=5000) {
    renderDemoAccount();
    saveDemoAccount(events.length>0);
  }
}
function applyMarketMessage(message) {
  if(message.type==='snapshot') {
    Object.entries(message.tickers||{}).forEach(([symbol,item])=>state.tickers.set(symbol,item));
    Object.entries(message.marks||{}).forEach(([symbol,item])=>state.marks.set(symbol,item));
    Object.entries(message.books||{}).forEach(([symbol,item])=>state.books.set(symbol,item));
    Object.entries(message.openInterest||{}).forEach(([symbol,item])=>state.openInterest.set(symbol,item));
    state.liquidations=(message.liquidations||[]).slice(-80);
    updateDemoTrading(Object.entries(message.tickers||{}).map(([symbol,item])=>({...item,s:item.s||symbol})));
    setConnection(message.status==='connected'?'connected':'reconnecting');
    setFeedTime(message.updatedAt);renderLiquidations();scheduleRender();return;
  }
  if(message.type==='status') {
    setConnection(message.status);setFeedTime(message.updatedAt);return;
  }
  if(['tickers','marks','books'].includes(message.type)) {
    const target=message.type==='tickers'?state.tickers:message.type==='marks'?state.marks:state.books;
    for(const item of message.data||[])if(item.s)target.set(item.s,item);
    if(message.type==='tickers')updateDemoTrading(message.data);
    if(message.type==='tickers'||message.type==='marks')scheduleRender();
    if(state.detail&&(state.detail.symbol===state.selectedSymbol))renderSelectedLiveValues();
  } else if(message.type==='openInterest') {
    if(message.data?.symbol)state.openInterest.set(message.data.symbol,message.data);
    scheduleRender();
    if(state.detail?.symbol===message.data?.symbol)renderSelectedLiveValues();
  } else if(message.type==='liquidations') {
    state.liquidations.push(...(message.data||[]));state.liquidations=state.liquidations.slice(-200);
    renderLiquidations();
  }
  setFeedTime(message.updatedAt);
}
function connectMarketStream() {
  const protocol=location.protocol==='https:'?'wss:':'ws:';
  const socket=new WebSocket(`${protocol}//${location.host}/ws`);
  state.socket=socket;
  socket.addEventListener('open',()=>{state.socketRetry=1000;setConnection('connected')});
  socket.addEventListener('message',event=>{
    try {applyMarketMessage(JSON.parse(event.data))}
    catch(error){console.error('QLE market stream message error',error)}
  });
  socket.addEventListener('error',()=>socket.close());
  socket.addEventListener('close',()=>{
    if(state.socket===socket)setConnection('reconnecting');
    const delay=state.socketRetry;state.socketRetry=Math.min(state.socketRetry*2,30000);
    setTimeout(connectMarketStream,delay);
  });
}
async function loadContracts() {
  try {
    const response=await fetchJson('/api/contracts');
    if(!Array.isArray(response.contracts))throw new Error('Backend-i ktheu përgjigje të pavlefshme për /api/contracts.');
    state.contracts=response.contracts;
    state.contractsRetryDelay=1000;
    state.contractsFailureShown=false;
    if(state.contractsRetryTimer)clearTimeout(state.contractsRetryTimer);
    state.contractsRetryTimer=null;
    $('contractCount').textContent=fmt(state.contracts.length,0);
    $('activeCount').textContent=fmt(state.contracts.length,0);
    $('scannerStatus').textContent=`${fmt(state.contracts.length,0)} kontrata aktive · Binance USDⓈ-M · USDT perpetual`;
    if(!contractBySymbol(state.selectedSymbol)&&state.contracts.length)state.selectedSymbol=state.contracts[0].symbol;
    scheduleRender();loadSelectedContract();
  } catch(error) {
    console.error('QLE contracts error',error);
    const detail=error.message||String(error);
    const message=error instanceof TypeError
      ?'Backend-i lokal nuk po përgjigjet. Nisni `python3 futures_server.py` dhe hapni dashboard-in në portin 8000.'
      :/HTTP 404\b/.test(detail)
        ?'Endpoint-i /api/contracts mungon. Mos përdorni server statik (`python -m http.server`); nisni `python3 futures_server.py`.'
        :/HTTP (?:502|504)\b/.test(detail)
          ?`Backend-i lokal u arrit, por Binance exchangeInfo dështoi: ${detail}`
          :`Kontratat nuk u ngarkuan: ${detail}`;
    const delay=state.contractsRetryDelay;
    $('scannerStatus').textContent=`${message} Riprovim pas ${Math.ceil(delay/1000)} s…`;
    if(!state.contractsFailureShown)toast(message);
    state.contractsFailureShown=true;
    state.contractsRetryDelay=Math.min(delay*2,30000);
    state.contractsRetryTimer=setTimeout(()=>{
      state.contractsRetryTimer=null;
      loadContracts();
    },delay);
  }
}
function marketRows() {
  const query=$('marketSearch').value.trim().toUpperCase(),sort=$('sortBy').value;
  const contracts=state.contracts.filter(contract=>!query||contract.symbol.includes(query)||contract.baseAsset.toUpperCase().includes(query));
  contracts.sort((a,b)=>{
    const ta=currentTicker(a.symbol)||{},tb=currentTicker(b.symbol)||{};
    if(sort==='symbol')return a.symbol.localeCompare(b.symbol);
    if(sort==='change')return safe(tb.P)-safe(ta.P);
    if(sort==='funding')return (fundingRate(b.symbol)??-Infinity)-(fundingRate(a.symbol)??-Infinity);
    return safe(tb.q)-safe(ta.q);
  });
  return contracts;
}
function renderMarket() {
  const rows=marketRows(),fragment=document.createDocumentFragment();
  let totalVolume=0;const funding=[];
  for(const contract of state.contracts) {
    const ticker=currentTicker(contract.symbol),mark=currentMark(contract.symbol);
    totalVolume+=safe(ticker?.q);
    if(mark&&Number.isFinite(Number(mark.r)))funding.push(Number(mark.r));
  }
  $('totalVolume').textContent=money(totalVolume);
  $('medianFunding').textContent=funding.length?pct(median(funding)*100):'—';
  $('scannerStatus').textContent=`${fmt(rows.length,0)} rezultate · renditur sipas ${$('sortBy').selectedOptions[0]?.textContent||'qarkullimit'}`;
  for(const contract of rows) {
    const ticker=currentTicker(contract.symbol),mark=currentMark(contract.symbol),oi=state.openInterest.get(contract.symbol);
    const price=currentPrice(contract.symbol),change=safe(ticker?.P),volume=safe(ticker?.q);
    const oiNotional=oi&&price?safe(oi.openInterest)*price:null;
    const tr=document.createElement('tr');tr.dataset.symbol=contract.symbol;
    if(contract.symbol===state.selectedSymbol)tr.classList.add('selected');
    tr.innerHTML=`<td><button class="symbol-link" type="button" data-symbol="${escapeHtml(contract.symbol)}"><strong>${escapeHtml(contract.symbol)}</strong><small>${escapeHtml(contract.baseAsset)}/USDT · PERP</small></button></td>
      <td class="numeric">${price?fmt(price,price<1?6:price<100?4:2):'—'}</td>
      <td class="numeric ${change>0?'positive':change<0?'negative':''}">${ticker?pct(change):'—'}</td>
      <td class="numeric ${safe(mark?.r)>0?'positive':safe(mark?.r)<0?'negative':''}">${mark?pct(safe(mark.r)*100):'—'}</td>
      <td class="numeric">${oiNotional===null?'…':money(oiNotional)}</td>
      <td class="numeric">${ticker?money(volume):'—'}</td>`;
    fragment.appendChild(tr);
  }
  const body=$('marketRows');body.replaceChildren(fragment);
  if(!rows.length)body.innerHTML='<tr><td colspan="6" class="muted">Nuk u gjet asnjë kontratë.</td></tr>';
}
function median(values) {
  const sorted=[...values].sort((a,b)=>a-b),mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]:(sorted[mid-1]+sorted[mid])/2;
}
function selectSymbol(symbol) {
  if(!contractBySymbol(symbol))return;
  state.selectedSymbol=symbol;
  $('detailTitle').textContent=symbol;
  renderMarket();loadSelectedContract();
}
async function loadSelectedContract() {
  const symbol=state.selectedSymbol,request=++state.detailRequest,interval=$('interval').value;
  $('detailTitle').textContent=symbol;$('detailStatus').textContent=`Duke ngarkuar OHLCV dhe treguesit ${symbol} ${interval}…`;
  try {
    const detail=await fetchJson(`/api/market/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(interval)}`);
    if(request!==state.detailRequest||symbol!==state.selectedSymbol)return;
    state.detail=detail;renderDetail(detail);
    $('detailStatus').textContent=`Burimet Binance · përditësuar ${new Date(detail.updatedAt).toLocaleTimeString()}`;
  } catch(error) {
    if(request!==state.detailRequest)return;
    console.error('QLE selected contract error',error);
    $('detailStatus').textContent=`Të dhënat e kontratës nuk u ngarkuan: ${error.message}`;
    toast(`Gabim gjatë ngarkimit të ${symbol}.`);
  }
}
function renderSelectedLiveValues() {
  if(!state.detail||state.detail.symbol!==state.selectedSymbol)return;
  const detail=state.detail,ticker=currentTicker(detail.symbol)||detail.ticker,mark=currentMark(detail.symbol)||detail.markPrice;
  const bookTicker=currentBook(detail.symbol),candles=detail.candles.slice();
  const price=currentPrice(detail.symbol);
  if(price&&candles.length) {
    const last=candles.length-1;
    candles[last]={...candles[last],close:price,high:Math.max(candles[last].high,price),low:Math.min(candles[last].low,price)};
  }
  let orderBook=detail.orderBook;
  if(bookTicker?.b&&bookTicker?.a) {
    const bids=[...(orderBook.bids||[]).filter(row=>row[0]!==safe(bookTicker.b)),[safe(bookTicker.b),safe(bookTicker.B)]].sort((a,b)=>b[0]-a[0]).slice(0,20);
    const asks=[...(orderBook.asks||[]).filter(row=>row[0]!==safe(bookTicker.a)),[safe(bookTicker.a),safe(bookTicker.A)]].sort((a,b)=>a[0]-b[0]).slice(0,20);
    const bidQty=bids.reduce((sum,row)=>sum+row[1],0),askQty=asks.reduce((sum,row)=>sum+row[1],0);
    orderBook={...orderBook,bids,asks,bestBid:bids[0]?.[0],bestAsk:asks[0]?.[0],imbalance:(bidQty+askQty)?(bidQty-askQty)/(bidQty+askQty):null};
  }
  const liveDetail={...detail,ticker,markPrice:mark,candles,orderBook};
  renderLiveContract(liveDetail);renderQle(liveDetail);
  if(bookTicker?.b&&bookTicker?.a) {
    const spread=safe(bookTicker.a)-safe(bookTicker.b),mid=(safe(bookTicker.a)+safe(bookTicker.b))/2;
    $('detailSpread').textContent=`${fmt(spread,6)} · ${fmt(mid?spread/mid*10000:0,2)} bps`;
  }
}
function renderLiveContract(detail) {
  const symbol=detail.symbol,ticker=currentTicker(symbol)||detail.ticker,mark=currentMark(symbol)||detail.markPrice;
  const price=currentPrice(symbol)||detail.candles?.at(-1)?.close||0;
  $('detailPrice').textContent=price?`${fmt(price,price<1?6:price<100?4:2)} USDT`:'—';
  $('detailChange').textContent=ticker?`24h ${pct(safe(ticker.P))}`:'24h —';
  $('markPrice').textContent=`Mark ${mark?fmt(safe(mark.p),price<1?6:price<100?4:2):'—'} · Index ${mark?fmt(safe(mark.i),price<1?6:price<100?4:2):'—'}`;
  $('detailFunding').textContent=mark?`${pct(safe(mark.r)*100)} · ${mark.T?new Date(safe(mark.T)).toLocaleTimeString():'—'}`:'—';
  const oi=state.openInterest.get(symbol)||detail.openInterest;
  $('detailOI').textContent=oi?`${fmt(safe(oi.openInterest),4)} ${contractBySymbol(symbol)?.baseAsset||''} · ${price?money(safe(oi.openInterest)*price):'—'}`:'—';
}
function indicatorText(value,d=4) {return value===null||value===undefined?'—':fmt(value,d)}
function renderDetail(detail) {
  renderLiveContract(detail);
  const book=detail.orderBook,ind=detail.indicators||{};
  $('detailSpread').textContent=book?.spread===null||book?.spread===undefined?'—':`${fmt(book.spread,6)} · ${fmt(book.spreadBps,2)} bps`;
  $('detailImbalance').textContent=book?.imbalance===null||book?.imbalance===undefined?'—':pct(book.imbalance*100);
  $('detailAccounts').textContent=detail.accountLongShortRatio?`${fmt(safe(detail.accountLongShortRatio.longShortRatio),3)} · L ${pct(safe(detail.accountLongShortRatio.longAccount)*100)}`:'—';
  $('detailTaker').textContent=detail.takerLongShortRatio?`${fmt(safe(detail.takerLongShortRatio.buySellRatio),3)} · buy ${pct(safe(detail.takerLongShortRatio.buyVol)/(safe(detail.takerLongShortRatio.buyVol)+safe(detail.takerLongShortRatio.sellVol))*100)}`:'—';
  $('indRsi').textContent=indicatorText(ind.rsi14,2);
  $('indMacd').textContent=ind.macd===null||ind.macd===undefined?'—':`${fmt(ind.macd,6)} · hist ${fmt(ind.macdHistogram,6)}`;
  $('indEmaShort').textContent=`${indicatorText(ind.ema9)} / ${indicatorText(ind.ema20)}`;
  $('indEmaLong').textContent=`${indicatorText(ind.ema50)} / ${indicatorText(ind.ema200)}`;
  $('indAtr').textContent=ind.atr14===null||ind.atr14===undefined?'—':`${fmt(ind.atr14,6)} · ${pct(ind.atrPercent)}`;
  $('indAdx').textContent=indicatorText(ind.adx14,2);
  $('indBollinger').textContent=ind.bollinger20?`${fmt(ind.bollinger20.lower,5)} · ${fmt(ind.bollinger20.middle,5)} · ${fmt(ind.bollinger20.upper,5)}`:'—';
  $('indStoch').textContent=indicatorText(ind.stochastic14,2);
  $('indVwap').textContent=indicatorText(ind.vwap,5);
  $('indVolumeRatio').textContent=indicatorText(ind.takerBuySellRatio,3);
  renderOrderBook(book);
  renderFundingHistory(detail.fundingHistory);
  renderQle(detail);
  const unavailable=Object.entries(detail.sources||{}).filter(([,source])=>!source.ok).map(([name])=>name);
  $('detailStatus').textContent=`${detail.candles.length} qirinj · Binance ${detail.interval} · ${new Date(detail.updatedAt).toLocaleTimeString()}${unavailable.length?` · Burime joaktive: ${unavailable.join(', ')}`:''}`;
}
function renderOrderBook(book) {
  if(!book){$('bids').innerHTML='<p class="muted">Libri nuk u ngarkua.</p>';$('asks').innerHTML='<p class="muted">Libri nuk u ngarkua.</p>';return}
  const render=(rows,side)=>rows.map(row=>`<div class="book-row ${side}"><span>${fmt(row[0],row[0]<1?6:4)}</span><span>${fmt(row[1],4)}</span></div>`).join('');
  $('bids').innerHTML=render(book.bids||[],'bid');$('asks').innerHTML=render(book.asks||[],'ask');
}
function renderFundingHistory(rows) {
  if(!rows?.length){$('fundingHistory').innerHTML='<p class="muted">Historiku nuk është i disponueshëm.</p>';return}
  $('fundingHistory').innerHTML=rows.slice().reverse().map(item=>`<div class="event-row"><span>${new Date(safe(item.fundingTime)).toLocaleString()}</span><strong>${pct(safe(item.fundingRate)*100)}</strong></div>`).join('');
}
function renderLiquidations() {
  const recent=state.liquidations.filter(item=>Date.now()-safe(item.time)<60*60*1000).slice(-40).reverse();
  $('liquidationCount').textContent=fmt(recent.length,0);
  $('liquidationWindow').textContent='Ngjarje të kapura · 60 minutat e fundit';
  $('liquidationStatus').textContent=recent.length?'Feed publik aktiv':'Në pritje të ngjarjeve';
  if(!recent.length){$('liquidations').innerHTML='<p class="muted">Ende nuk ka ngjarje të kapura në këtë sesion.</p>';return}
  $('liquidations').innerHTML=recent.map(item=>`<div class="event-row"><span><strong>${escapeHtml(item.symbol)}</strong> · ${item.side==='BUY'?'Likuidim short':'Likuidim long'}</span><span>${money(item.price*item.quantity)} · ${new Date(item.time).toLocaleTimeString()}</span></div>`).join('');
}
function renderNews(response) {
  $('newsUpdated').textContent=response.updatedAt?`Përditësuar ${new Date(response.updatedAt).toLocaleTimeString()}`:'—';
  $('newsSources').innerHTML=(response.sources||[]).map(source=>`<span class="source ${source.ok?'source-ok':'source-error'}">${escapeHtml(source.source)} · ${source.ok?`${source.count} tituj`:'joaktiv'}</span>`).join('');
  if(!response.items?.length){$('newsList').innerHTML='<p class="muted">Nuk ka tituj të disponueshëm; kontrollo statusin e burimeve RSS.</p>';return}
  $('newsList').innerHTML=response.items.slice(0,30).map(item=>`<a class="news-item" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.source)} · ${escapeHtml(item.published||'Koha nuk jepet nga burimi')}</span></a>`).join('');
}
async function loadNews() {
  try {renderNews(await fetchJson('/api/news'))}
  catch(error){console.error('QLE RSS error',error);$('newsUpdated').textContent='Lajmet nuk u ngarkuan';$('newsList').innerHTML=`<p class="muted">${escapeHtml(error.message)}</p>`}
}

function normalizedZ(x,arr){
  const deviation=std(arr);return deviation>1e-9?clamp((x-mean(arr))/deviation,-1,1):0;
}
function booleanSphere(features,deadband=.02){
  const values=[features.c1,features.c5,features.c6,features.c24];
  const bits=values.map(value=>Math.abs(value)<=deadband?0:(value>0?1:0));
  const spins=bits.map(value=>2*value-1);
  const bull=spins.reduce((sum,value)=>sum+(value-1)**2,0),bear=spins.reduce((sum,value)=>sum+(value+1)**2,0);
  return {bits,bias:clamp((bear-bull)/(4*spins.length),-1,1),state:values.every(value=>Math.abs(value)<=deadband)?'NEUTRAL':bull<bear?'LONG':bear<bull?'SHORT':'NEUTRAL',nearZero:values.every(value=>Math.abs(value)<=deadband)};
}
function quantum26(features){
  const c1=clamp(features.change5/30,-1,1),c5=clamp(features.pressure/50,-1,1),c6=clamp(features.acceleration/20,-1,1),c24=clamp(features.flow/100,-1,1);
  const activity=clamp(features.activity,0,50),values=[c5,c1,c6,c24];
  const x03=Math.tanh(2*(.45*c5+.35*c1+.20*c24)),noise=clamp(std(values)*8,0,1);
  const x04=x03*(1-.35*noise),x05=normalizedZ(c5,values),x06=.40*x04+.35*x05+.25*x03;
  const x07=.35*Math.max(0,x06)+.40*(2*sigmoid(4*x06)-1)+.25*Math.tanh(x06);
  const target=.5*c1+.5*c5,x08=x07-.08*(x07-target),x09=x08-.05*(x08-x07);
  const x10=.75*(.35*c5+.30*c1+.20*c6+.15*c24)+.25*Math.tanh(activity/10);
  const x11=.40*c5+.30*c1+.20*c6+.10*c24,base=.5+.5*Math.abs(x11);
  const agreement=mean([x07,x09,x10,x11].map(value=>value>=0?1:-1));
  const x12=clamp(.55*base+.45*Math.abs(agreement),0,1),x14=0,x15=Math.abs(agreement),x16=.60*c5+.40*agreement;
  const vector=[x07,x09,x10,x11],bull=vector.reduce((sum,value)=>sum+(value-1)**2,0),bear=vector.reduce((sum,value)=>sum+(value+1)**2,0);
  const x17=clamp((bear-bull)/8,-1,1),x18=x17>=0?1:-1,x19=.8*x17+.2*x18;
  const x20=mean([x07,x09,x10,x11,x16,x19].map(sign)),x21=.75*x20;
  const x22=clamp(x14*(1-Math.abs(x21)),-.2,.2);
  const x23=clamp(.45*x17+.20*x21+.15*x16+.10*x22+.10*x10,-1,1),levels=[-1,-.5,0,.5,1];
  const x24=levels.reduce((best,value)=>Math.abs(value-x23)<Math.abs(best-x23)?value:best,levels[0]);
  const x25=clamp(.65*x23+.20*x24+.10*x21+.05*x14,-1,1),score=(x25+1)*50;
  const confidence=clamp(.40*x12+.25*x15+.20*Math.abs(x17)+.15*Math.abs(x23),0,1)*100,bs=booleanSphere({c1,c5,c6,c24});
  const direction=bs.nearZero||(score>=45&&score<=55)||bs.state==='NEUTRAL'?'NEUTRAL':score>50?'LONG':'SHORT';
  return {score,confidence,direction,booleanSphere:bs,x25};
}
function computeFeatures(detail) {
  const candles=detail.candles;
  if(!candles||candles.length<3)throw new Error('Nuk ka mjaft qirinj të mbyllur për analizë');
  const previous=candles.at(-2),last=candles.at(-1),book=detail.orderBook;
  const change5=previous.close>0?(last.close-previous.close)/previous.close*100:0;
  const range=last.high-last.low,closeLocation=range>0?((last.close-last.low)/range-.5)*2:0;
  const candleBody=last.open>0?(last.close-last.open)/last.open*100:0;
  const flow=last.volume>0?clamp((last.takerBuyVolume/last.volume-.5)*200,-100,100):0;
  const before=candles.at(-3),priceVelocity=before?.close>0?(previous.close-before.close)/before.close*100:0;
  const acceleration=clamp(change5-priceVelocity,-20,20);
  const visibleLiquidity=[...(book.bids||[]),...(book.asks||[])].reduce((sum,row)=>sum+row[0]*row[1],0);
  return {change5,pressure:clamp(closeLocation*25+candleBody*3+safe(book.imbalance)*25,-50,50),
    acceleration,flow,activity:clamp(last.volume/Math.max(visibleLiquidity/Math.max((book.bestBid+book.bestAsk)/2,1),1)*100,0,50),
    priceVelocity,volumeVelocity:last.volume-previous.volume};
}
function renderQle(detail) {
  try {
    const features=computeFeatures(detail),q=quantum26(features);
    const energy=clamp((Math.abs(features.priceVelocity)+Math.abs(features.acceleration)+Math.abs(features.flow)/10)/3,0,100);
    const frequency=clamp((Math.abs(features.pressure)+Math.abs(features.volumeVelocity)+Math.abs(safe(detail.orderBook.imbalance)*100))/3,0,100);
    const boundary=clamp((.40*Math.abs(q.x25)+.25*Math.abs(features.pressure)/50+.20*Math.abs(features.acceleration)/20+.15*Math.abs(features.flow)/100)*100,0,100);
    $('qleScore').textContent=fmt(q.score,1);$('confidence').textContent=pct(q.confidence);
    $('sphereState').textContent=q.booleanSphere.state;$('boundary').textContent=fmt(boundary,1);
    $('signalText').textContent=q.direction==='NEUTRAL'?'WAIT':q.direction;
    $('signalSub').textContent=`${q.direction} · ${detail.interval}`;
    $('energy').textContent=`${fmt(energy,1)} / ${fmt(frequency,1)} / ${fmt(clamp(std([features.change5,features.priceVelocity,features.acceleration,features.pressure,features.flow/2])*5,0,100),1)}`;
    $('signalRing').style.background=`conic-gradient(${q.direction==='LONG'?'var(--green)':q.direction==='SHORT'?'var(--red)':'var(--cyan)'} ${q.score*3.6}deg,#1c2b40 0deg)`;
  } catch(error) {
    $('qleScore').textContent='—';$('confidence').textContent='—';$('sphereState').textContent='—';$('boundary').textContent='—';
    $('signalText').textContent='WAIT';$('signalSub').textContent=error.message;
  }
}

$('marketSearch').addEventListener('input',scheduleRender);
$('sortBy').addEventListener('change',scheduleRender);
$('marketRows').addEventListener('click',event=>{
  const button=event.target.closest('[data-symbol]');if(button)selectSymbol(button.dataset.symbol);
});
$('interval').addEventListener('change',loadSelectedContract);
$('demoAutoToggle').addEventListener('click',()=>{
  state.demo.autoEnabled=!state.demo.autoEnabled;
  renderDemoAccount();saveDemoAccount(true);
});
$('demoLeverage').addEventListener('change',event=>{
  try {
    QLEPaperTrader.setLeverage(state.demo,event.target.value);
    renderDemoAccount();saveDemoAccount(true);
  } catch(error) {
    console.error('QLE demo leverage update failed',error);
    toast(error.message);
    event.target.value=String(state.demo.leverage);
  }
});
const isIOS=/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const isStandalone=navigator.standalone===true||window.matchMedia('(display-mode: standalone)').matches;
if(isIOS&&!isStandalone) {
  $('installBtn').textContent='Shto në ekran';
  $('installBtn').classList.remove('hidden');
}
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();state.deferredInstall=event;$('installBtn').classList.remove('hidden')});
$('installBtn').addEventListener('click',async()=>{
  if(!state.deferredInstall) {
    if(isIOS)$('installHelp').showModal();
    return;
  }
  await state.deferredInstall.prompt();await state.deferredInstall.userChoice;
  state.deferredInstall=null;$('installBtn').classList.add('hidden');
});
$('installHelpDone').addEventListener('click',()=>$('installHelp').close());
window.addEventListener('appinstalled',()=>$('installBtn').classList.add('hidden'));
if('serviceWorker' in navigator&&location.protocol.startsWith('http'))navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('QLE service worker unavailable',error));
initDemoAccount();
connectMarketStream();loadContracts();loadNews();
state.detailTimer=setInterval(loadSelectedContract,30000);
setInterval(loadNews,300000);
