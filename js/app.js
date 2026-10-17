'use strict';

/* ============== Constants / sources ============== */
const PSI_URL = 'https://api.data.gov.sg/v1/environment/psi';
const PM25_URL = 'https://api-open.data.gov.sg/v2/real-time/api/pm25';
const RH_URL = 'https://api.data.gov.sg/v1/environment/relative-humidity';
const FORECAST_URL = 'https://api.data.gov.sg/v1/environment/2-hour-weather-forecast';
const REGIONS = ['north','south','east','west','central'];
const PSI_CADENCE_MIN = 15;
const PM25_CADENCE_MIN = 60;
const HISTORY_DAYS = 7;
const PSI_BAR_MAX = 400;   // display scale for the live-table bar, headroom above Hazardous(301+)
const PM25_BAR_MAX = 500;  // headroom above Band 4(251+)

/* ============== Fetch helper: data.gov.sg rate-limits bursts of
 * unauthenticated requests (observed HTTP 429 after ~7 rapid sequential
 * calls while testing). Retry 429s with backoff instead of treating a
 * rate limit as "no data for that day". ============== */
function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }
async function fetchJson(url, retries=3, backoffMs=800){
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
let cachedPsiSeries = null, cachedPm25Series = null; // hourly grid series from loadHistory, reused for min/max ranges

function rangeOf(series, hoursBack){
  const slice = hoursBack ? series.slice(-hoursBack) : series;
  const vals = slice.filter(v=>v!==null);
  if(!vals.length) return null;
  return {min: Math.min(...vals), max: Math.max(...vals)};
}

function renderLiveRanges(psiSeries, pm25Series){
  if(psiSeries) cachedPsiSeries = psiSeries;
  if(pm25Series) cachedPm25Series = pm25Series;
  const el = document.getElementById('live-ranges');
  if(!el) return;
  if(!cachedPsiSeries && !cachedPm25Series){
    el.textContent = 'Range data loading…';
    return;
  }
  function line(label, series, unit){
    const r24 = rangeOf(series, 24);
    const r7d = rangeOf(series, null);
    const fmt = r => r ? `${r.min}–${r.max}${unit}` : '—';
    return `${label} avg — 24h: ${fmt(r24)} &nbsp;·&nbsp; 7d: ${fmt(r7d)}`;
  }
  const parts = [];
  if(cachedPsiSeries) parts.push(line('PSI', cachedPsiSeries, ''));
  if(cachedPm25Series) parts.push(line('PM2.5', cachedPm25Series, ' µg/m³'));
  el.innerHTML = parts.join('<br>');
}

async function loadPSI(){
  try{
    const json = await fetchJson(PSI_URL);
    const item = json.items && json.items[0];
    if(!item) throw new Error('No items in response');
    const readings = item.readings.psi_twenty_four_hourly;
    latestPSI = {ts:item.timestamp, byRegion:readings, avg:avgOf(readings)};
  }catch(e){
    latestPSI = {error:e.message};
  }
  renderLiveTable();
}

async function loadPM25(){
  try{
    const json = await fetchJson(PM25_URL);
    if(json.code !== 0) throw new Error(json.errorMsg || 'API returned error code');
    const item = json.data.items && json.data.items[0];
    if(!item) throw new Error('No items in response');
    const readings = item.readings.pm25_one_hourly;
    latestPM25 = {ts:item.timestamp, byRegion:readings, avg:avgOf(readings)};
  }catch(e){
    latestPM25 = {error:e.message};
  }
  renderLiveTable();
  renderPersonalAdvisory();
}

const BAND_HEX = {good:'#4caf7d', unhealthy:'#d4a843', veryunhealthy:'#e07a3f', hazardous:'#d14f4f'};
function valueCell(val, unit, band, ts, cadenceMin, barMax){
  if(typeof val !== 'number') return `<td>—</td>`;
  const stale = ts ? isStale(ts, cadenceMin) : false;
  const title = ts ? (stale ? `No fresher reading since ${fmtTime(ts)}` : `Reading time: ${fmtTime(ts)}`) : '';
  const pct = Math.max(2, Math.min(100, Math.round((val/barMax)*100)));
  const hex = BAND_HEX[band.cls] || '#555';
  const barStyle = `background:linear-gradient(to right, color-mix(in srgb, ${hex} 32%, transparent) ${pct}%, transparent ${pct}%)`;
  return `<td class="${stale?'stale':''} bar-cell" style="${barStyle}" title="${title}"><span class="band-dot ${band.dot}"></span><span class="${band.cls}">${val}${unit?(' '+unit):''}</span></td>`;
}

function renderLiveTable(){
  const tbody = document.querySelector('#live-table tbody');
  const foot = document.getElementById('live-foot');
  if(latestPSI && latestPSI.error && latestPM25 && latestPM25.error){
    tbody.innerHTML = `<tr><td colspan="3" class="err">Both feeds failed: ${latestPSI.error} / ${latestPM25.error}</td></tr>`;
    return;
  }
  function psiCell(key){
    if(!latestPSI || latestPSI.error) return '<td class="err" title="'+(latestPSI?latestPSI.error:'')+'">err</td>';
    const v = key==='avg' ? latestPSI.avg : latestPSI.byRegion[key];
    return valueCell(v, '', typeof v==='number'?psiBand(v):{dot:'',cls:''}, latestPSI.ts, PSI_CADENCE_MIN, PSI_BAR_MAX);
  }
  function pmCell(key){
    if(!latestPM25 || latestPM25.error) return '<td class="err" title="'+(latestPM25?latestPM25.error:'')+'">err</td>';
    const v = key==='avg' ? latestPM25.avg : latestPM25.byRegion[key];
    return valueCell(v, '', typeof v==='number'?pm25Band(v):{dot:'',cls:''}, latestPM25.ts, PM25_CADENCE_MIN, PM25_BAR_MAX);
  }

  // Sort regions by PSI descending (worst first); regions with no PSI reading sort last.
  const sortedRegions = REGIONS.slice().sort((a,b)=>{
    const va = latestPSI && !latestPSI.error ? latestPSI.byRegion[a] : undefined;
    const vb = latestPSI && !latestPSI.error ? latestPSI.byRegion[b] : undefined;
    if(typeof va !== 'number' && typeof vb !== 'number') return 0;
    if(typeof va !== 'number') return 1;
    if(typeof vb !== 'number') return -1;
    return vb - va;
  });

  let html = `<tr class="avg-row"><td>Average</td>${psiCell('avg')}${pmCell('avg')}</tr>`;
  sortedRegions.forEach(r=>{
    html += `<tr><td>${r.charAt(0).toUpperCase()+r.slice(1)}</td>${psiCell(r)}${pmCell(r)}</tr>`;
  });
  tbody.innerHTML = html;

  renderLiveRanges();

  const bits = [];
  if(latestPSI && !latestPSI.error) bits.push(`PSI: <a href="${PSI_URL}" target="_blank" rel="noopener">NEA PSI API</a>, reading ${fmtTime(latestPSI.ts)}`);
  if(latestPM25 && !latestPM25.error) bits.push(`PM2.5: <a href="${PM25_URL}" target="_blank" rel="noopener">NEA PM2.5 API</a>, reading ${fmtTime(latestPM25.ts)}`);
  foot.innerHTML = bits.join(' &nbsp;|&nbsp; ') || 'Loading…';
}

/* ============== Header weather widget (humidity + rain likelihood) ==============
 * NEA does not publish a numeric rain probability anywhere we could find -- only a
 * categorical 2-hour forecast per area (e.g. "Cloudy", "Showers"). Rather than fabricate
 * a percentage, we compute a real one: the share of NEA's own 47 forecast areas whose
 * 2-hour categorical forecast contains a rain-related word (shower/rain/drizzle/thunder).
 * This is an actual count of NEA's own output, not an invented probability -- disclosed
 * as such in the tooltip and methodology panel. Station coverage on the live humidity
 * endpoint can be sparse at any given moment (observed as low as 1 of ~16 stations) --
 * shown as "N stations" rather than implied as a full-network average. */
const RAIN_KEYWORDS = /shower|rain|drizzle|thunder/i;

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
    const fc = await fetchJson(FORECAST_URL);
    const fcItem = fc.items && fc.items[0];
    const forecasts = fcItem ? fcItem.forecasts : [];
    const rainAreas = forecasts.filter(f=>RAIN_KEYWORDS.test(f.forecast));
    const rainPct = forecasts.length ? Math.round((rainAreas.length/forecasts.length)*100) : null;
    const counts = {};
    forecasts.forEach(f=>{ counts[f.forecast] = (counts[f.forecast]||0)+1; });
    let dominant = null, domCount = 0;
    Object.entries(counts).forEach(([k,v])=>{ if(v>domCount){ dominant=k; domCount=v; } });

    el.innerHTML = `
      <span class="weather-stat" title="Average of ${rhReadings.length} reporting station(s), source: NEA relative-humidity API">
        💧 ${rhAvg!==null ? rhAvg+'%' : '—'} <span class="weather-sub">RH (${rhReadings.length} st)</span>
      </span>
      <span class="weather-stat" title="NEA publishes no numeric rain probability. This is the actual share of NEA's 47 2-hour-forecast areas whose forecast text contains a rain-related word (shower/rain/drizzle/thunder) -- a real count, not an invented percentage. Dominant forecast: ${dominant||'—'} (${domCount}/${forecasts.length} areas).">
        🌧 ${rainPct!==null ? rainPct+'%' : '—'} <span class="weather-sub">rain likelihood (2h)</span>
      </span>`;
  }catch(e){
    el.innerHTML = `<span class="err" title="${e.message}">Weather data unavailable</span>`;
  }
}

