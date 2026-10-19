'use strict';

/* ============== Constants / sources ============== */
const PSI_URL = 'https://api.data.gov.sg/v1/environment/psi';
const PM25_URL = 'https://api-open.data.gov.sg/v2/real-time/api/pm25';
const RH_URL = 'https://api.data.gov.sg/v1/environment/relative-humidity';
const WIND_DIR_URL = 'https://api.data.gov.sg/v1/environment/wind-direction';
const WIND_SPD_URL = 'https://api.data.gov.sg/v1/environment/wind-speed';
const FOURDAY_URL = 'https://api.data.gov.sg/v1/environment/4-day-weather-forecast';
const DAILY_FORECAST_URL = 'https://api.data.gov.sg/v1/environment/24-hour-weather-forecast';
const REGIONS = ['north','south','east','west','central'];
const PSI_CADENCE_MIN = 60; // confirmed via live timestamps: psi_twenty_four_hourly only updates on the hour, despite the dataset page's generic "every 15 min" text
const PM25_CADENCE_MIN = 60;
const HISTORY_DAYS = 14; // fetched window; the trend chart shows 7 (default) or 14 of these
const PSI_BAR_MAX = 400;   // display scale for the live-table bar, headroom above Hazardous(301+)
const PM25_BAR_MAX = 500;  // headroom above Band 4(251+)
const PSI_DIVERGENCE_THRESHOLD = 25;  // PSI points above the island average that trigger a divergence flag -- a chosen display threshold, not an NEA definition
const PM25_DIVERGENCE_THRESHOLD = 30; // µg/m³ above the island average, same purpose

/* ============== Fetch helper: data.gov.sg rate-limits bursts of
 * unauthenticated requests (observed HTTP 429 after ~7 rapid sequential
 * calls while testing). Retry 429s with backoff instead of treating a
 * rate limit as "no data for that day". ============== */
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function fetchJson(url, retries=4, backoffMs=1000){
  for(let attempt=0; attempt<=retries; attempt++){
    const res = await fetch(url);
    if(res.ok) return res.json();
    if(res.status === 429 && attempt < retries){
      await sleep(backoffMs * (attempt+1));
      continue;
    }
    throw new Error('HTTP ' + res.status);
  }
}

/* ============== Bands (source: haze.gov.sg) ============== */
function psiBand(v){
  if(v<=100) return {label:'Good to Moderate', cls:'good', dot:'dot-good'};
  if(v<=200) return {label:'Unhealthy', cls:'unhealthy', dot:'dot-unhealthy'};
  if(v<=300) return {label:'Very Unhealthy', cls:'veryunhealthy', dot:'dot-veryunhealthy'};
  return {label:'Hazardous', cls:'hazardous', dot:'dot-hazardous'};
}
function pm25BandNum(v){
  if(v<=55) return 1;
  if(v<=150) return 2;
  if(v<=250) return 3;
  return 4;
}
function pm25Band(v){
  const n = pm25BandNum(v);
  const map = {
    1:{label:'Band 1 (Normal)', cls:'good', dot:'dot-good'},
    2:{label:'Band 2 (Elevated)', cls:'unhealthy', dot:'dot-unhealthy'},
    3:{label:'Band 3 (High)', cls:'veryunhealthy', dot:'dot-veryunhealthy'},
    4:{label:'Band 4 (Very High)', cls:'hazardous', dot:'dot-hazardous'}
  };
  return map[n];
}
// Exact wording from NEA's official "How to plan your outdoor activities during
// haze" guide (24-hour PSI forecast / health advisory table, haze.gov.sg, PDF dated
// June 2026, verified directly against the published poster -- not paraphrased).
// Three distinct population groups, each with its own guidance per PSI band --
// unlike the 1-hour PM2.5 guide, which only distinguishes "healthy" vs a single
// combined "vulnerable" category.
const PSI_ADVISORY_24HR_ORDER = ['good','moderate','unhealthy','veryunhealthy','hazardous'];
const PSI_ADVISORY_24HR = {
  good:          {label:'Good', range:'0–50', cls:'good',
    healthy:'Normal activities', epc:'Normal activities', chronic:'Normal activities'},
  moderate:      {label:'Moderate', range:'51–100', cls:'good',
    healthy:'Normal activities', epc:'Normal activities', chronic:'Normal activities'},
  unhealthy:     {label:'Unhealthy', range:'101–200', cls:'unhealthy',
    healthy:'REDUCE prolonged or strenuous outdoor physical exertion',
    epc:'MINIMISE prolonged or strenuous outdoor physical exertion',
    chronic:'AVOID prolonged or strenuous outdoor physical exertion'},
  veryunhealthy: {label:'Very Unhealthy', range:'201–300', cls:'veryunhealthy',
    healthy:'AVOID prolonged or strenuous outdoor physical exertion',
    epc:'MINIMISE outdoor activity', chronic:'AVOID outdoor activity'},
  hazardous:     {label:'Hazardous', range:'>300', cls:'hazardous',
    healthy:'MINIMISE outdoor activity', epc:'AVOID outdoor activity', chronic:'AVOID outdoor activity'}
};
function psi24AdvisoryKey(v){
  if(v<=50) return 'good';
  if(v<=100) return 'moderate';
  if(v<=200) return 'unhealthy';
  if(v<=300) return 'veryunhealthy';
  return 'hazardous';
}

function fmtTime(iso){
  try{ return new Date(iso).toLocaleString('en-SG',{dateStyle:'short',timeStyle:'medium',timeZone:'Asia/Singapore'}) + ' SGT'; }
  catch(e){ return iso; }
}
function isStale(iso, cadenceMin){
  const ageMin = (Date.now() - new Date(iso).getTime()) / 60000;
  return ageMin > cadenceMin * 2;
}
function avgOf(obj){
  const vals = REGIONS.map(r=>obj[r]).filter(v=>typeof v==='number');
  return vals.length ? Math.round((vals.reduce((a,b)=>a+b,0)/vals.length)*10)/10 : null;
}

/* ============== "Live feel": fetch-time tracking, flash-on-change, favicon/title ============== */
const lastFetchTimes = {};
function markFetched(key){ lastFetchTimes[key] = Date.now(); }

function shortAgo(ms){
  const s = Math.floor(ms/1000);
  if(s<60) return `${s}s ago`;
  if(s<3600) return `${Math.floor(s/60)}m ago`;
  return `${Math.floor(s/3600)}h ago`;
}
function tickLiveAgo(){
  const map = { 'ago-psi': Math.max(lastFetchTimes.psi||0, lastFetchTimes.pm25||0), 'ago-wind': lastFetchTimes.wind||0 };
  Object.entries(map).forEach(([id,t])=>{
    const el = document.getElementById(id);
    if(!el) return;
    el.textContent = t ? shortAgo(Date.now()-t) : '';
  });
  const hb = document.getElementById('heartbeat');
  if(hb){
    const times = Object.values(lastFetchTimes).filter(Boolean);
    const mostRecent = times.length ? Math.max(...times) : 0;
    if(mostRecent){
      const staleHb = (Date.now()-mostRecent) > 6*60*1000; // no successful fetch anywhere in 6 min
      hb.classList.toggle('stale-hb', staleHb);
      hb.title = staleHb
        ? `No successful data refresh in the last ${Math.floor((Date.now()-mostRecent)/60000)}m — connection may be interrupted`
        : `Live — last successful data refresh ${shortAgo(Date.now()-mostRecent)}`;
    }
  }
}

