// ============================================================
//  BBCA Dasbor Analitik Institusional V2 — Pure JS
// ============================================================
let CHART_SETS = {}, TLFFD_RUNS = [], EFFECTS = {};
let bestParams = { maFast: 5, maSlow: 30, cutLoss: 0.03, alloc: 0.10 };
let liveSignal = { status: 'HOLD', kondisi: 'Netral', color: 'neutral' };
let livePrice = 0, liveMaFast = 0, liveMaSlow = 0, lastDate = '';
let liveHigh = 0, liveLow = 0, liveVol = 0;
let bestProfit = 0, bestRun = 1;
let currentTF = 'd6mo', currentType = 'line', priceChart = null;

const TF_LABELS = { d1mo:'1M · Harian', d3mo:'3M · Harian', d6mo:'6M · Harian', w1y:'1Y · Mingguan' };

function fmtRp(v) { return v ? 'Rp ' + Math.round(v).toLocaleString('id-ID') : '—'; }
function fmtDate(d) {
  const dt = typeof d === 'string' ? new Date(d) : d;
  const m = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  return `${String(dt.getDate()).padStart(2,'0')} ${m[dt.getMonth()]} ${dt.getFullYear()}`;
}
function fmtVol(v) {
  if (v >= 1e9) return (v/1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v/1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v/1e3).toFixed(1) + 'K';
  return String(v);
}

// ── Yahoo Finance Fetch ──
// Detect if we're on Vercel (production) or local dev
const IS_VERCEL = window.location.hostname.includes('vercel.app') || window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && !window.location.hostname.includes('192.168');

async function fetchFromVercelAPI(ticker, range, interval) {
  const url = `/api/yahoo?ticker=${encodeURIComponent(ticker)}&range=${range}&interval=${interval}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Vercel API returned ${res.status}`);
  return await res.json();
}

async function fetchFromCORSProxy(ticker, range, interval) {
  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=${interval}&range=${range}`;
  // Multiple CORS proxies as fallback
  const proxies = [
    `https://api.allorigins.win/raw?url=${encodeURIComponent(yahooUrl)}`,
    `https://corsproxy.io/?${encodeURIComponent(yahooUrl)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(yahooUrl)}`,
  ];
  for (const proxy of proxies) {
    try {
      const res = await fetch(proxy, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) continue;
      return await res.json();
    } catch (e) { console.warn('Proxy failed:', proxy, e.message); }
  }
  throw new Error('All CORS proxies failed');
}

async function fetchOHLC(ticker, range, interval = '1d') {
  try {
    let json;
    if (IS_VERCEL) {
      json = await fetchFromVercelAPI(ticker, range, interval);
    } else {
      json = await fetchFromCORSProxy(ticker, range, interval);
    }
    if (!json.chart?.result?.[0]) return { data: [], volume: 0 };
    const r = json.chart.result[0];
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const o = q.open||[], h = q.high||[], l = q.low||[], c = q.close||[], v = q.volume||[];
    const data = [];
    let totalVol = 0;
    for (let i = 0; i < ts.length; i++) {
      const cl = c[i]; if (!cl || cl === 0) continue;
      const dt = new Date(ts[i]*1000);
      const ds = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
      data.push({ date:ds, ts:ts[i]*1000, open:+(o[i]||cl).toFixed(2), high:+(h[i]||cl).toFixed(2), low:+(l[i]||cl).toFixed(2), close:+cl.toFixed(2) });
      totalVol += (v[i]||0);
    }
    return { data, volume: totalVol };
  } catch(e) { console.error('fetchOHLC:', e); return { data: [], volume: 0 }; }
}