/* ============== Nowcast (PSI + PM2.5 trend) ============== */
function deltaHtml(current, ref, label){
  if(!ref) return `<div class="nowcast-delta">${label}<br><span class="dv">—</span></div>`;
  const d = Math.round((current.v - ref.v)*10)/10;
  const cls = d>3 ? 'trend-up' : d<-3 ? 'trend-down' : 'trend-flat';
  const arrow = d>3 ? '▲' : d<-3 ? '▼' : '▬';
  return `<div class="nowcast-delta">${label}<br><span class="dv ${cls}">${arrow} ${d>0?'+':''}${d}</span></div>`;
}
function pointAt(points, idxFromEnd){
  const i = points.length-1-idxFromEnd;
  return i>=0 ? points[i] : null;
}
function nowcastMetricHtml(label, unit, points, bandFn){
  if(!points.length) return `<div class="err">${label}: no data</div>`;
  const current = points[points.length-1];
  const h1 = pointAt(points, 1);
  const h3 = pointAt(points, 3);
  const h24 = pointAt(points, 24);
  const band = bandFn(current.v);
  return `
    <div class="nowcast-metric">
      <div class="nowcast-headline">
        <span class="nowcast-value ${band.cls}">${current.v}</span>
        <span class="nowcast-unit">${unit} ${label}, ${band.label}</span>
      </div>
      <div class="nowcast-deltas">
        ${deltaHtml(current, h1, '1h ago')}
        ${deltaHtml(current, h3, '3h ago')}
        ${deltaHtml(current, h24, '24h ago')}
      </div>
      <div class="nowcast-reading-time">Reading time: ${fmtTime(current.t)}</div>
    </div>`;
}