const prevFlashValues = {};
// Returns ' flash' (for inclusion in a template's class list) if this value differs from
// last time this key was rendered -- used where the panel's whole HTML is rebuilt each
// refresh, so the flash animation plays automatically on the freshly-inserted element.
function flashClass(key, newVal){
  const changed = prevFlashValues[key] !== undefined && prevFlashValues[key] !== newVal;
  prevFlashValues[key] = newVal;
  return changed ? ' flash' : '';
}
// For elements mutated in place (not recreated each refresh) -- restart the CSS
// animation by removing and re-adding the class after a forced reflow.
function flashEl(el, key, newVal){
  const changed = prevFlashValues[key] !== undefined && prevFlashValues[key] !== newVal;
  prevFlashValues[key] = newVal;
  if(changed && el){ el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
}

let faviconLink = null;
// trendDir: 1 = worsening (red triangle pointing up), -1 = improving (green triangle
// pointing down), 0 = exactly flat hour (grey bar, matching the header's "▬ Steady"),
// null = no hourly trend yet -- band-colored dot so the tab isn't blank. The trend is
// fetched at startup (1 call, see init), so the dot normally shows for only a second or two.
function updateFaviconAndTitle(psiVal, trendDir){
  if(typeof psiVal !== 'number') return;
  document.title = `${psiVal} · Singapore Haze Tracker`;
  if(!faviconLink){
    faviconLink = document.querySelector('link[rel="icon"]');
    if(!faviconLink){ faviconLink = document.createElement('link'); faviconLink.rel = 'icon'; document.head.appendChild(faviconLink); }
  }
  const canvas = document.createElement('canvas');
  canvas.width = 32; canvas.height = 32;
  const ctx = canvas.getContext('2d');
  if(trendDir === 1 || trendDir === -1){
    ctx.fillStyle = trendDir === 1 ? '#d14f4f' : '#4caf7d'; // worsening red, improving green
    ctx.beginPath();
    if(trendDir === 1){ ctx.moveTo(16,3); ctx.lineTo(29,28); ctx.lineTo(3,28); }      // up
    else { ctx.moveTo(3,4); ctx.lineTo(29,4); ctx.lineTo(16,29); }                     // down
    ctx.closePath(); ctx.fill();
  } else if(trendDir === 0){
    ctx.fillStyle = '#9aa3af'; // steady
    ctx.fillRect(3, 12, 26, 8);
  } else {
    ctx.fillStyle = BAND_HEX_FAVICON[psiBand(psiVal).cls] || '#888';
    ctx.beginPath(); ctx.arc(16, 16, 15, 0, Math.PI*2); ctx.fill();
  }
  faviconLink.href = canvas.toDataURL('image/png');
}
const BAND_HEX_FAVICON = {good:'#4caf7d', unhealthy:'#d4a843', veryunhealthy:'#e07a3f', hazardous:'#d14f4f'};

/* ============== Live clock ============== */
function tickClock(){
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-SG',{
    timeZone:'Asia/Singapore', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false
  }).formatToParts(now).reduce((a,p)=>{a[p.type]=p.value; return a;},{});
  const clockEl = document.getElementById('clock');
  if(clockEl) clockEl.textContent = `${parts.hour}:${parts.minute}:${parts.second}`;
  const dateEl = document.getElementById('clock-date');
  if(dateEl){
    dateEl.textContent = new Intl.DateTimeFormat('en-SG',{
      timeZone:'Asia/Singapore', weekday:'short', year:'numeric', month:'short', day:'2-digit'
    }).format(now) + ' SGT';
  }
}

/* ============== Live readings table ============== */
let latestPSI = null;   // {ts, byRegion, avg}
let latestPM25 = null;  // {ts, byRegion, avg}
let cachedPsiFullSeries = null; // last-7-day hourly grid of {region:val} objects, for the PSI min/max range
let psiByTs = {}; // t -> {v, byRegion}; persisted across loadHistory + refreshHourlyTrend so the latter can merge in without a full re-fetch
let cachedPsiFull24 = null; // properly-anchored last-24h window of the same (see lastDataIndex below)

// Index of the most recent real (non-null) entry in a grid-aligned series. Anchoring
// "last 24 hours" to this instead of just slice(-24) matters because the grid's tail is
// built from calendar hours of "today" -- right after midnight, most of those hours are
// still in the future and have no data yet, so a naive slice(-24) goes almost entirely
// empty until late in the day. Anchoring to the last actual reading makes it a true
// rolling 24h window that crosses the day boundary correctly.
function lastDataIndex(arr){
  for(let i=arr.length-1; i>=0; i--){ if(arr[i]!==null) return i; }
  return -1;
}

// Min/max across ALL 5 regions (not just the island-wide average) -- the 7-day max for
// PSI, say, could be a single region's reading on one hour, never seen in the average
// series at all. Tracks which region each extreme came from for the label. Caller passes
// an already-windowed series (no slicing here).
function extremeAcrossRegions(fullSeries){
  let min=null, max=null, minRegion=null, maxRegion=null;
  fullSeries.forEach(byRegion=>{
    if(!byRegion) return;
    REGIONS.forEach(r=>{
      const v = byRegion[r];
      if(typeof v !== 'number') return;
      if(min===null || v<min){ min=v; minRegion=r; }
      if(max===null || v>max){ max=v; maxRegion=r; }
    });
  });
  return min!==null ? {min,max,minRegion,maxRegion} : null;
}

function meanIgnoringNull(arr){
  const vals = arr.filter(v=>v!==null);
  return vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
}
let lastMomentum = null; // cached so header PSI figure can render before/without a fresh history load

// Hourly trend (current reading vs the one immediately before it) -- distinct from
// computeMomentum's 24h-average-vs-prior-24h-average, which reacts far more slowly.
// PSI itself only updates once an hour at the source, so "hourly" here genuinely means
// "vs the last time the reading changed", not an artifact of polling cadence.
function computeHourlyTrend(byTsMap){
  const entries = Object.entries(byTsMap)
    .filter(([t,o]) => typeof o.v === 'number')
    .sort((a,b) => new Date(a[0]) - new Date(b[0]));
  if(entries.length < 2) return null;
  const [curT, curO] = entries[entries.length-1];
  const [prevT, prevO] = entries[entries.length-2];
  const d = Math.round((curO.v - prevO.v)*10)/10;
  const cls = d>0 ? 'trend-up' : d<0 ? 'trend-down' : 'trend-flat';
  const arrow = d>0 ? '▲' : d<0 ? '▼' : '▬';
  const word = d>0 ? 'Rising' : d<0 ? 'Falling' : 'Steady';
  return {cur:curO.v, prev:prevO.v, curT, prevT, d, cls, arrow, word};
}

// Lightweight: fetches just today's PSI (1 call) and merges it into the persistent
// psiByTs map, then re-renders the header's hourly trend -- doesn't re-run the full
// 7-day history fetch. PSI only changes once an hour at the source, so polling this
// every 15 min is already more than enough resolution to catch each new reading promptly.
async function refreshHourlyTrend(){
  try{
    const todayPts = await fetchDayPSI(sgtDateString(0));
    todayPts.forEach(p=>{ psiByTs[p.t] = {v:p.v, byRegion:p.byRegion}; });
    // Just after midnight today has only 1 reading -- the "previous hour" is yesterday's last.
    if(todayPts.length < 2 && Object.keys(psiByTs).length < 2){
      (await fetchDayPSI(sgtDateString(1))).forEach(p=>{ psiByTs[p.t] = {v:p.v, byRegion:p.byRegion}; });
    }
  }catch(e){ /* keep whatever we already had */ }
  renderHeaderPSI();
}

function computeMomentum(last24Arr, prev24Arr){
  const last24 = meanIgnoringNull(last24Arr);
  const prev24 = meanIgnoringNull(prev24Arr);
  if(last24===null || prev24===null) return null;
  const d = Math.round((last24-prev24)*10)/10;
  const cls = d>0 ? 'trend-up' : d<0 ? 'trend-down' : 'trend-flat';
  const arrow = d>0 ? '▲' : d<0 ? '▼' : '▬';
  const word = d>0 ? 'Worsening' : d<0 ? 'Improving' : 'Steady';
  return {last24, prev24, d, cls, arrow, word};
}

function renderMomentum(last24Arr, prev24Arr){
  lastMomentum = computeMomentum(last24Arr, prev24Arr);
  const el = document.getElementById('momentum-badge');
  if(el){
    if(!lastMomentum){ el.textContent = ''; }
    else{
      const m = lastMomentum;
      el.innerHTML = `<span class="${m.cls}" title="Mean island-wide average PSI, last 24h (${Math.round(m.last24)}) vs the preceding 24h (${Math.round(m.prev24)}).">${m.arrow} ${m.word} ${m.d>0?'+':''}${m.d} PSI/24h</span>`;
    }
  }
  renderHeaderPSI();
}

/* Header: instead of one SG-average figure, a continuously scrolling ticker of
   all 5 regions' live PSI (24-hr) readings -- the island-wide average still lives
   in the Nowcast panel below, this is meant to surface the regional spread at a
   glance. The track's content is duplicated once so the CSS animation (translateX
   0 -> -50%) loops seamlessly; a small fixed (non-scrolling) trend badge stays
   next to it showing the same hour-over-hour comparison as before. */