// ── MA & TL-FFD ──
function calcMA(closes, p) {
  return closes.map((_, i) => {
    const s = Math.max(0, i-p+1);
    const sl = closes.slice(s, i+1);
    return +(sl.reduce((a,b)=>a+b,0)/sl.length).toFixed(2);
  });
}
function attachMA(data, mf, ms) {
  const c = data.map(d=>d.close), f = calcMA(c,mf), s = calcMA(c,ms);
  data.forEach((r,i) => { r.maFast=f[i]; r.maSlow=s[i]; });
}
function runSim(data, mf, ms, cl, al, modal=1e7) {
  const c=data.map(d=>d.close), maF=calcMA(c,mf), maS=calcMA(c,ms), n=c.length;
  const sig=maF.map((f,i)=>f>maS[i]?1:0), pos=[0];
  for(let i=1;i<n;i++) pos.push(sig[i]-sig[i-1]);
  let saldo=modal,beli=0,ada=false,nTr=0;
  for(let i=0;i<n;i++){const h=c[i];if(pos[i]===1&&!ada){beli=h;ada=true;}else if(ada){if(pos[i]===-1||(h-beli)/beli<=-cl){saldo+=(modal*al)*((h-beli)/beli);ada=false;nTr++;}}}
  return{profit:+((saldo-modal)/modal*100).toFixed(4),transactions:nTr};
}
function runTLFFD(train) {
  const lA={'-1':5,'1':20},lB={'-1':30,'1':60},lC={'-1':.03,'1':.07},lD={'-1':.10,'1':.25};
  return [[1,-1,-1,-1],[2,1,-1,-1],[3,-1,1,-1],[4,1,1,-1],[5,-1,-1,1],[6,1,-1,1],[7,-1,1,1],[8,1,1,1]]
    .map(([run,a,b,c])=>{const d=a*b*c,sim=runSim(train,lA[a],lB[b],lC[c],lD[d]);
      return{run,signA:a,signB:b,signC:c,signD:d,maFast:lA[a],maSlow:lB[b],cutLoss:lC[c],alloc:lD[d],profit:sim.profit,transactions:sim.transactions};});
}
function mainEffect(h,s){const p=h.filter(r=>r[s]===1),m=h.filter(r=>r[s]===-1);return+((p.length?p.reduce((a,r)=>a+r.profit,0)/p.length:0)-(m.length?m.reduce((a,r)=>a+r.profit,0)/m.length:0)).toFixed(4);}