async function refreshNowcast(){
  const body = document.getElementById('nowcast-body');
  try{
    // Fetch today + yesterday unconditionally so a 24h-ago comparison is always possible.
    // Sequential with small gaps, not Promise.all -- data.gov.sg rate-limits request bursts.
    const psiToday = await fetchDayPSI(sgtDateString(0)).catch(()=>[]);
    await sleep(300);
    const psiYesterday = await fetchDayPSI(sgtDateString(1)).catch(()=>[]);
    await sleep(300);
    const pmToday = await fetchDayPM25(sgtDateString(0)).catch(()=>[]);
    await sleep(300);
    const pmYesterday = await fetchDayPM25(sgtDateString(1)).catch(()=>[]);
    const psiPoints = psiYesterday.concat(psiToday).filter(p=>p.v!==null).sort((a,b)=> new Date(a.t) - new Date(b.t));
    const pmPoints = pmYesterday.concat(pmToday).filter(p=>p.v!==null).sort((a,b)=> new Date(a.t) - new Date(b.t));
    if(!psiPoints.length && !pmPoints.length) throw new Error('No PSI or PM2.5 points available');

    body.innerHTML =
      nowcastMetricHtml('PSI (24-hr)', '', psiPoints, psiBand) +
      nowcastMetricHtml('PM2.5 (1-hr)', 'µg/m³', pmPoints, pm25Band);
  }catch(e){
    body.innerHTML = `<div class="err">Nowcast failed: ${e.message}</div>`;
  }
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
    </div>
    <div class="advisory-source">Exact wording from haze.gov.sg's PM2.5 advisory table, mapped to NEA's own Healthy/Vulnerable tiers — not generated advice.</div>`;
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
  return (json.items||[]).map(item=>({t:item.timestamp, v: avgOf(item.readings.psi_twenty_four_hourly)}));
}
async function fetchDayPM25(dateStr){
  const json = await fetchJson(`${PM25_URL}?date=${dateStr}`);
  if(json.code !== 0) throw new Error(json.errorMsg || 'API error');
  return (json.data.items||[]).map(item=>({t:item.timestamp, v: avgOf(item.readings.pm25_one_hourly)}));
}

/* ============== Historical combo chart ============== */
let comboChart;

function shortLabel(iso){
  return new Date(iso).toLocaleString('en-SG',{timeZone:'Asia/Singapore', month:'short', day:'2-digit', hour:'2-digit'});
}

async function loadHistory(){
  const statusEl = document.getElementById('history-status');
  statusEl.textContent = `Loading last ${HISTORY_DAYS} days…`;

  const dateStrs = Array.from({length:HISTORY_DAYS}, (_,i)=>sgtDateString(HISTORY_DAYS-1-i));
  // Full expected hourly grid for the window -- real NEA timestamps land exactly on these marks,
  // so a day that fails to load leaves true nulls (a visible gap), never a silently bridged line.
  const grid = [];
  dateStrs.forEach(d=>{ for(let h=0; h<24; h++){ grid.push(`${d}T${String(h).padStart(2,'0')}:00:00+08:00`); } });

  const failedPSIDays = [], failedPM25Days = [];
  const psiByTs = {}, pm25ByTs = {};

  // Fetch newest-first: if a rate limit cuts the loop short, it's the oldest (least
  // important) days that go missing, not today's -- this was the actual cause of the
  // chart appearing to "stop" days before the present.
  const fetchOrder = dateStrs.slice().reverse();
  for(const d of fetchOrder){
    try{ (await fetchDayPSI(d)).forEach(p=>{ psiByTs[p.t]=p.v; }); }
    catch(e){ failedPSIDays.push(d + ' (PSI: ' + e.message + ')'); }
    await sleep(350); // space requests out -- data.gov.sg rate-limits rapid unauthenticated bursts
    try{ (await fetchDayPM25(d)).forEach(p=>{ pm25ByTs[p.t]=p.v; }); }
    catch(e){ failedPM25Days.push(d + ' (PM2.5: ' + e.message + ')'); }
    await sleep(350);
  }

  const psiSeries = grid.map(t => (t in psiByTs) ? psiByTs[t] : null);
  const pm25Series = grid.map(t => (t in pm25ByTs) ? pm25ByTs[t] : null);

  renderComboChart(grid, psiSeries, pm25Series);
  renderLiveRanges(psiSeries, pm25Series);

  let nPsi = psiSeries.filter(v=>v!==null).length, nPm = pm25Series.filter(v=>v!==null).length;
  let status = `${nPsi} PSI / ${nPm} PM2.5 hourly points over ${HISTORY_DAYS} days, pulled live from NEA's own date-range query (same source as the live panel).`;
  if(failedPSIDays.length) status += ` PSI missing: ${failedPSIDays.join(', ')} (shown as a gap, not interpolated).`;
  if(failedPM25Days.length) status += ` PM2.5 missing: ${failedPM25Days.join(', ')} (shown as a gap, not interpolated).`;
  statusEl.textContent = status;
}