function renderHeaderPSI(){
  const el = document.getElementById('header-psi');
  if(!el) return;
  const trendEl = document.getElementById('header-psi-trend');
  const track = document.getElementById('marquee-track');
  if(!latestPSI || latestPSI.error || !latestPSI.byRegion){
    if(track){ track.textContent = 'Regional PSI unavailable'; track.classList.remove('ready'); }
    if(trendEl) trendEl.innerHTML = '';
    return;
  }
  const stale = isStale(latestPSI.ts, PSI_CADENCE_MIN);
  const staleNote = stale ? ` — no fresher reading since ${fmtTime(latestPSI.ts)}` : '';
  if(track){
    const items = REGIONS.map(r=>{
      const v = latestPSI.byRegion[r];
      const band = typeof v === 'number' ? psiBand(v) : null;
      const cls = band ? band.cls : '';
      return `<span class="marquee-item" title="${regionName(r)}: PSI ${v!=null?v:'no data'} (24-hr, ${band?band.label:'no data'}), reading ${fmtTime(latestPSI.ts)}${staleNote}">
        <span class="marquee-region">${regionName(r)}</span><span class="marquee-value ${cls}${stale?' stale':''}">${v!=null?v:'—'}</span>
      </span>`;
    }).join('');
    track.innerHTML = items + items;
    track.classList.add('ready');
  }
  const h = computeHourlyTrend(psiByTs);
  updateFaviconAndTitle(latestPSI.avg, h ? (h.d>0?1:h.d<0?-1:0) : null);
  if(h && trendEl){
    trendEl.innerHTML = `<span class="${h.cls}">${h.arrow} ${h.word}</span>`;
    el.title = `Island-wide average PSI (24-hr): ${latestPSI.avg}, reading ${fmtTime(latestPSI.ts)}${staleNote}. Hourly trend: ${h.word.toLowerCase()} — ${h.cur} now vs ${h.prev} the reading before (${fmtTime(h.prevT)}). Ticker below shows each region's reading.`;
  } else if(trendEl){
    trendEl.innerHTML = '';
  }
}

function regionName(r){ return r.charAt(0).toUpperCase()+r.slice(1); }

function rangeRowHtml(label, unit, fullSeries, scaleMax, trackClass, currentVal, period){
  const r = extremeAcrossRegions(fullSeries);
  if(!r) return `<div class="range-row"><div class="range-row-label">${label} — no data</div></div>`;
  const pct = v => Math.max(0, Math.min(100, (v/scaleMax)*100));
  const minPct = pct(r.min), maxPct = pct(r.max);
  let labels = `<div class="range-value-label" style="left:${minPct}%" title="${period} minimum: ${r.min}${unit} in ${regionName(r.minRegion)}">${r.min}</div>`;
  labels += `<div class="range-value-label" style="left:${maxPct}%" title="${period} maximum: ${r.max}${unit} in ${regionName(r.maxRegion)}">${r.max}</div>`;
  let marks = `<div class="range-tick" style="left:${minPct}%"></div>`;
  marks += `<div class="range-tick" style="left:${maxPct}%"></div>`;
  if(typeof currentVal === 'number'){
    marks += `<div class="range-marker" style="left:${pct(currentVal)}%" title="Current island-wide average: ${currentVal}${unit}"></div>`;
  }
  return `<div class="range-row">
    <div class="range-row-label"><span class="range-label-name">${label}</span></div>
    <div class="range-track-wrap">
      ${labels}
      <div class="range-track ${trackClass}">${marks}</div>
    </div>
  </div>`;
}

// PSI only (PM2.5 range rows removed by request -- PM2.5 still shows in Nowcast and the
// trend charts). 24h and 7d stacked as two full-width rows.
function renderLiveRanges(psi7Series, psi24Series){
  if(psi7Series) cachedPsiFullSeries = psi7Series;
  if(psi24Series) cachedPsiFull24 = psi24Series;
  const el = document.getElementById('range-scales');
  if(!el) return;
  if(!cachedPsiFullSeries){
    el.textContent = 'Range data loading…';
    return;
  }
  const psiNow = latestPSI && !latestPSI.error ? latestPSI.avg : null;
  const row = (period, data) => data
    ? `<div class="range-subsection"><div class="range-subhead">${period === '24h' ? 'Last 24 hours' : 'Last 7 days'}</div>${rangeRowHtml('PSI', '', data, PSI_BAR_MAX, '', psiNow, period)}</div>`
    : '';
  el.innerHTML = row('24h', cachedPsiFull24) + row('7d', cachedPsiFullSeries);
}

// PSI is itself a composite of 5 pollutant sub-indices -- the max of these, per
// region, is what becomes that region's PSI. Surfacing which one is highest tells
// a haze-tracker user whether an elevated reading is actually PM2.5 smoke or
// something else (ozone, SO2...), which the single PSI number alone can't show.
const SUBINDEX_KEYS = {pm25:'pm25_sub_index', pm10:'pm10_sub_index', so2:'so2_sub_index', co:'co_sub_index', o3:'o3_sub_index'};
const SUBINDEX_LABELS = {pm25:'PM2.5', pm10:'PM10', so2:'SO₂', co:'CO', o3:'O₃'};
function extractSubIndices(readings){
  const out = {};
  Object.entries(SUBINDEX_KEYS).forEach(([key, field])=>{
    if(readings[field]) out[key] = avgOf(readings[field]);
  });
  return out;
}
function dominantPollutant(subIndices){
  if(!subIndices) return null;
  let bestKey = null, bestVal = -Infinity;
  Object.entries(subIndices).forEach(([key,val])=>{
    if(typeof val === 'number' && val > bestVal){ bestVal = val; bestKey = key; }
  });
  return bestKey ? {key:bestKey, label:SUBINDEX_LABELS[bestKey], value:bestVal} : null;
}

async function loadPSI(){
  try{
    const json = await fetchJson(PSI_URL);
    const item = json.items && json.items[0];
    if(!item) throw new Error('No items in response');
    const readings = item.readings.psi_twenty_four_hourly;
    latestPSI = {ts:item.timestamp, byRegion:readings, avg:avgOf(readings), subIndices:extractSubIndices(item.readings)};
    markFetched('psi');
  }catch(e){
    latestPSI = {error:e.message};
  }
  onLiveDataUpdated();
}

async function loadPM25(){
  try{
    const json = await fetchJson(PM25_URL);
    if(json.code !== 0) throw new Error(json.errorMsg || 'API returned error code');
    const item = json.data.items && json.data.items[0];
    if(!item) throw new Error('No items in response');
    const readings = item.readings.pm25_one_hourly;
    latestPM25 = {ts:item.timestamp, byRegion:readings, avg:avgOf(readings)};
    markFetched('pm25');
  }catch(e){
    latestPM25 = {error:e.message};
  }
  onLiveDataUpdated();
}

function onLiveDataUpdated(){
  renderLiveRanges();
  renderHeaderPSI();
  refreshNowcast();
  renderPersonalAdvisory();
  markFetched('nowcast');
}

/* ============== Header weather widget (live humidity) ==============
 * Average of NEA's live relative-humidity stations. Station coverage on this endpoint can
 * be sparse at any given moment (observed as low as 1 station) -- shown as "N st" rather
 * than implied as a full-network average. (A "raining now" stat -- share of live rainfall
 * stations reading >0mm -- was removed from the header by request.) */
const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function compassToDeg(label){ const i = COMPASS.indexOf(label); return i>=0 ? i*22.5 : null; }
// Circular mean -- naive averaging of degrees breaks near the 0/360 wrap (e.g. 350 & 10 -> 180, not 0).
function circularMeanDeg(degs){
  if(!degs.length) return null;
  const sumSin = degs.reduce((a,d)=>a+Math.sin(d*Math.PI/180),0);
  const sumCos = degs.reduce((a,d)=>a+Math.cos(d*Math.PI/180),0);
  let mean = Math.atan2(sumSin, sumCos) * 180/Math.PI;
  if(mean < 0) mean += 360;
  return mean;
}
function isFromWSW(deg){ return deg!==null && deg>=180 && deg<=315; }

async function loadWeather(){
  const el = document.getElementById('weather-mini');

  let rhHtml;
  try{
    const rh = await fetchJson(RH_URL);
    const rhItem = rh.items && rh.items[0];
    const rhReadings = rhItem ? rhItem.readings : [];
    const rhAvg = rhReadings.length
      ? Math.round((rhReadings.reduce((a,r)=>a+r.value,0)/rhReadings.length)*10)/10
      : null;
    rhHtml = `<span class="weather-stat${flashClass('rhAvg', rhAvg)}" title="Average of ${rhReadings.length} reporting station(s), source: NEA relative-humidity API">
        💧 ${rhAvg!==null ? rhAvg+'%' : '—'} <span class="weather-sub">RH (${rhReadings.length} st)</span>
      </span>`;
  }catch(e){
    rhHtml = `<span class="weather-stat err" title="Humidity fetch failed: ${e.message}">💧 err</span>`;
  }

  el.innerHTML = rhHtml;
  markFetched('weather');
}

/* ============== Wind panel: live observed + official 4-day forecast ==============
 * Current conditions: circular mean of NEA's live wind-direction/wind-speed stations.
 * Forecast: NEA/MSS's own published 4-day outlook API -- a real forecast, not derived
 * from current conditions. */
const COMPASS_WORDS = ['north','north-northeast','northeast','east-northeast','east','east-southeast','southeast','south-southeast',
  'south','south-southwest','southwest','west-southwest','west','west-northwest','northwest','north-northwest'];