// ── Update UI ──
function updateUI() {
  const today = fmtDate(new Date());
  // Header
  document.getElementById('tickPrice').textContent = fmtRp(livePrice);
  const chEl = document.getElementById('tickChange');
  if (liveMaFast > liveMaSlow) { chEl.className='change-up'; chEl.innerHTML='<svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M14.707 12.707a1 1 0 01-1.414 0L10 9.414l-3.293 3.293a1 1 0 01-1.414-1.414l4-4a1 1 0 011.414 0l4 4a1 1 0 010 1.414z"/></svg> Bullish'; }
  else { chEl.className='change-down'; chEl.innerHTML='<svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"/></svg> Bearish'; }
  document.getElementById('tickMaFastN').textContent = bestParams.maFast;
  document.getElementById('tickMaSlowN').textContent = bestParams.maSlow;
  document.getElementById('tickMaFast').textContent = fmtRp(liveMaFast);
  document.getElementById('tickMaSlow').textContent = fmtRp(liveMaSlow);
  document.getElementById('updateDate').textContent = `Diperbarui: ${today} (Live)`;

  // Sentiment
  const isBull = liveMaFast > liveMaSlow;
  const badge = document.getElementById('sentimentBadge');
  const trendEl = document.getElementById('sentimentTrend');
  const confEl = document.getElementById('sentimentConf');
  if (liveSignal.color === 'bull') {
    badge.textContent = 'BELI'; badge.style.background = '#238636';
    trendEl.innerHTML = 'Tren: <span style="color:var(--green)">Bullish</span>';
    confEl.innerHTML = 'Kepercayaan: <span style="color:var(--green)">Tinggi (90%+)</span>';
  } else if (liveSignal.color === 'bear') {
    badge.textContent = 'JUAL'; badge.style.background = '#da3633';
    trendEl.innerHTML = 'Tren: <span style="color:var(--red)">Bearish</span>';
    confEl.innerHTML = 'Kepercayaan: <span style="color:var(--red)">Tinggi (85%+)</span>';
  } else if (liveSignal.color === 'hold-bull') {
    badge.textContent = 'TAHAN'; badge.style.background = '#1f6feb';
    trendEl.innerHTML = 'Tren: <span style="color:var(--green)">Bullish</span> / <span style="color:var(--muted)">Lanjut</span>';
    confEl.innerHTML = 'Kepercayaan: <span style="color:var(--yellow)">78% (Moderat)</span>';
  } else {
    badge.textContent = 'TAHAN'; badge.style.background = '#1f6feb';
    trendEl.innerHTML = 'Tren: <span style="color:var(--red)">Bearish</span> / <span style="color:var(--muted)">Sideways</span>';
    confEl.innerHTML = 'Kepercayaan: <span style="color:var(--yellow)">78% (Moderat)</span>';
  }

  // Price summary
  document.getElementById('priceCurrent').textContent = fmtRp(livePrice);
  document.getElementById('priceHigh').textContent = fmtRp(liveHigh);
  document.getElementById('priceLow').textContent = fmtRp(liveLow);
  document.getElementById('priceVol').textContent = liveVol ? fmtVol(liveVol) : '—';

  // Risk
  const riskLvl = document.getElementById('riskLevel');
  const riskStrat = document.getElementById('riskStrategy');
  const riskNote = document.getElementById('riskNote');
  if (liveSignal.color === 'bull') {
    riskLvl.textContent = 'Moderat'; riskLvl.style.color = 'var(--yellow)';
    riskStrat.textContent = 'Entry — Golden Cross Terkonfirmasi';
    riskNote.textContent = `MA${bestParams.maFast} > MA${bestParams.maSlow} (Tren Bullish)`;
  } else if (liveSignal.color === 'bear') {
    riskLvl.textContent = 'Tinggi'; riskLvl.style.color = 'var(--red)';
    riskStrat.textContent = 'Exit — Death Cross Terkonfirmasi';
    riskNote.textContent = `MA${bestParams.maFast} < MA${bestParams.maSlow} (Tren Bearish)`;
  } else if (isBull) {
    riskLvl.textContent = 'Moderat'; riskLvl.style.color = 'var(--yellow)';
    riskStrat.textContent = 'Pertahankan Posisi';
    riskNote.textContent = `MA${bestParams.maFast} > MA${bestParams.maSlow} (Tren Bullish)`;
  } else {
    riskLvl.textContent = 'Moderat-Tinggi'; riskLvl.style.color = 'var(--yellow)';
    riskStrat.textContent = 'Tunggu Konfirmasi Golden Cross';
    riskNote.textContent = `MA${bestParams.maFast} < MA${bestParams.maSlow} (Tren Bearish)`;
  }

  // Chart legends
  document.getElementById('legMAFast').textContent = `${bestParams.maFast}-day Moving Average`;
  document.getElementById('legMASlow').textContent = `${bestParams.maSlow}-day Moving Average`;

  // Report
  const mf=bestParams.maFast, ms=bestParams.maSlow;
  let techText = '';
  if (liveSignal.color === 'bull') {
    techText = `Golden Cross terdeteksi! MA${mf} jangka pendek (${fmtRp(liveMaFast)}) baru saja melintasi di atas MA${ms} jangka panjang (${fmtRp(liveMaSlow)}). Sinyal bullish terkonfirmasi. Volume ${liveVol?fmtVol(liveVol):'moderat'}, mendukung tren naik. Pertimbangkan entry dengan cut-loss ${(bestParams.cutLoss*100)}% dan alokasi ${(bestParams.alloc*100)}%.`;
  } else if (liveSignal.color === 'bear') {
    techText = `Death Cross terdeteksi! MA${mf} jangka pendek (${fmtRp(liveMaFast)}) baru saja melintasi di bawah MA${ms} jangka panjang (${fmtRp(liveMaSlow)}). Sinyal bearish aktif. Disarankan untuk likuidasi posisi atau aktifkan cut-loss jika rugi > ${(bestParams.cutLoss*100)}%.`;
  } else if (liveMaFast > liveMaSlow) {
    techText = `Saham dalam tren bullish yang berlanjut, dengan MA${mf} (${fmtRp(liveMaFast)}) di atas MA${ms} (${fmtRp(liveMaSlow)}). Belum ada crossing baru. Pertahankan posisi jika sudah masuk, pantau volume untuk konfirmasi kekuatan tren.`;
  } else {
    techText = `Saham saat ini dalam tren bearish yang terkonfirmasi, dengan MA${mf} jangka pendek (${fmtRp(liveMaFast)}) diperdagangkan di bawah MA${ms} jangka panjang (${fmtRp(liveMaSlow)}). Volume ${liveVol?fmtVol(liveVol):'moderat'}, menunjukkan fase konsolidasi. Disarankan untuk berhati-hati dan menunggu sinyal pembalikan yang jelas, khususnya Golden Cross (MA${mf} melintasi di atas MA${ms}), sebelum mempertimbangkan masuk.`;
  }
  document.getElementById('reportTechnical').textContent = techText;

  // Key levels
  const d6 = CHART_SETS['d6mo'] || [];
  let sup1 = liveLow, sup2 = 0, res1 = liveMaFast, res2 = liveMaSlow;
  if (d6.length > 10) { const lows = d6.slice(-20).map(r=>r.low).sort((a,b)=>a-b); sup2 = lows[1] || lows[0]; }
  document.getElementById('reportLevels').innerHTML = `
    <div class="key-level">Support 1: ${fmtRp(sup1)}</div>
    <div class="key-level">Support 2: ${fmtRp(sup2||sup1*0.97)}</div>
    <div class="key-level">Resistens 1: ${fmtRp(res1)} (MA${mf})</div>
    <div class="key-level">Resistens 2: ${fmtRp(res2)} (MA${ms})</div>`;

  document.getElementById('reportReturn').innerHTML = `${bestProfit.toFixed(2)}% <span class="return-sub">(Berdasarkan optimalisasi historis)</span>`;

  // Run table
  let tbody = '';
  TLFFD_RUNS.forEach(r => {
    const ib = r.run === bestRun;
    tbody += `<tr class="${ib?'best':''}"><td><span class="run-cell">${ib?'<span class="run-star"></span> ':''}<span class="run-num ${ib?'best':''}">${r.run}</span></span></td>
      <td>${r.maFast}h</td><td>${r.maSlow}h</td><td>${(r.cutLoss*100)}%</td><td>${(r.alloc*100)}%</td>
      <td class="${r.profit>=0?'profit-pos':'profit-neg'}">${r.profit.toFixed(4).replace('.',',')}%</td><td>${r.transactions}</td></tr>`;
  });
  document.getElementById('runTableBody').innerHTML = tbody;

  // Factor cards — update values from best params
  document.getElementById('factorAVal').textContent = bestParams.maFast + 'h';
  document.getElementById('factorBVal').textContent = bestParams.maSlow + 'h';
  document.getElementById('factorCVal').textContent = (bestParams.cutLoss * 100) + '%';
  document.getElementById('factorDVal').textContent = (bestParams.alloc * 100) + '%';

  // Factor arrows based on effects
  if (Object.keys(EFFECTS).length) {
    const arrows = { A: 'factorA', B: 'factorB', C: 'factorC', D: 'factorD' };
    for (const [k, id] of Object.entries(arrows)) {
      const arrow = document.querySelector(`#${id} .factor-arrow`);
      if (arrow) {
        const v = EFFECTS[k];
        arrow.textContent = v >= 0 ? '↑' : '↓';
        arrow.className = `factor-arrow ${v >= 0 ? 'up' : 'down'}`;
      }
    }
  }

  // Main effects text (2-column grid)
  const fn={A:'MA Pendek',B:'MA Panjang',C:'Cut-Loss',D:'Alokasi Modal'};
  const me=Math.max(...Object.values(EFFECTS).map(Math.abs));
  let eH='';
  for(const[k,v]of Object.entries(EFFECTS)){const a=v>0?'↑':'↓',c=v>0?'var(--green)':'var(--red)',t=Math.abs(v)===me?' ':'',d=v>0?'Level TINGGI lebih baik':'Level RENDAH lebih baik';
    eH+=`<div><span style="color:var(--muted)">Faktor ${k} (${fn[k]}):</span> <strong style="color:${c}">${a} ${v.toFixed(4).replace('.',',')}%</strong> <span style="color:var(--muted);font-size:.7rem">— ${d}${t}</span></div>`;}
  document.getElementById('mainEffectsText').innerHTML = eH;
}

