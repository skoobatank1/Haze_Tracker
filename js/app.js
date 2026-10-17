'use strict';

/* ============== Constants / sources ============== */
const PSI_URL = 'https://api.data.gov.sg/v1/environment/psi';
const PM25_URL = 'https://api-open.data.gov.sg/v2/real-time/api/pm25';
const RH_URL = 'https://api.data.gov.sg/v1/environment/relative-humidity';
const RAIN_URL = 'https://api.data.gov.sg/v1/environment/rainfall';
const WIND_DIR_URL = 'https://api.data.gov.sg/v1/environment/wind-direction';
const WIND_SPD_URL = 'https://api.data.gov.sg/v1/environment/wind-speed';
const FOURDAY_URL = 'https://api.data.gov.sg/v1/environment/4-day-weather-forecast';
const REGIONS = ['north','south','east','west','central'];
const PSI_CADENCE_MIN = 60; // confirmed via live timestamps: psi_twenty_four_hourly only updates on the hour, despite the dataset page's generic "every 15 min" text
const PM25_CADENCE_MIN = 60;
const HISTORY_DAYS = 7;
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
// Exact wording from haze.gov.sg's PM2.5 advisory table.
const PM25_ADVISORY = {
  1: {healthy:'CONTINUE with normal activities', vulnerable:'CONTINUE with normal activities'},
  2: {healthy:'REDUCE strenuous outdoor activities', vulnerable:'AVOID strenuous outdoor activities'},
  3: {healthy:'AVOID strenuous outdoor activities', vulnerable:'AVOID all outdoor activities'},
  4: {healthy:'MINIMISE all outdoor activities', vulnerable:'AVOID all outdoor activities'}
};
const PROFILE_TIER = {
  healthy:'healthy', exertion:'healthy',
  elderly:'vulnerable', pregnant:'vulnerable', child:'vulnerable', chronic:'vulnerable'
};
const VERDICT_MAP = {
  '1-healthy':   {cls:'v-good',    headline:'Normal activities OK'},
  '1-vulnerable':{cls:'v-good',    headline:'Normal activities OK'},
  '2-healthy':   {cls:'v-caution', headline:'Reduce strenuous outdoor activity'},
  '2-vulnerable':{cls:'v-avoid',   headline:'Avoid strenuous outdoor activity'},
  '3-healthy':   {cls:'v-avoid',   headline:'Avoid strenuous outdoor activity'},
  '3-vulnerable':{cls:'v-stay-in', headline:'Avoid all outdoor activity'},
  '4-healthy':   {cls:'v-stay-in', headline:'Minimise all outdoor activity'},
  '4-vulnerable':{cls:'v-stay-in', headline:'Avoid all outdoor activity'}
};

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
  const map = { 'ago-psi': Math.max(lastFetchTimes.psi||0, lastFetchTimes.pm25||0), 'ago-nowcast': lastFetchTimes.nowcast||0, 'ago-wind': lastFetchTimes.wind||0 };
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
function updateFaviconAndTitle(psiVal){
  if(typeof psiVal !== 'number') return;
  document.title = `${psiVal} · Singapore Haze Tracker`;
  if(!faviconLink){
    faviconLink = document.querySelector('link[rel="icon"]');
    if(!faviconLink){ faviconLink = document.createElement('link'); faviconLink.rel = 'icon'; document.head.appendChild(faviconLink); }
  }
  const hex = BAND_HEX_FAVICON[psiBand(psiVal).cls] || '#888';
  const canvas = document.createElement('canvas');
  canvas.width = 32; canvas.height = 32;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = hex;
  ctx.beginPath(); ctx.arc(16, 16, 15, 0, Math.PI*2); ctx.fill();
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
let cachedPsiFullSeries = null, cachedPm25FullSeries = null; // hourly grid of {region:val} objects from loadHistory, reused for min/max ranges

// Min/max across ALL 5 regions (not just the island-wide average) -- the 7-day max for
// PSI, say, could be a single region's reading on one hour, never seen in the average
// series at all. Tracks which region each extreme came from for the label.
function extremeAcrossRegions(fullSeries, hoursBack){
  const slice = hoursBack ? fullSeries.slice(-hoursBack) : fullSeries;
  let min=null, max=null, minRegion=null, maxRegion=null;
  slice.forEach(byRegion=>{
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

function computeMomentum(psiSeries){
  const last24 = meanIgnoringNull(psiSeries.slice(-24));
  const prev24 = meanIgnoringNull(psiSeries.slice(-48,-24));
  if(last24===null || prev24===null) return null;
  const d = Math.round((last24-prev24)*10)/10;
  const cls = d>0 ? 'trend-up' : d<0 ? 'trend-down' : 'trend-flat';
  const arrow = d>0 ? '▲' : d<0 ? '▼' : '▬';
  const word = d>0 ? 'Worsening' : d<0 ? 'Improving' : 'Steady';
  return {last24, prev24, d, cls, arrow, word};
}

function renderMomentum(psiSeries){
  lastMomentum = computeMomentum(psiSeries);
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

function renderHeaderPSI(){
  const el = document.getElementById('header-psi');
  if(!el) return;
  const valEl = el.querySelector('.header-psi-value');
  const trendEl = el.querySelector('.header-psi-trend');
  if(!latestPSI || latestPSI.error || typeof latestPSI.avg !== 'number'){
    valEl.textContent = '—'; valEl.className = 'header-psi-value'; trendEl.textContent = '';
    return;
  }
  const band = psiBand(latestPSI.avg);
  const stale = isStale(latestPSI.ts, PSI_CADENCE_MIN);
  valEl.textContent = latestPSI.avg;
  valEl.className = `header-psi-value ${band.cls}${stale ? ' stale' : ''}`;
  flashEl(valEl, 'headerPsi', latestPSI.avg);
  updateFaviconAndTitle(latestPSI.avg);
  // Staleness is shown only as a subtle color shift on the number itself (and in this
  // tooltip) rather than a separate badge -- the trend word already occupies that space.
  const staleNote = stale ? ` — no fresher reading since ${fmtTime(latestPSI.ts)}` : '';
  if(lastMomentum){
    const m = lastMomentum;
    trendEl.innerHTML = `<span class="${m.cls}">${m.arrow} ${m.word}</span>`;
    el.title = `Island-wide average PSI (24-hr), reading ${fmtTime(latestPSI.ts)}${staleNote}. Trend: ${m.word.toLowerCase()} — last 24h averaged ${Math.round(m.last24)} vs ${Math.round(m.prev24)} the preceding 24h.`;
  } else {
    trendEl.innerHTML = '';
    el.title = `Island-wide average PSI (24-hr), reading ${fmtTime(latestPSI.ts)}${staleNote}. Trend data loading…`;
  }
}

function regionName(r){ return r.charAt(0).toUpperCase()+r.slice(1); }

function rangeRowHtml(label, unit, fullSeries, scaleMax, trackClass, currentVal, period){
  const r = extremeAcrossRegions(fullSeries, period==='24h' ? 24 : null);
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

function renderLiveRanges(psiFullSeries, pm25FullSeries){
  if(psiFullSeries) cachedPsiFullSeries = psiFullSeries;
  if(pm25FullSeries) cachedPm25FullSeries = pm25FullSeries;
  const el = document.getElementById('range-scales');
  if(!el) return;
  if(!cachedPsiFullSeries && !cachedPm25FullSeries){
    el.textContent = 'Range data loading…';
    return;
  }
  const psiNow = latestPSI && !latestPSI.error ? latestPSI.avg : null;
  const pmNow = latestPM25 && !latestPM25.error ? latestPM25.avg : null;

  function subsection(period){
    let rows = '';
    if(cachedPsiFullSeries) rows += rangeRowHtml('PSI', '', cachedPsiFullSeries, PSI_BAR_MAX, '', psiNow, period);
    if(cachedPm25FullSeries) rows += rangeRowHtml('PM2.5', ' µg/m³', cachedPm25FullSeries, PM25_BAR_MAX, 'pm25-scale', pmNow, period);
    return `<div class="range-subsection"><div class="range-subhead">${period === '24h' ? 'Last 24 hours' : 'Last 7 days'}</div>${rows}</div>`;
  }
  el.innerHTML = subsection('24h') + subsection('7d');
}

async function loadPSI(){
  try{
    const json = await fetchJson(PSI_URL);
    const item = json.items && json.items[0];
    if(!item) throw new Error('No items in response');
    const readings = item.readings.psi_twenty_four_hourly;
    latestPSI = {ts:item.timestamp, byRegion:readings, avg:avgOf(readings)};
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
  renderPersonalAdvisory();
}

function onLiveDataUpdated(){
  renderLiveRanges();
  renderHeaderPSI();
  refreshNowcast();
  markFetched('nowcast');
}

/* ============== Header weather widget (humidity + rain likelihood) ==============
 * NEA does not publish a numeric rain probability anywhere we could find (checked
 * both data.gov.sg and weather.gov.sg). "Raining now" is instead a real-time
 * measurement: the share of NEA's live rainfall stations currently reading >0mm --
 * actual observed precipitation, not a forecast or invented probability. Station
 * coverage on both the humidity and rainfall live endpoints can be sparse at any
 * given moment (observed as low as 1 station for humidity) -- shown as "N stations"
 * rather than implied as a full-network average. */
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
  try{
    const rh = await fetchJson(RH_URL);
    const rhItem = rh.items && rh.items[0];
    const rhReadings = rhItem ? rhItem.readings : [];
    const rhAvg = rhReadings.length
      ? Math.round((rhReadings.reduce((a,r)=>a+r.value,0)/rhReadings.length)*10)/10
      : null;

    await sleep(300);
    const rain = await fetchJson(RAIN_URL);
    const rainItem = rain.items && rain.items[0];
    const rainReadings = rainItem ? rainItem.readings : [];
    const wetStations = rainReadings.filter(r=>r.value>0);
    const rainPct = rainReadings.length ? Math.round((wetStations.length/rainReadings.length)*100) : null;
    const maxMm = rainReadings.length ? Math.max(...rainReadings.map(r=>r.value)) : null;

    el.innerHTML = `
      <span class="weather-stat${flashClass('rhAvg', rhAvg)}" title="Average of ${rhReadings.length} reporting station(s), source: NEA relative-humidity API">
        💧 ${rhAvg!==null ? rhAvg+'%' : '—'} <span class="weather-sub">RH (${rhReadings.length} st)</span>
      </span>
      <span class="weather-stat${flashClass('rainPct', rainPct)}" title="Real-time measurement, not a forecast or probability: the share of NEA's live rainfall stations currently reading >0mm, out of ${rainReadings.length} reporting right now. Source: ${RAIN_URL}. ${maxMm!==null?`Highest current station reading: ${maxMm}mm.`:''}">
        🌧 ${rainPct!==null ? rainPct+'%' : '—'} <span class="weather-sub">raining now (${wetStations.length}/${rainReadings.length} st)</span>
      </span>`;
    markFetched('weather');
  }catch(e){
    el.innerHTML = `<span class="err" title="${e.message}">Weather data unavailable</span>`;
  }
}

/* ============== Wind panel: live observed + official 4-day forecast ==============
 * Current conditions: circular mean of NEA's live wind-direction/wind-speed stations.
 * Forecast: NEA/MSS's own published 4-day outlook API -- a real forecast, not derived
 * from current conditions. */
const COMPASS_WORDS = ['north','north-northeast','northeast','east-northeast','east','east-southeast','southeast','south-southeast',
  'south','south-southwest','southwest','west-southwest','west','west-northwest','northwest','north-northwest'];
function compassWord(deg){ return COMPASS_WORDS[Math.round(deg/22.5) % 16]; }
const KT_TO_KMH = 1.852; // NEA's wind-speed API reports knots; display converts to km/h
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

    const meanSpdKmh = meanSpd!==null ? Math.round(meanSpd * KT_TO_KMH * 10)/10 : null;
    const nowSentence = meanDir!==null
      ? `Currently blowing from the ${compassWord(meanDir)} at ${meanSpdKmh}km/h (${speedWord(meanSpd)})${isFromWSW(meanDir)?' — this direction can carry smoke from Sumatra toward Singapore':''}.`
      : 'Current wind reading unavailable.';

    let forecastSentence;
    if(forecasts.length){
      const dirWords = forecasts.map(f=>compassWord(compassToDeg(f.wind.direction))).filter((v,i,a)=>v && a.indexOf(v)===i);
      const minKmh = Math.round(Math.min(...forecasts.map(f=>f.wind.speed.low)) * KT_TO_KMH);
      const maxKmh = Math.round(Math.max(...forecasts.map(f=>f.wind.speed.high)) * KT_TO_KMH);
      const commonForecast = forecasts[0].forecast.toLowerCase();
      const anyWSW = forecasts.some(f=>isFromWSW(compassToDeg(f.wind.direction)));
      const dirPhrase = dirWords.length<=1 ? `from the ${dirWords[0]||'—'}` : `shifting between ${dirWords.join(' and ')}`;
      forecastSentence = `Next ${forecasts.length} days: wind ${dirPhrase}, ${minKmh}&ndash;${maxKmh}km/h, with ${commonForecast} expected.${anyWSW?' At times from the usual Sumatra-fire direction toward Singapore.':''}`;
    } else {
      forecastSentence = '3-day forecast unavailable.';
    }

    el.innerHTML = `
      <div class="wind-now">
        <div class="wind-compass"><div class="wind-arrow" style="transform:rotate(${meanDir!==null?meanDir+180:0}deg)"></div></div>
        <div class="wind-now-stats">
          <div class="wind-now-main${flashClass('windDir', meanDir)}">${meanDir!==null?compassWord(meanDir):'—'}</div>
          <div class="${flashClass('windSpd', meanSpdKmh).trim()}">${meanSpdKmh!==null?meanSpdKmh+' km/h':'—'} <span class="weather-sub">(${speedWord(meanSpd)})</span></div>
        </div>
      </div>
      <p class="wind-sentence">${nowSentence}</p>
      <p class="wind-sentence">${forecastSentence}</p>
      <div class="weather-sub" title="Now: circular mean of ${dirReadings.length} wind-direction and ${spdReadings.length} wind-speed stations (${meanDir!==null?Math.round(meanDir)+'°, ':''}${meanSpd!==null?meanSpd+' kt':''}), source NEA wind-direction/wind-speed APIs. Forecast: NEA/MSS's 4-day-weather-forecast API, first 3 days summarized. Direction is where wind blows FROM. 1 knot = 1.852 km/h.">Sources &amp; exact figures</div>`;
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
  return `
    <div class="nowcast-metric">
      <div class="nowcast-label">${label}</div>
      <div class="nowcast-headline">
        <span class="nowcast-value ${band.cls}${flashClass(flashKey, data.avg)}">${data.avg}</span>
        <span class="nowcast-unit">${unit}</span>
      </div>
      <div class="nowcast-band ${band.cls}">${band.label}</div>
      ${regionListHtml(data.byRegion, data.avg, bandFn, threshold, unit, scaleMax)}
    </div>`;
}

function refreshNowcast(){
  const body = document.getElementById('nowcast-body');
  body.innerHTML =
    nowcastMetricHtml('PSI (24-hr)', '', latestPSI, psiBand, PSI_DIVERGENCE_THRESHOLD, 'nowcastPsi', PSI_BAR_MAX) +
    nowcastMetricHtml('PM2.5 (1-hr)', 'µg/m³', latestPM25, pm25Band, PM25_DIVERGENCE_THRESHOLD, 'nowcastPm25', PM25_BAR_MAX);
}

/* ============== Personal advisory ============== */
function renderPersonalAdvisory(){
  const body = document.getElementById('personal-body');
  const profile = document.getElementById('profile-select').value;
  const tier = PROFILE_TIER[profile];

  if(!latestPM25 || latestPM25.error || typeof latestPM25.avg !== 'number'){
    body.innerHTML = `<div class="err">No current PM2.5 reading available.</div>`;
    return;
  }
  const v = latestPM25.avg;
  const bandNum = pm25BandNum(v);
  const verdict = VERDICT_MAP[`${bandNum}-${tier}`];
  const advisoryText = PM25_ADVISORY[bandNum][tier];
  const exertionNote = profile==='exertion'
    ? '<br><br>Sustained outdoor exertion increases how much you inhale regardless of band — treat the "reduce/avoid strenuous activity" guidance as applying especially to you.'
    : '';

  body.innerHTML = `
    <div class="advisory-verdict ${verdict.cls}">${verdict.headline}</div>
    <div class="advisory-detail">
      Based on island-wide average PM2.5 = ${v} µg/m³ (${pm25Band(v).label}).<br>
      Official guidance (${tier==='healthy'?'healthy person':'vulnerable person'}): <strong>${advisoryText}</strong>${exertionNote}
    </div>`;
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

async function loadHistory(){
  const status7El = document.getElementById('history7-status');
  const status24El = document.getElementById('history24-status');
  status7El.textContent = `Loading last ${HISTORY_DAYS} days…`;
  status24El.textContent = `Loading last 24h…`;

  const dateStrs = Array.from({length:HISTORY_DAYS}, (_,i)=>sgtDateString(HISTORY_DAYS-1-i));
  // Full expected hourly grid for the window -- real NEA timestamps land exactly on these marks,
  // so a day that fails to load leaves true nulls (a visible gap), never a silently bridged line.
  const grid = [];
  dateStrs.forEach(d=>{ for(let h=0; h<24; h++){ grid.push(`${d}T${String(h).padStart(2,'0')}:00:00+08:00`); } });

  const failedPSIDays = [], failedPM25Days = [];
  const psiByTs = {}, pm25ByTs = {}; // t -> {v, byRegion}

  // Fetch newest-first: if a rate limit cuts the loop short, it's the oldest (least
  // important) days that go missing, not today's -- this was the actual cause of the
  // chart appearing to "stop" days before the present.
  const fetchOrder = dateStrs.slice().reverse();
  for(const d of fetchOrder){
    try{ (await fetchDayPSI(d)).forEach(p=>{ psiByTs[p.t]={v:p.v, byRegion:p.byRegion}; }); }
    catch(e){ failedPSIDays.push(d + ' (PSI: ' + e.message + ')'); }
    await sleep(350); // space requests out -- data.gov.sg rate-limits rapid unauthenticated bursts
    try{ (await fetchDayPM25(d)).forEach(p=>{ pm25ByTs[p.t]={v:p.v, byRegion:p.byRegion}; }); }
    catch(e){ failedPM25Days.push(d + ' (PM2.5: ' + e.message + ')'); }
    await sleep(350);
  }

  const psiSeries = grid.map(t => (t in psiByTs) ? psiByTs[t].v : null);
  const pm25Series = grid.map(t => (t in pm25ByTs) ? pm25ByTs[t].v : null);
  const psiFullSeries = grid.map(t => (t in psiByTs) ? psiByTs[t].byRegion : null);
  const pm25FullSeries = grid.map(t => (t in pm25ByTs) ? pm25ByTs[t].byRegion : null);

  renderLineChart('chart-7d', grid, psiSeries, pm25Series, 'chart7d', true);
  renderLineChart('chart-24h', grid.slice(-24), psiSeries.slice(-24), pm25Series.slice(-24), 'chart24h', false);
  renderLiveRanges(psiFullSeries, pm25FullSeries);
  renderMomentum(psiSeries);

  let nPsi = psiSeries.filter(v=>v!==null).length, nPm = pm25Series.filter(v=>v!==null).length;
  let status = `${nPsi} PSI / ${nPm} PM2.5 hourly points over ${HISTORY_DAYS} days, pulled live from NEA's own date-range query (same source as the live panel).`;
  if(failedPSIDays.length) status += ` PSI missing: ${failedPSIDays.join(', ')} (shown as a gap, not interpolated).`;
  if(failedPM25Days.length) status += ` PM2.5 missing: ${failedPM25Days.join(', ')} (shown as a gap, not interpolated).`;
  status7El.textContent = status;

  const n24Psi = psiSeries.slice(-24).filter(v=>v!==null).length, n24Pm = pm25Series.slice(-24).filter(v=>v!==null).length;
  status24El.textContent = `${n24Psi}/24 PSI, ${n24Pm}/24 PM2.5 hourly points over the last 24h, same source.`;
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
    xScale.ticks = { color:'#6b7280', autoSkip:false, callback:(val, idx)=> idx % 24 === 0 ? labels[idx] : null, maxRotation:0 };
    xScale.grid = { color: (c)=> c.index % 24 === 0 ? '#262b33' : 'transparent' };
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
      scales:{
        x: xScale,
        yPsi:{ position:'left', beginAtZero:true, ticks:{ color:'#d4a843' }, grid:{ color:'#262b33' }, title:{display:true,text:'PSI',color:'#d4a843',font:{size:10}} },
        yPm:{ position:'right', beginAtZero:true, ticks:{ color:'#e07a3f' }, grid:{ display:false }, title:{display:true,text:'PM2.5 µg/m³',color:'#e07a3f',font:{size:10}} }
      },
      plugins:{ legend:{ labels:{ color:'#9aa3af', boxWidth:12, font:{size:10.5} } } }
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

  // Sequenced, not fired all at once -- data.gov.sg rate-limits bursts of
  // unauthenticated requests, and loadHistory alone makes ~14 calls.
  await refreshLive();
  setInterval(refreshLive, 5 * 60 * 1000);

  await loadWeather();
  setInterval(loadWeather, 5 * 60 * 1000);

  await loadWind();
  setInterval(loadWind, 5 * 60 * 1000);

  loadHistory();

  document.getElementById('profile-select').addEventListener('change', renderPersonalAdvisory);
});