function compassWord(deg){ return COMPASS_WORDS[Math.round(deg/22.5) % 16]; }
const KT_TO_KMH = 1.852; // NEA's wind-speed API reports knots; display converts to km/h
// Last rendered compass-arrow angle, so each refresh can swing the arrow from the previous
// reading to the new one (the panel HTML is rebuilt on every refresh). Unwrapped (can go
// past 360) so the swing always takes the short way round, e.g. 350 -> 370, not 350 -> 10.
let lastWindArrowDeg = null;
function speedWord(kt){
  if(kt===null) return '';
  if(kt<4) return 'calm';
  if(kt<11) return 'light';
  if(kt<21) return 'moderate';
  return 'strong';
}

async function loadWind(){
  const el = document.getElementById('wind-body');
  try{
    const [wdir, wspd] = await Promise.all([fetchJson(WIND_DIR_URL), fetchJson(WIND_SPD_URL)]);
    const dirReadings = (wdir.items && wdir.items[0] && wdir.items[0].readings) || [];
    const spdReadings = (wspd.items && wspd.items[0] && wspd.items[0].readings) || [];
    const meanDir = circularMeanDeg(dirReadings.map(r=>r.value));
    const meanSpd = spdReadings.length ? Math.round((spdReadings.reduce((a,r)=>a+r.value,0)/spdReadings.length)*10)/10 : null;

    await sleep(300);
    const fd = await fetchJson(FOURDAY_URL);
    const forecasts = ((fd.items && fd.items[0] && fd.items[0].forecasts) || []).slice(0, 3);

    await sleep(300);
    let dailyGeneral = null;
    try{
      const daily = await fetchJson(DAILY_FORECAST_URL);
      dailyGeneral = daily.items && daily.items[0] && daily.items[0].general;
    }catch(e){ /* strip just won't render below */ }

    const meanSpdKmh = meanSpd!==null ? Math.round(meanSpd * KT_TO_KMH * 10)/10 : null;
    const spinSec = meanSpdKmh && meanSpdKmh>0 ? Math.max(0.5, Math.min(10, 24/meanSpdKmh)) : null;
    const smokeFlag = meanDir!==null && isFromWSW(meanDir) ? ' ⚠ may carry smoke from Sumatra' : '';
    const nowSentence = meanDir!==null ? `Now: ${compassWord(meanDir)} ${meanSpdKmh}km/h (${speedWord(meanSpd)})${smokeFlag}.` : 'Current wind reading unavailable.';
    const nowSentenceTitle = `Circular mean of ${dirReadings.length} wind-direction and ${spdReadings.length} wind-speed NEA stations (${meanDir!==null?Math.round(meanDir)+'°, ':''}${meanSpd!==null?meanSpd+' kt':''}). Direction is where wind blows FROM. 1 knot = 1.852 km/h.`;

    let forecastSentence, forecastTitle;
    if(forecasts.length){
      const dirWords = forecasts.map(f=>compassWord(compassToDeg(f.wind.direction))).filter((v,i,a)=>v && a.indexOf(v)===i);
      const minKmh = Math.round(Math.min(...forecasts.map(f=>f.wind.speed.low)) * KT_TO_KMH);
      const maxKmh = Math.round(Math.max(...forecasts.map(f=>f.wind.speed.high)) * KT_TO_KMH);
      const commonForecast = forecasts[0].forecast.toLowerCase();
      const anyWSW = forecasts.some(f=>isFromWSW(compassToDeg(f.wind.direction)));
      const dirPhrase = dirWords.length<=1 ? (dirWords[0]||'—') : dirWords.join('/');
      forecastSentence = `Next ${forecasts.length}d: ${dirPhrase}, ${minKmh}&ndash;${maxKmh}km/h, ${commonForecast}.${anyWSW?' ⚠':''}`;
      forecastTitle = `NEA/MSS 4-day-weather-forecast API, first ${forecasts.length} days. ${anyWSW?'At times from the usual Sumatra-fire direction toward Singapore.':''}`;
    } else {
      forecastSentence = '3-day forecast unavailable.';
      forecastTitle = '';
    }

    // Temperature + humidity forecast strip -- NEA's 24-hour-weather-forecast API,
    // a genuine forecast range (not a live reading, unlike the header's live RH stat).
    const stripHtml = dailyGeneral ? `
      <div class="daily-outlook-strip" title="NEA's 24-hour-weather-forecast API, source: ${DAILY_FORECAST_URL}. This is a forecast range for the next 24h, not a live measurement -- distinct from the header's live relative-humidity reading.">
        <span class="dos-stat">🌡 <b>${dailyGeneral.temperature.low}&ndash;${dailyGeneral.temperature.high}&deg;C</b></span>
        <span class="dos-stat">💧 <b>${dailyGeneral.relative_humidity.low}&ndash;${dailyGeneral.relative_humidity.high}%</b></span>
        <span class="dos-outlook">${dailyGeneral.forecast}</span>
      </div>` : '';

    el.innerHTML = `
      <div class="wind-now">
        <div class="windmill" style="transform:rotate(${meanDir!==null?meanDir+180:0}deg)" title="Spin rate reflects wind speed (${meanSpdKmh!==null?meanSpdKmh+'km/h':'—'}) -- a visual cue only, not a separate measurement. Orientation reflects direction.">
          <div class="windmill-rotor" style="${spinSec!==null?`animation-duration:${spinSec}s;animation-play-state:running;`:'animation-play-state:paused;'}">
            <span class="blade b1"></span><span class="blade b2"></span><span class="blade b3"></span><span class="blade b4"></span>
            <span class="windmill-hub"></span>
          </div>
        </div>
        <div class="wind-now-stats">
          <div class="wind-now-main${flashClass('windDir', meanDir)}">${meanDir!==null?compassWord(meanDir):'—'}</div>
          <div class="${flashClass('windSpd', meanSpdKmh).trim()}">${meanSpdKmh!==null?meanSpdKmh+' km/h':'—'} <span class="weather-sub">(${speedWord(meanSpd)})</span></div>
        </div>
        <div class="wind-compass${isFromWSW(meanDir)?' smoke':''}" title="${meanDir!==null?`Wind from the ${compassWord(meanDir)} (${Math.round(meanDir)}°), blowing toward the ${compassWord((meanDir+180)%360)}. Arrow points where the wind is going; it turns red when the wind comes from the W–SW quadrant (general direction of Sumatra fire activity).`:'Wind direction unavailable'}">
          <svg viewBox="0 0 60 60" aria-hidden="true">
            <circle cx="30" cy="30" r="27" class="wc-ring"/>
            <text x="30" y="9" class="wc-n">N</text><text x="53" y="32.5" class="wc-l">E</text><text x="30" y="56" class="wc-l">S</text><text x="7" y="32.5" class="wc-l">W</text>
            <g class="wc-arrow" id="wind-arrow" data-deg="${meanDir!==null?(meanDir+180)%360:''}" style="transform:rotate(${lastWindArrowDeg!==null?lastWindArrowDeg:(meanDir!==null?(meanDir+180)%360:0)}deg)${meanDir===null?';display:none':''}">
              <g class="wc-sway">
                <line x1="30" y1="44" x2="30" y2="20" class="wc-shaft"/>
                <polygon points="30,11 23.5,22 36.5,22" class="wc-head"/>
                <line x1="30" y1="44" x2="26" y2="49" class="wc-tail"/><line x1="30" y1="44" x2="34" y2="49" class="wc-tail"/>
              </g>
            </g>
            <circle cx="30" cy="30" r="2" class="wc-hub"/>
          </svg>
        </div>
      </div>
      ${stripHtml}
      <p class="wind-sentence" title="${nowSentenceTitle}">${nowSentence}</p>
      <p class="wind-sentence" title="${forecastTitle}">${forecastSentence}</p>`;
    const arrow = document.getElementById('wind-arrow');
    if(arrow && arrow.dataset.deg !== ''){
      const target = parseFloat(arrow.dataset.deg);
      let next = target;
      if(lastWindArrowDeg !== null){
        const delta = ((target - lastWindArrowDeg) % 360 + 540) % 360 - 180; // shortest signed turn
        next = lastWindArrowDeg + delta;
      }
      lastWindArrowDeg = next;
      requestAnimationFrame(()=>requestAnimationFrame(()=>{ arrow.style.transform = `rotate(${next}deg)`; }));
    }
    markFetched('wind');
  }catch(e){
    el.innerHTML = `<div class="err">Wind data failed: ${e.message}</div>`;
  }
}