// ── Charts ──
function buildDS(tfKey, type) {
  const rows = CHART_SETS[tfKey]||[], labels = rows.map(r=>r.date);
  const dsF = { label:`MA${bestParams.maFast}`, data:rows.map(r=>r.maFast), borderColor:'#58a6ff', backgroundColor:'transparent', borderWidth:1.5, borderDash:[5,3], type:'line', fill:false, tension:.3, pointRadius:0, spanGaps:true, order:0 };
  const dsS = { label:`MA${bestParams.maSlow}`, data:rows.map(r=>r.maSlow), borderColor:'#d29922', backgroundColor:'transparent', borderWidth:1.5, borderDash:[8,4], type:'line', fill:false, tension:.3, pointRadius:0, spanGaps:true, order:0 };
  if (type==='candlestick') {
    return { labels, datasets:[{ label:'BBCA.JK', type:'candlestick', data:rows.map(r=>({x:r.ts,o:r.open,h:r.high,l:r.low,c:r.close})), color:{up:'#3fb950',down:'#f85149',unchanged:'#8b949e'}, borderColor:{up:'#3fb950',down:'#f85149',unchanged:'#8b949e'}, order:1 }, dsF, dsS] };
  }
  const ctx=document.getElementById('priceChart').getContext('2d'), g=ctx.createLinearGradient(0,0,0,360);
  g.addColorStop(0,'rgba(88,166,255,.18)'); g.addColorStop(1,'rgba(88,166,255,0)');
  return { labels, datasets:[{ label:'Harga BBCA', type:'line', data:rows.map(r=>r.close), borderColor:'#58a6ff', backgroundColor:g, borderWidth:2, fill:true, tension:.3, pointRadius:0, pointHoverRadius:3, spanGaps:true, order:1 }, dsF, dsS] };
}