function renderComboChart(grid, psiSeries, pm25Series){
  const ctx = document.getElementById('combo-chart').getContext('2d');
  const labels = grid.map(shortLabel);
  if(comboChart) comboChart.destroy();
  comboChart = new Chart(ctx, {
    type:'bar',
    data:{ labels, datasets:[
      { type:'bar', label:'PSI (24-hr)', data:psiSeries, backgroundColor:'#d4a84399', borderColor:'#d4a843',
        borderWidth:0, barPercentage:1.0, categoryPercentage:0.9, yAxisID:'yPsi' },
      { type:'line', label:'PM2.5 (1-hr, µg/m³)', data:pm25Series, borderColor:'#e07a3f', backgroundColor:'transparent',
        borderWidth:1.5, pointRadius:0, tension:0.15, spanGaps:false, yAxisID:'yPm' }
    ]},
    options:{
      responsive:true, maintainAspectRatio:false, animation:false,
      interaction:{mode:'index', intersect:false},
      scales:{
        x:{ ticks:{ color:'#6b7280', maxTicksLimit:8, autoSkip:true }, grid:{ color:'#262b33' } },
        yPsi:{ position:'left', beginAtZero:true, ticks:{ color:'#d4a843' }, grid:{ color:'#262b33' }, title:{display:true,text:'PSI',color:'#d4a843',font:{size:10}} },
        yPm:{ position:'right', beginAtZero:true, ticks:{ color:'#e07a3f' }, grid:{ display:false }, title:{display:true,text:'PM2.5 µg/m³',color:'#e07a3f',font:{size:10}} }
      },
      plugins:{ legend:{ labels:{ color:'#9aa3af', boxWidth:12, font:{size:10.5} } } }
    }
  });
}

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

  initOverlay();

  // Sequenced, not fired all at once -- data.gov.sg rate-limits bursts of
  // unauthenticated requests, and loadHistory alone makes ~14 calls.
  await refreshLive();
  setInterval(refreshLive, 5 * 60 * 1000);

  await loadWeather();
  setInterval(loadWeather, 5 * 60 * 1000);

  await refreshNowcast();
  setInterval(refreshNowcast, 5 * 60 * 1000);

  loadHistory();

  document.getElementById('profile-select').addEventListener('change', renderPersonalAdvisory);
});