/* ============== Nowcast: current reading + clear per-region breakdown ==============
 * Pure view over latestPSI/latestPM25 -- the same live snapshot the header and range
 * bars use. No fetch of its own (an earlier version independently re-fetched 7-day
 * history just to compute 1h/3h/24h deltas, which added 4 extra API calls per page
 * load on top of the already-heavy history fetch; dropping the deltas removes that
 * entirely, and reduces PM2.5-endpoint call volume, which rate-limits more readily
 * than the PSI endpoint). */
// Vertical list, sorted worst-first, each row a name + proportional mini-bar + value --
// scans like a small bar chart, clearer at a glance than a grid of boxes.
function regionListHtml(byRegion, avg, bandFn, threshold, unit, scaleMax){
  if(!byRegion || typeof avg !== 'number') return '<div class="err">No regional data</div>';
  const sorted = REGIONS.slice().sort((a,b)=>{
    const va = byRegion[a], vb = byRegion[b];
    if(typeof va !== 'number' && typeof vb !== 'number') return 0;
    if(typeof va !== 'number') return 1;
    if(typeof vb !== 'number') return -1;
    return vb - va;
  });
  return `<div class="nowcast-region-list">` + sorted.map(r=>{
    const v = byRegion[r];
    const name = r.charAt(0).toUpperCase()+r.slice(1);
    if(typeof v !== 'number') return `<div class="nrl-row"><span class="nrl-name">${name}</span><span class="nrl-bar-wrap"></span><span class="nrl-val">—</span></div>`;
    const band = bandFn(v);
    const diff = v - avg;
    const warn = diff > threshold;
    const pct = Math.max(2, Math.min(100, Math.round((v/scaleMax)*100)));
    return `<div class="nrl-row" title="${name}: ${v}${unit}${warn?` — +${Math.round(diff*10)/10} vs island average, more than the chosen +${threshold} divergence threshold`:''}">
      <span class="nrl-name">${name}${warn?' ⚠':''}</span>
      <span class="nrl-bar-wrap"><span class="nrl-bar ${band.cls}" style="width:${pct}%"></span></span>
      <span class="nrl-val ${band.cls}">${v}</span>
    </div>`;
  }).join('') + `</div>`;
}

function nowcastMetricHtml(label, unit, data, bandFn, threshold, flashKey, scaleMax){
  if(!data || data.error || typeof data.avg !== 'number') return `<div class="nowcast-metric"><div class="err">${label}: ${data && data.error ? data.error : 'no data'}</div></div>`;
  const band = bandFn(data.avg);
  const dom = data.subIndices ? dominantPollutant(data.subIndices) : null;
  // PM2.5 driving PSI is the "normal haze" case and isn't worth flagging; any other
  // pollutant topping the sub-indices is the signal worth surfacing (e.g. ozone, not smoke).
  const domHtml = dom && dom.key !== 'pm25'
    ? `<div class="nowcast-dominant" title="Island-average sub-indices: ${Object.entries(data.subIndices).map(([k,v])=>`${SUBINDEX_LABELS[k]} ${Math.round(v)}`).join(', ')}">Driven by ${dom.label}, not PM2.5</div>`
    : '';
  return `
    <div class="nowcast-metric">
      <div class="nowcast-label">${label}</div>
      <div class="nowcast-headline">
        <span class="nowcast-value ${band.cls}${flashClass(flashKey, data.avg)}">${data.avg}</span>
        <span class="nowcast-unit">${unit}</span>
        <span class="nowcast-band ${band.cls}">${band.label}</span>
      </div>
      ${domHtml}
      ${regionListHtml(data.byRegion, data.avg, bandFn, threshold, unit, scaleMax)}
    </div>`;
}

function refreshNowcast(){
  const body = document.getElementById('nowcast-body');
  body.innerHTML =
    nowcastMetricHtml('PSI (24-hr)', '', latestPSI, psiBand, PSI_DIVERGENCE_THRESHOLD, 'nowcastPsi', PSI_BAR_MAX) +
    nowcastMetricHtml('PM2.5 (1-hr)', 'µg/m³', latestPM25, pm25Band, PM25_DIVERGENCE_THRESHOLD, 'nowcastPm25', PM25_BAR_MAX);
}

/* ============== PSI Forecast: NEA's own published forecast, discovered live ==============
 * [Certain, verified directly] haze.gov.sg has no JSON/API for the forecast number -- it
 * only exists as pixels in a published gauge image (a 0-300+ band dial with the forecast
 * range shaded and printed in a pill, e.g. "101 - 190"). The image's pixels can't be read
 * client-side either (no CORS header on the image itself, so a canvas read is blocked),
 * so the figure can't be redrawn natively without guessing at it. What IS readable:
 * haze.gov.sg's homepage HTML is CORS-open (access-control-allow-origin: *), so this
 * fetches it and pulls the exact <img> URLs NEA is publishing right now, instead of
 * constructing a filename. (A previous version constructed `chart_<tomorrow>.png`; the
 * real pattern turned out to be `chart_1_<day>-<mon>.png` dated the forecast day itself,
 * so it 404'd every time.) The companion advisory image's filename names the band NEA is
 * advising for (e.g. `unhealthy_19-oct.png`) -- NEA's own image states this advice "is
 * based on the high end of the PSI forecast" -- so that band is shown as text alongside.
 * Falls back to the constructed URL for today, then to a link-out, if discovery fails. */
const HAZE_GOV_SG = 'https://www.haze.gov.sg';
const HAZE_IMG_PATH = /^\/images\/default-source\/health-advisory-images\/[\w.-]+\.png$/i;
const MONTH_ABBR_LC = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
const FORECAST_ADVICE_BANDS = {
  good:{label:'Good', cls:'good'}, moderate:{label:'Moderate', cls:'good'},
  goodmoderate:{label:'Good to Moderate', cls:'good'}, goodtomoderate:{label:'Good to Moderate', cls:'good'},
  unhealthy:{label:'Unhealthy', cls:'unhealthy'}, veryunhealthy:{label:'Very Unhealthy', cls:'veryunhealthy'},
  hazardous:{label:'Hazardous', cls:'hazardous'}
};

function todaySgtForecastSlug(){
  const sgtNow = new Date(new Date().toLocaleString('en-US', {timeZone:'Asia/Singapore'}));
  return `${sgtNow.getDate()}-${MONTH_ABBR_LC[sgtNow.getMonth()]}`;
}
// "19-oct" -> "19 Oct"
function slugToLabel(slug){
  const m = /^(\d{1,2})-([a-z]{3})$/i.exec(slug || '');
  return m ? `${parseInt(m[1],10)} ${m[2].charAt(0).toUpperCase()}${m[2].slice(1).toLowerCase()}` : null;
}

async function discoverForecastImages(){
  const res = await fetch(HAZE_GOV_SG + '/');
  if(!res.ok) throw new Error('HTTP ' + res.status);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  const srcs = Array.from(doc.querySelectorAll('img'))
    .map(img => ({src:(img.getAttribute('src')||'').split('?')[0], alt:img.getAttribute('alt')||''}))
    .filter(o => HAZE_IMG_PATH.test(o.src));
  const gauge = srcs.find(o => /\/chart_/i.test(o.src)) || srcs.find(o => /gauge/i.test(o.alt));
  if(!gauge) throw new Error('forecast image not found on haze.gov.sg');
  const advisory = srcs.find(o => /advisory table/i.test(o.alt));
  const slugMatch = /_(\d{1,2}-[a-z]{3})\.png$/i.exec(gauge.src);
  let band = null;
  if(advisory){
    const key = (/\/([a-z-]+?)_\d{1,2}-[a-z]{3}\.png$/i.exec(advisory.src) || [])[1];
    band = key ? FORECAST_ADVICE_BANDS[key.toLowerCase().replace(/[^a-z]/g,'')] || null : null;
  }
  return { gaugeUrl: HAZE_GOV_SG + gauge.src, dateLabel: slugToLabel(slugMatch && slugMatch[1]), band };
}

async function renderForecast(){
  const body = document.getElementById('forecast-body');
  const liveLink = `<a href="${HAZE_GOV_SG}/" target="_blank" rel="noopener">haze.gov.sg &#8599;</a>`;
  let info;
  try{ info = await discoverForecastImages(); }
  catch(e){
    const slug = todaySgtForecastSlug();
    info = { gaugeUrl: `${HAZE_GOV_SG}/images/default-source/health-advisory-images/chart_1_${slug}.png`, dateLabel: slugToLabel(slug), band:null, guessed:true };
  }
  const dateTxt = info.dateLabel || 'the coming day';
  const bandHtml = info.band
    ? `<span class="forecast-band ${info.band.cls}" title="Band NEA's own advisory image is issued for (named in its filename). NEA states this advice is based on the high end of the PSI forecast.">Advice: ${info.band.label}</span>`
    : '';
  body.innerHTML = `
    <div class="forecast-img-wrap" title="NEA's official 24-hr PSI forecast for ${dateTxt}: their published image, shown whole, not redrawn or transcribed. The shaded wedge and the number in the pill are the forecast range.">
      <img id="forecast-chart-img" src="${info.gaugeUrl}" alt="NEA PSI forecast for ${dateTxt}" />
    </div>
    <div class="forecast-note"><span>For <b>${dateTxt}</b> &middot; ${liveLink}</span>${bandHtml}</div>`;
  markFetched('forecast');

  document.getElementById('forecast-chart-img').addEventListener('error', ()=>{
    body.innerHTML = `<div class="forecast-fallback">Couldn't load NEA's forecast image${info.guessed ? ' (haze.gov.sg page could not be read, and the expected filename for today was not found)' : ''}. See ${liveLink} instead.</div>`;
  }, {once:true});
}