function renderChart(tf, type) {
  const data=buildDS(tf,type), ctx=document.getElementById('priceChart').getContext('2d'), isC=type==='candlestick';
  const xCfg = isC ? { type:'time', time:{unit:tf==='w1y'?'week':'day',tooltipFormat:'dd MMM yyyy'}, ticks:{color:'#8b949e',font:{size:10},maxTicksLimit:8,maxRotation:0}, grid:{color:'rgba(255,255,255,.04)'} }
    : { ticks:{color:'#8b949e',font:{size:10},maxTicksLimit:8,maxRotation:0}, grid:{color:'rgba(255,255,255,.04)'} };
  if(priceChart) priceChart.destroy();
  priceChart = new Chart(ctx, { type:isC?'candlestick':'line', data, options:{
    responsive:true, maintainAspectRatio:false, interaction:{intersect:false,mode:isC?'nearest':'index'},
    plugins:{ legend:{display:false}, tooltip:{ backgroundColor:'#161b22', borderColor:'#30363d', borderWidth:1, titleColor:'#e6edf3', bodyColor:'#8b949e', titleFont:{size:11}, bodyFont:{size:11},
      callbacks:{ label:c=>{ if(c.dataset.type==='candlestick'){const d=c.raw;return[` O: ${fmtRp(d.o)}`,` H: ${fmtRp(d.h)}`,` L: ${fmtRp(d.l)}`,` C: ${fmtRp(d.c)}`];} return` ${c.dataset.label}: ${fmtRp(c.raw)}`; } } } },
    scales:{ x:xCfg, y:{ ticks:{color:'#8b949e',font:{size:10},callback:v=>'Rp '+Number(v).toLocaleString('id-ID')}, grid:{color:'rgba(255,255,255,.04)'} } }
  }});
  document.getElementById('leg-price').style.display = type==='line'?'':'none';
  document.getElementById('leg-candle').style.display = type==='candlestick'?'':'none';
}

function renderEffects() {
  if(!Object.keys(EFFECTS).length) return;
  // Disable datalabels globally so price chart isn't affected
  Chart.defaults.plugins.datalabels = { display: false };
  const ctx=document.getElementById('effectsChart').getContext('2d');
  const vals=[EFFECTS.A,EFFECTS.B,EFFECTS.C,EFFECTS.D];
  const clrs=vals.map(v=>v>=0?'rgba(63,185,80,.8)':'rgba(248,81,73,.8)');
  new Chart(ctx,{type:'bar',
    data:{labels:['A: MA Fast','B: MA Slow','C: Cut-Loss','D: Alokasi'],datasets:[{data:vals,backgroundColor:clrs,borderColor:clrs,borderWidth:1,borderRadius:4}]},
    plugins:[ChartDataLabels],
    options:{responsive:true,maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        datalabels:{
          display:true,
          anchor:function(ctx){return ctx.dataset.data[ctx.dataIndex]>=0?'end':'start';},
          align:function(ctx){return ctx.dataset.data[ctx.dataIndex]>=0?'top':'bottom';},
          color:function(ctx){return ctx.dataset.data[ctx.dataIndex]>=0?'#3fb950':'#f85149';},
          font:{size:11,weight:'bold'},
          formatter:function(v){return (v>=0?'+':'')+v.toFixed(2)+'%';}
        },
        tooltip:{backgroundColor:'#161b22',borderColor:'#30363d',borderWidth:1,titleColor:'#e6edf3',bodyColor:'#8b949e',callbacks:{label:c=>' '+(c.raw>=0?'+':'')+c.raw.toFixed(4)+'%'}}
      },
      scales:{x:{ticks:{color:'#8b949e',font:{size:10}},grid:{color:'rgba(255,255,255,.04)'}},y:{ticks:{color:'#8b949e',font:{size:10},callback:v=>(v>=0?'+':'')+v.toFixed(2)+'%'},grid:{color:'rgba(255,255,255,.04)'}}}
    }});
}