/* ============== Regional Map: link-out, not an embed ==============
 * ASMC (asmc.asean.org) has no stable embeddable live map we could find -- checked their
 * homepage, hotspot page, and WIS 2.0 portal source directly. The one candidate static
 * image (WIS 2.0's "Regional Haze Situation" graphic) returns HTTP 403 on direct fetch
 * (hotlink-protected) and the page hosting it was last dated months ago, not live. Rather
 * than embed something broken or stale, this is a clearly-labeled link to their actual
 * live interactive map. */
function renderRegionalMap(){
  const body = document.getElementById('regionalmap-body');
  body.innerHTML = `
    <div class="regionalmap-card">
      <div class="regionalmap-desc" title="Not embedded: ASMC's map is a client-side interactive widget with no stable embeddable image or iframe found on inspection. Linking out rather than showing a broken or stale visual.">
        ASEAN's Specialised Meteorological Centre (ASMC) publishes the region's official hotspot/haze map (updated ~daily): fire hotspots (NOAA), 2,500ft wind analysis, rainfall overlay.
      </div>
      <a class="regionalmap-link" href="https://asmc.asean.org/home" target="_blank" rel="noopener">Open live ASMC regional map <span class="arrow">&#8599;</span></a>
    </div>`;
}

/* ============== Latest Headlines: Singapore haze news, not NEA/haze data ==============
 * Source: The Straits Times' own "haze" tag feed (straitstimes.com/tags/haze/rss.xml).
 * [Certain, verified directly] This feed now sends access-control-allow-origin: *, so it's
 * fetched straight from the browser and parsed here -- no third-party proxy. (An earlier
 * version routed ST's general Singapore feed through rss2json.com and keyword-filtered it,
 * because the tag feed broke rss2json's parser; that surfaced as few as 1 haze headline and
 * depended on a free shared proxy.)
 * The tag feed covers haze across the region (Malaysia school closures, Sumatra fires...),
 * so it's narrowed to Singapore-only: an item is kept if ST filed it under its /singapore/
 * section, OR its title names Singapore/S'pore. A keyword rule over ST's own tagging and
 * filing, not a manual curation -- a Singapore-relevant story filed elsewhere without
 * "Singapore" in its title will be missed rather than guessed at. Titles/links are ST's own,
 * not rewritten here. */
const HEADLINES_RSS_URL = 'https://www.straitstimes.com/tags/haze/rss.xml';
const HEADLINES_MAX = 8;
const SG_TITLE = /singapore|s[’']pore/i;
// Titles/links come from an external feed, not content we control -- escape before
// inserting as innerHTML rather than trusting it as safe markup.
function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function isSingaporeHazeItem(title, link){
  let path = '';
  try{
    const u = new URL(link);
    if(!/(^|\.)straitstimes\.com$/i.test(u.hostname)) return false;
    path = u.pathname;
  }catch(e){ return false; }
  return path.startsWith('/singapore/') || SG_TITLE.test(title);
}
// Show as many whole headlines as fit the panel at this viewport height and hide the rest,
// rather than letting overflow:hidden slice the last one in half.
function fitHeadlines(){
  const body = document.getElementById('headlines-body');
  if(!body) return;
  const items = Array.from(body.querySelectorAll('.headline-item'));
  items.forEach(el => { el.style.display = ''; });
  const limit = body.getBoundingClientRect().bottom;
  // Once one overflows, hide it and everything after -- keeps the list a contiguous newest-first run.
  const cut = items.findIndex(el => el.getBoundingClientRect().bottom > limit + 0.5);
  if(cut >= 0) items.slice(cut).forEach(el => { el.style.display = 'none'; });
}
window.addEventListener('resize', ()=>{ clearTimeout(window.__headlineFitT); window.__headlineFitT = setTimeout(fitHeadlines, 150); });
async function renderHeadlines(){
  const body = document.getElementById('headlines-body');
  if(!body) return;
  try{
    const res = await fetch(HEADLINES_RSS_URL);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const xml = new DOMParser().parseFromString(await res.text(), 'application/xml');
    if(xml.querySelector('parsererror')) throw new Error('Feed could not be parsed');
    const items = Array.from(xml.querySelectorAll('item')).map(it => ({
      title: (it.querySelector('title')||{}).textContent || '',
      link: ((it.querySelector('link')||{}).textContent || '').trim(),
      when: new Date((it.querySelector('pubDate')||{}).textContent || '')
    }))
      .filter(it => it.title && isSingaporeHazeItem(it.title, it.link))
      .sort((a,b) => (b.when||0) - (a.when||0))
      .slice(0, HEADLINES_MAX);
    if(!items.length) throw new Error('No Singapore haze headlines in the current feed');
    body.innerHTML = items.map(it=>{
      const whenStr = !isNaN(it.when) ? shortAgo(Date.now()-it.when.getTime()) : '';
      const title = escapeHtml(it.title);
      return `<a class="headline-item" href="${escapeHtml(it.link)}" target="_blank" rel="noopener" title="${title}">
        <span class="headline-title">${title}</span>
        <span class="headline-meta">${whenStr}</span>
      </a>`;
    }).join('');
    fitHeadlines();
    markFetched('headlines');
  }catch(e){
    body.innerHTML = `<div class="err">Headlines unavailable: ${escapeHtml(e.message)} (external news feed, not an NEA data failure)</div>`;
  }
}

/* ============== Personal advisory: full official 3-group table, current band
 * highlighted ====
 * v1 used a profile dropdown mapped onto NEA's two PM2.5 tiers (Healthy/Vulnerable).
 * This version shows NEA's other official table instead -- the 24-hour PSI health
 * advisory, which actually distinguishes 3 separate population groups (Healthy /
 * Elderly, Pregnant Women & Children / Persons with Chronic Lung or Heart Disease)
 * with their own wording per band, rather than one merged "vulnerable" category.
 * Highlighted row uses the live current 24-hr PSI reading (not a forecast -- NEA's
 * own guide pairs this table with a next-day PSI forecast, which only exists as a
 * published image with no API; using today's live, already-fetched PSI keeps the
 * table's highlighting real and verifiable instead of guessing at tomorrow). */
// Fit the advisory table to its panel instead of clipping: rows are plain `1fr` tracks
// (minimum = their content), so if the content is taller than the panel the grid
// overflows -- step the font down until nothing overflows vertically AND no single
// word is wider than its column (cells use overflow-wrap:normal, so a too-narrow
// column shows up as cell scrollWidth > clientWidth rather than a mid-word break).
// Starts from the original 11.5px (larger read as too big) and only steps down if needed.
const ADVISORY_FONT_MAX = 11.5, ADVISORY_FONT_MIN = 8.5; // 11.5px = the table's original fixed size; only shrinks below it if the panel is too short
function fitAdvisory(){
  const grid = document.querySelector('#personal-body .advisory-grid');
  if(!grid || !grid.clientHeight) return;
  const cells = Array.from(grid.querySelectorAll('.advisory-row > div'));
  const overflows = () => grid.scrollHeight > grid.clientHeight + 1 || cells.some(c => c.scrollWidth > c.clientWidth + 1);
  let px = ADVISORY_FONT_MAX;
  grid.style.fontSize = px + 'px';
  while(px > ADVISORY_FONT_MIN && overflows()){
    px -= 0.5;
    grid.style.fontSize = px + 'px';
  }
}
window.addEventListener('resize', ()=>{ clearTimeout(window.__advFitT); window.__advFitT = setTimeout(fitAdvisory, 150); });
// Web-font swaps change text metrics (titles re-wrap), and a font face can finish loading
// after an earlier fonts.ready already resolved -- so refit on every completed font load,
// and whenever either panel's box changes size.
if(document.fonts){
  document.fonts.ready.then(()=>{ fitAdvisory(); fitHeadlines(); });
  document.fonts.addEventListener('loadingdone', ()=>{ fitAdvisory(); fitHeadlines(); });
}
if(window.ResizeObserver){
  const ro = new ResizeObserver(entries=>{
    entries.forEach(e=>{ if(e.target.id === 'headlines-body') fitHeadlines(); else fitAdvisory(); });
  });
  document.addEventListener('DOMContentLoaded', ()=>{
    ['headlines-body','personal-body'].forEach(id=>{ const el = document.getElementById(id); if(el) ro.observe(el); });
  });
}

function renderPersonalAdvisory(){
  const body = document.getElementById('personal-body');
  if(!latestPSI || latestPSI.error || typeof latestPSI.avg !== 'number'){
    body.innerHTML = `<div class="err">No current PSI reading available.</div>`;
    return;
  }
  const v = latestPSI.avg;
  const currentKey = psi24AdvisoryKey(v);

  const rows = PSI_ADVISORY_24HR_ORDER.map(key=>{
    const d = PSI_ADVISORY_24HR[key];
    const isCurrent = key===currentKey;
    return `<div class="advisory-row${isCurrent?' adv-current':''}" title="${isCurrent?`Current 24-hr PSI: ${v}`:''}">
      <div class="adv-band ${d.cls}">${d.label} <span class="adv-range">(${d.range})</span></div>
      <div>${d.healthy}</div>
      <div>${d.epc}</div>
      <div>${d.chronic}</div>
    </div>`;
  }).join('');

  body.innerHTML = `
    <div class="advisory-current">Now: <b>${v}</b> PSI (24-hr) — current row highlighted.</div>
    <div class="advisory-grid">
      <div class="advisory-row advisory-head"><div>Band</div><div>Healthy</div><div title="Elderly, pregnant women, children">Elderly, Pregnant, Children</div><div title="Persons with chronic lung disease or heart disease">Chronic Lung / Heart Disease</div></div>
      ${rows}
    </div>`;
  fitAdvisory();
}

/* ============== Historical fetch helpers ============== */
function sgtDateString(daysAgo){
  const now = new Date();
  const sgtNowStr = now.toLocaleString('en-US', {timeZone:'Asia/Singapore'});
  const sgtNow = new Date(sgtNowStr);
  sgtNow.setDate(sgtNow.getDate() - daysAgo);
  const y = sgtNow.getFullYear();
  const m = String(sgtNow.getMonth()+1).padStart(2,'0');
  const d = String(sgtNow.getDate()).padStart(2,'0');
  return `${y}-${m}-${d}`;
}
async function fetchDayPSI(dateStr){
  const json = await fetchJson(`${PSI_URL}?date=${dateStr}`);
  return (json.items||[]).map(item=>{
    const byRegion = item.readings.psi_twenty_four_hourly;
    return {t:item.timestamp, v: avgOf(byRegion), byRegion};
  });
}
async function fetchDayPM25(dateStr){
  const json = await fetchJson(`${PM25_URL}?date=${dateStr}`);
  if(json.code !== 0) throw new Error(json.errorMsg || 'API error');
  return (json.data.items||[]).map(item=>{
    const byRegion = item.readings.pm25_one_hourly;
    return {t:item.timestamp, v: avgOf(byRegion), byRegion};
  });
}

/* ============== Historical trend charts (7-day and 24-hour) ============== */
function shortLabel(iso){
  return new Date(iso).toLocaleString('en-SG',{timeZone:'Asia/Singapore', month:'short', day:'2-digit', hour:'2-digit'});
}

let historyLoadInFlight = false;
async function loadHistory(){
  // Guard against overlapping runs -- the first load makes up to ~28 sequential,
  // deliberately rate-limit-spaced calls, which can take longer than the refresh
  // interval itself if NEA is throttling that session.
  if(historyLoadInFlight) return;
  historyLoadInFlight = true;
  try{ await loadHistoryInner(); }
  finally{ historyLoadInFlight = false; }
}

// 14 days are fetched so the trend chart can toggle 7d/14d. Completed past days never
// change at the source, so they're cached after their first successful fetch -- only
// today and yesterday (whose late hours may still be filling in just after midnight)
// are re-fetched on each 15-min reload. Without this, the 14-day window would double
// NEA calls every reload (PM2.5's endpoint rate-limits readily, see methodology).
const dayCache = {psi:{}, pm25:{}};
const pm25ByTs = {}; // t -> {v, byRegion}; module-level, same reason as psiByTs
let historyState = null; // {grid, dateStrs, failedPSIDays, failedPM25Days, loadedDays}
let trendDays = 14;      // trend chart window; 14 is the default, radio toggles 7

async function loadHistoryInner(){
  document.getElementById('history7-status').textContent = `Loading last ${trendDays} days…`;
  document.getElementById('history24-status').textContent = `Loading last 24h…`;

  const dateStrs = Array.from({length:HISTORY_DAYS}, (_,i)=>sgtDateString(HISTORY_DAYS-1-i));
  // Full expected hourly grid for the window -- real NEA timestamps land exactly on these marks,
  // so a day that fails to load leaves true nulls (a visible gap), never a silently bridged line.
  const grid = [];
  dateStrs.forEach(d=>{ for(let h=0; h<24; h++){ grid.push(`${d}T${String(h).padStart(2,'0')}:00:00+08:00`); } });
  const failedPSIDays = [], failedPM25Days = [];
  historyState = {grid, dateStrs, failedPSIDays, failedPM25Days, loadedDays:0};

  // Fetch newest-first: if a rate limit cuts the loop short, it's the oldest (least
  // important) days that go missing, not today's. The default 7-day view renders as soon
  // as its 7 days are in, rather than waiting on the extra week for the 14-day toggle.
  const fetchOrder = dateStrs.slice().reverse();
  for(let i=0; i<fetchOrder.length; i++){
    const d = fetchOrder[i];
    const cacheable = i >= 2; // today (0) and yesterday (1) are always re-fetched
    for(const [kind, fetchFn, byTs, failed] of [['psi', fetchDayPSI, psiByTs, failedPSIDays], ['pm25', fetchDayPM25, pm25ByTs, failedPM25Days]]){
      let pts = cacheable ? dayCache[kind][d] : null;
      if(!pts){
        try{
          pts = await fetchFn(d);
          if(cacheable && pts.length) dayCache[kind][d] = pts;
        }catch(e){ failed.push(`${d} (${kind==='psi'?'PSI':'PM2.5'}: ${e.message})`); }
        await sleep(600); // space requests out -- data.gov.sg rate-limits bursts on a flaky rolling window
      }
      if(pts) pts.forEach(p=>{ byTs[p.t] = {v:p.v, byRegion:p.byRegion}; });
    }
    historyState.loadedDays = i+1;
    if(i === 6 || i === fetchOrder.length-1) renderHistory();
  }
}

function renderHistory(){
  if(!historyState) return;
  const {grid} = historyState;
  const psiSeries = grid.map(t => (t in psiByTs) ? psiByTs[t].v : null);
  const pm25Series = grid.map(t => (t in pm25ByTs) ? pm25ByTs[t].v : null);
  const psiFullSeries = grid.map(t => (t in psiByTs) ? psiByTs[t].byRegion : null);

  // Anchor "last 24 hours" to the most recent real PSI reading (PSI's endpoint never
  // failed in testing, unlike PM2.5's), not the grid's tail -- see lastDataIndex().
  const endIdx = lastDataIndex(psiSeries);
  const winEnd = endIdx>=0 ? endIdx+1 : grid.length;
  const winStart = Math.max(0, winEnd-24);
  const prevStart = Math.max(0, winStart-24);
  const grid24 = grid.slice(winStart, winEnd);
  const psi24 = psiSeries.slice(winStart, winEnd);
  const pm2524 = pm25Series.slice(winStart, winEnd);
  const psiPrev24 = psiSeries.slice(prevStart, winStart);

  // Ranges/momentum are data-only (no Chart.js dependency) and are rendered first so a
  // Chart.js/CDN failure below can't take them down too. Range "Last 7 days" is always
  // the last 7 calendar days, independent of the trend chart's 7d/14d toggle.
  renderLiveRanges(psiFullSeries.slice(-7*24), psiFullSeries.slice(winStart, winEnd));
  renderMomentum(psi24, psiPrev24);
  renderTrendChart();

  let chart24Err = null;
  try{ renderLineChart('chart-24h', grid24, psi24, pm2524, 'chart24h', false); }
  catch(e){ chart24Err = e.message; }
  const n24Psi = psi24.filter(v=>v!==null).length, n24Pm = pm2524.filter(v=>v!==null).length;
  document.getElementById('history24-status').textContent = `${n24Psi}/24 PSI, ${n24Pm}/24 PM2.5 hourly points over the last 24h, same source.${chart24Err ? ` Chart failed to render: ${chart24Err}.` : ''}`;
}

// The 7/14-day trend chart: same chart, window sliced from the shared 14-day grid.
function renderTrendChart(){
  const statusEl = document.getElementById('history7-status');
  const titleEl = document.getElementById('trend-title');
  if(titleEl) titleEl.textContent = `${trendDays}-Day Trend`;
  if(!historyState) return;
  const {grid, dateStrs, failedPSIDays, failedPM25Days, loadedDays} = historyState;
  if(loadedDays < trendDays){
    statusEl.textContent = `Loading last ${trendDays} days… (${loadedDays}/${trendDays} fetched)`;
    if(trendDays > 7 && loadedDays < 7) return; // nothing renderable yet
  }
  const win = grid.slice(-trendDays*24);
  const psi = win.map(t => (t in psiByTs) ? psiByTs[t].v : null);
  const pm = win.map(t => (t in pm25ByTs) ? pm25ByTs[t].v : null);
  let chartErr = null;
  try{ renderLineChart('chart-7d', win, psi, pm, 'chart7d', true); }
  catch(e){ chartErr = e.message; }
  if(loadedDays < trendDays) return; // keep the "Loading…" status until the window is complete

  const winDates = new Set(dateStrs.slice(-trendDays));
  const inWin = s => winDates.has(s.slice(0,10));
  const missPsi = failedPSIDays.filter(inWin), missPm = failedPM25Days.filter(inWin);
  let status = `${psi.filter(v=>v!==null).length} PSI / ${pm.filter(v=>v!==null).length} PM2.5 hourly points over ${trendDays} days, pulled live from NEA's own date-range query (same source as the live panel).`;
  if(missPsi.length) status += ` PSI missing: ${missPsi.join(', ')} (shown as a gap, not interpolated).`;
  if(missPm.length) status += ` PM2.5 missing: ${missPm.join(', ')} (shown as a gap, not interpolated).`;
  if(chartErr) status += ` Chart failed to render: ${chartErr}.`;
  statusEl.textContent = status;
}

function initTrendToggle(){
  document.querySelectorAll('input[name="trend-days"]').forEach(r=>{
    r.addEventListener('change', ()=>{
      if(!r.checked) return;
      trendDays = parseInt(r.value, 10);
      renderTrendChart();
    });
  });
}

const charts = {};
function renderLineChart(canvasId, grid, psiSeries, pm25Series, key, dailyTicks){
  const ctx = document.getElementById(canvasId).getContext('2d');
  const labels = grid.map(shortLabel);
  if(charts[key]) charts[key].destroy();
  const xTicks = { color:'#6b7280', maxTicksLimit:8, autoSkip:true };
  const xScale = { ticks:xTicks, grid:{ color:'#262b33' } };
  if(dailyTicks){
    // One tick per calendar day, same hour each time (grid is built in fixed 24-point
    // daily blocks) -- more legible than Chart.js's default auto-skip over 168 points.
    xScale.ticks = { color:'#6b7280', autoSkip:false, callback:(val, idx)=> idx % 24 === 0 ? labels[idx] : null, maxRotation:45, minRotation:45, font:{size:9} };
    xScale.grid = { color: (c)=> c.index % 24 === 0 ? '#262b33' : 'transparent' };
  } else {
    // 24h chart: Chart.js auto-skips to however many hourly labels actually fit at this
    // (often narrow, single-viewport-constrained) panel width, rotated for space -- all
    // 24 real hourly points are still plotted, just not all individually labeled.
    xScale.ticks = { color:'#6b7280', autoSkip:true, maxTicksLimit:12, maxRotation:45, minRotation:45, font:{size:9} };
  }
  charts[key] = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[
      { label:'PSI (24-hr)', data:psiSeries, borderColor:'#d4a843', backgroundColor:'#d4a84333',
        borderWidth:1.5, pointRadius:0, tension:0, fill:'origin', spanGaps:false, yAxisID:'yPsi' },
      { label:'PM2.5 (1-hr, µg/m³)', data:pm25Series, borderColor:'#e07a3f', backgroundColor:'transparent',
        borderWidth:1.5, pointRadius:0, tension:0.15, spanGaps:false, yAxisID:'yPm' }
    ]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false,
      interaction:{mode:'index', intersect:false},
      layout:{ padding:{ top:4, bottom:0 } },
      scales:{
        x: xScale,
        yPsi:{ position:'left', beginAtZero:true, ticks:{ color:'#d4a843', font:{size:9.5} }, grid:{ color:'#262b33' }, title:{display:true,text:'PSI',color:'#d4a843',font:{size:9.5}} },
        yPm:{ position:'right', beginAtZero:true, ticks:{ color:'#e07a3f', font:{size:9.5} }, grid:{ display:false }, title:{display:true,text:'PM2.5',color:'#e07a3f',font:{size:9.5}} }
      },
      plugins:{ legend:{ labels:{ color:'#9aa3af', boxWidth:12, font:{size:10}, padding:8 } } }
    }
  });
  positionLiveDots(canvasId, charts[key]);
}