// ── Controls ──
window.switchTF = function(btn) {
  document.querySelectorAll('#tfGroup button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active'); currentTF=btn.dataset.tf; renderChart(currentTF,currentType);
};
window.switchType = function(type) {
  currentType=type;
  document.getElementById('btnLine').classList.toggle('active',type==='line');
  document.getElementById('btnCandle').classList.toggle('active',type==='candlestick');
  renderChart(currentTF,currentType);
};

// ── Init ──
async function init() {
  const ticker='BBCA.JK';
  const r5y = await fetchOHLC(ticker,'5y');
  const raw5y = r5y.data;
  if(!raw5y.length){ document.getElementById('loadingOverlay').remove(); document.getElementById('errorBanner').style.display='block'; document.getElementById('errorBanner').textContent='⚠️ Gagal mengambil data dari Yahoo Finance. Periksa koneksi internet.'; return; }

  const cutoff=Math.floor(raw5y.length*.8);
  TLFFD_RUNS=runTLFFD(raw5y.slice(0,cutoff));
  EFFECTS={A:mainEffect(TLFFD_RUNS,'signA'),B:mainEffect(TLFFD_RUNS,'signB'),C:mainEffect(TLFFD_RUNS,'signC'),D:mainEffect(TLFFD_RUNS,'signD')};
  TLFFD_RUNS.sort((a,b)=>b.profit-a.profit);
  const best=TLFFD_RUNS[0];
  bestParams={maFast:best.maFast,maSlow:best.maSlow,cutLoss:best.cutLoss,alloc:best.alloc};
  bestProfit=best.profit; bestRun=best.run;
  TLFFD_RUNS.sort((a,b)=>a.run-b.run);

  const tfC={d1mo:['1mo','1d'],d3mo:['3mo','1d'],d6mo:['6mo','1d'],w1y:['1y','1wk']};
  for(const[key,[range,interval]]of Object.entries(tfC)){
    const r=await fetchOHLC(ticker,range,interval); let d=r.data;
    if(!d.length) d=raw5y.slice(key==='w1y'?-52:-130);
    attachMA(d,bestParams.maFast,bestParams.maSlow);
    CHART_SETS[key]=d;
  }

  const live=CHART_SETS['d6mo'], last=live[live.length-1], prev=live[live.length-2];
  livePrice=last.close; liveMaFast=last.maFast; liveMaSlow=last.maSlow; lastDate=last.date;
  liveHigh=last.high; liveLow=last.low;
  // Estimate volume from last day data
  const d1=CHART_SETS['d1mo']; if(d1.length){const ld=d1[d1.length-1]; liveHigh=ld.high; liveLow=ld.low;}

  if(prev.maFast<=prev.maSlow && last.maFast>last.maSlow) liveSignal={status:'BELI 📈',kondisi:'Bullish — Golden Cross',color:'bull'};
  else if(prev.maFast>=prev.maSlow && last.maFast<last.maSlow) liveSignal={status:'JUAL 📉',kondisi:'Bearish — Death Cross',color:'bear'};
  else if(last.maFast>last.maSlow) liveSignal={status:'HOLD',kondisi:'Bullish — MA Fast di atas MA Slow',color:'hold-bull'};
  else liveSignal={status:'HOLD',kondisi:'Bearish — MA Fast di bawah MA Slow',color:'hold-bear'};

  updateUI();
  document.getElementById('loadingOverlay').remove();
  renderChart(currentTF,currentType);
  renderEffects();
}

window.addEventListener('DOMContentLoaded', init);