/* Pulsing "live" dot at the last real (non-null) observation of each series --
 * purely a visual cue, not a data point of its own. Positioned over the canvas
 * using Chart.js's own pixel coordinates for the last plotted point, and
 * repositioned on window resize since the canvas itself resizes responsively. */
function positionLiveDots(canvasId, chart){
  const wrap = document.getElementById(canvasId).parentElement;
  const colors = ['#d4a843', '#e07a3f'];
  chart.data.datasets.forEach((ds, i)=>{
    let idx = -1;
    for(let j=ds.data.length-1; j>=0; j--){ if(ds.data[j]!==null){ idx=j; break; } }
    let dot = wrap.querySelector(`.live-dot-${i}`);
    if(idx<0){ if(dot) dot.style.display = 'none'; return; }
    const meta = chart.getDatasetMeta(i);
    const point = meta.data[idx];
    if(!point) return;
    if(!dot){
      dot = document.createElement('div');
      dot.className = `live-dot live-dot-${i}`;
      dot.style.setProperty('--dc', colors[i] || '#fff');
      wrap.appendChild(dot);
    }
    dot.style.display = '';
    dot.style.left = point.x + 'px';
    dot.style.top = point.y + 'px';
  });
}
window.addEventListener('resize', ()=>{
  clearTimeout(window.__liveDotResizeT);
  window.__liveDotResizeT = setTimeout(()=>{
    if(charts.chart7d) positionLiveDots('chart-7d', charts.chart7d);
    if(charts.chart24h) positionLiveDots('chart-24h', charts.chart24h);
  }, 200);
});

/* ============== Methodology overlay ============== */
function initOverlay(){
  const overlay = document.getElementById('methodology-overlay');
  document.getElementById('methodology-btn').addEventListener('click', ()=>{ overlay.hidden = false; });
  document.getElementById('methodology-close').addEventListener('click', ()=>{ overlay.hidden = true; });
  overlay.addEventListener('click', (e)=>{ if(e.target === overlay) overlay.hidden = true; });
}

/* ============== Init ============== */
async function refreshLive(){ await Promise.all([loadPSI(), loadPM25()]); }

document.addEventListener('DOMContentLoaded', async ()=>{
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(tickLiveAgo, 1000);

  initOverlay();
  initTrendToggle();
  renderRegionalMap(); // static, no fetch
  renderForecast();
  setInterval(renderForecast, 60 * 60 * 1000); // re-check hourly, mainly to catch the day rollover
  renderHeadlines();
  setInterval(renderHeadlines, 20 * 60 * 1000); // headlines don't need live-refresh cadence

  // Sequenced, not fired all at once -- data.gov.sg rate-limits bursts of
  // unauthenticated requests, and loadHistory alone makes ~14 calls.
  await refreshLive();
  // Hour-over-hour trend straight away (1 call for today's PSI) -- it drives the header
  // ▲/▼ badge and the favicon arrow, and previously only arrived with the full 14-day history
  // fetch below, which can take a minute+ if NEA is rate-limiting, leaving the favicon a dot.
  await refreshHourlyTrend();
  setInterval(refreshLive, 5 * 60 * 1000);

  await loadWeather();
  setInterval(loadWeather, 5 * 60 * 1000);

  await loadWind();
  setInterval(loadWind, 5 * 60 * 1000);

  // Full reload on the same 15-min cadence -- this is what keeps the trend charts, the
  // min/max range bars, and the momentum badge current. Without this interval they were
  // computed once at page load and silently froze there for the rest of the session,
  // while everything else on the page kept visibly refreshing (the "live" pulse dots
  // on the charts were therefore marking a point that was hours stale, not current).
  loadHistory();
  setInterval(loadHistory, 15 * 60 * 1000);
  // Lightweight 1-call header-only refresh, offset to the midpoint between the heavier
  // full reloads above so it actually lands in between them rather than firing alongside.
  setTimeout(()=>{
    refreshHourlyTrend();
    setInterval(refreshHourlyTrend, 15 * 60 * 1000);
  }, 7.5 * 60 * 1000);
});
