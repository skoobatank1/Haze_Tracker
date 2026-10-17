'use strict';

/* ============== Constants / sources ============== */
const PSI_URL = 'https://api.data.gov.sg/v1/environment/psi';
const PM25_URL = 'https://api-open.data.gov.sg/v2/real-time/api/pm25';
const REGIONS = ['north','south','east','west','central'];
const PSI_CADENCE_MIN = 15;
const PM25_CADENCE_MIN = 60;
const HISTORY_DAYS = 7;

let regionCoords = null; // filled from API's own region_metadata, never hand-entered

/* ============== Bands (source: haze.gov.sg) ============== */
function psiBand(v){
  if(v<=100) return {label:'Good to Moderate', cls:'band-good', color:'#4caf7d'};
  if(v<=200) return {label:'Unhealthy', cls:'band-unhealthy', color:'#d4a843'};
  if(v<=300) return {label:'Very Unhealthy', cls:'band-veryunhealthy', color:'#e07a3f'};
  return {label:'Hazardous', cls:'band-hazardous', color:'#d14f4f'};
}
function pm25Band(v){
  if(v<=55) return {label:'Band 1 (Normal)', cls:'band-good', color:'#4caf7d'};
  if(v<=150) return {label:'Band 2 (Elevated)', cls:'band-unhealthy', color:'#d4a843'};
  if(v<=250) return {label:'Band 3 (High)', cls:'band-veryunhealthy', color:'#e07a3f'};
  return {label:'Band 4 (Very High)', cls:'band-hazardous', color:'#d14f4f'};
}
function fmtTime(iso){
  try{
    return new Date(iso).toLocaleString('en-SG',{dateStyle:'short',timeStyle:'medium',timeZone:'Asia/Singapore'}) + ' SGT';
  }catch(e){ return iso; }
}
function isStale(iso, cadenceMin){
  const ageMin = (Date.now() - new Date(iso).getTime()) / 60000;
  return ageMin > cadenceMin * 2;
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

/* ============== Live reading cards ============== */
function card({label, value, unit, band, timestamp, cadenceMin, sourceLabel, sourceUrl, isAvg}){
  const stale = timestamp ? isStale(timestamp, cadenceMin) : false;
  const b = band || {label:'—', cls:''};
  return `<div class="card ${isAvg?'avg':''} ${stale?'stale':''}">
    <div class="card-label">${label}</div>
    <div class="card-value">${value !== null && value !== undefined ? value : '—'}${unit?(' '+unit):''}</div>
    <div class="card-band ${b.cls}">${stale ? 'STALE — ' + b.label : b.label}</div>
    <div class="card-meta">
      ${timestamp ? (stale ? `No fresher reading since ${fmtTime(timestamp)}` : `Reading time: ${fmtTime(timestamp)}`) : 'No timestamp available'}<br>
      Source: <a href="${sourceUrl}" target="_blank" rel="noopener">${sourceLabel}</a>
    </div>
  </div>`;
}

let latestPSI = null;  // {ts, byRegion:{region:val}}
let latestPM25 = null;

async function loadPSI(){
  const grid = document.getElementById('psi-grid');
  try{
    const res = await fetch(PSI_URL);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const item = json.items && json.items[0];
    if(!item) throw new Error('No items in response');
    if(json.region_metadata) captureRegionCoords(json.region_metadata, 'name', 'label_location');
    const ts = item.timestamp;
    const readings = item.readings.psi_twenty_four_hourly;
    const vals = REGIONS.map(r => readings[r]).filter(v => typeof v === 'number');
    const avg = vals.length ? Math.round((vals.reduce((a,b)=>a+b,0)/vals.length)*10)/10 : null;

    latestPSI = {ts, byRegion: readings};

    let html = card({
      label:'Average (5 regions)', value: avg, band: avg!==null?psiBand(avg):null,
      timestamp: ts, cadenceMin: PSI_CADENCE_MIN,
      sourceLabel:'NEA PSI API', sourceUrl: PSI_URL, isAvg:true
    });
    REGIONS.forEach(r=>{
      const v = readings[r];
      html += card({
        label: r.charAt(0).toUpperCase()+r.slice(1), value: v, band: typeof v==='number'?psiBand(v):null,
        timestamp: ts, cadenceMin: PSI_CADENCE_MIN,
        sourceLabel:'NEA PSI API', sourceUrl: PSI_URL
      });
    });
    grid.innerHTML = html;
    updateHeatmap();
  }catch(e){
    grid.innerHTML = `<div class="err">PSI fetch failed: ${e.message}. Source: <a href="${PSI_URL}" target="_blank" rel="noopener">${PSI_URL}</a> — no reading shown, not substituting a guessed value.</div>`;
  }
}

async function loadPM25(){
  const grid = document.getElementById('pm25-grid');
  try{
    const res = await fetch(PM25_URL);
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if(json.code !== 0) throw new Error(json.errorMsg || 'API returned error code');
    const item = json.data.items && json.data.items[0];
    if(!item) throw new Error('No items in response');
    if(json.data.regionMetadata) captureRegionCoords(json.data.regionMetadata, 'name', 'labelLocation');
    const ts = item.timestamp;
    const readings = item.readings.pm25_one_hourly;
    const vals = REGIONS.map(r => readings[r]).filter(v => typeof v === 'number');
    const avg = vals.length ? Math.round((vals.reduce((a,b)=>a+b,0)/vals.length)*10)/10 : null;

    latestPM25 = {ts, byRegion: readings};

    let html = card({
      label:'Average (5 regions)', value: avg, unit:'µg/m³', band: avg!==null?pm25Band(avg):null,
      timestamp: ts, cadenceMin: PM25_CADENCE_MIN,
      sourceLabel:'NEA PM2.5 API', sourceUrl: PM25_URL, isAvg:true
    });
    REGIONS.forEach(r=>{
      const v = readings[r];
      html += card({
        label: r.charAt(0).toUpperCase()+r.slice(1), value: v, unit:'µg/m³', band: typeof v==='number'?pm25Band(v):null,
        timestamp: ts, cadenceMin: PM25_CADENCE_MIN,
        sourceLabel:'NEA PM2.5 API', sourceUrl: PM25_URL
      });
    });
    grid.innerHTML = html;
    if(heatMode === 'pm25') updateHeatmap();
  }catch(e){
    grid.innerHTML = `<div class="err">PM2.5 fetch failed: ${e.message}. Source: <a href="${PM25_URL}" target="_blank" rel="noopener">${PM25_URL}</a> — no reading shown, not substituting a guessed value.</div>`;
  }
}

function captureRegionCoords(metadata, nameKey, locKey){
  regionCoords = regionCoords || {};
  metadata.forEach(m=>{
    const loc = m[locKey];
    if(loc) regionCoords[m[nameKey]] = [loc.latitude, loc.longitude];
  });
}

/* ============== Choropleth map (Leaflet + precomputed region polygons) ==============
 * The 5 polygons in data/psi_region_voronoi.geojson are NOT an NEA-published
 * boundary -- NEA gives only one reference point per region. They're a
 * Voronoi partition of those 5 exact points, clipped to Singapore's
 * landmass outline, computed offline by scripts/build_region_voronoi.py.
 * This is disclosed in the map's on-page caption and in the methodology panel. */
let map, geoLayer, regionMarkers = [];
let heatMode = 'psi'; // 'psi' | 'pm25'
let regionGeoJSON = null;

function initMap(){
  map = L.map('heatmap', {scrollWheelZoom:false}).setView([1.3521,103.8198], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution:'&copy; OpenStreetMap contributors',
    maxZoom: 14
  }).addTo(map);

  fetch('data/psi_region_voronoi.geojson')
    .then(r => { if(!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(gj => { regionGeoJSON = gj; updateHeatmap(); })
    .catch(e => {
      document.getElementById('map-load-err').textContent =
        `Region boundary file failed to load (${e.message}) — map will show point markers only, no shaded regions.`;
    });
}

function styleForRegion(regionName){
  const src = heatMode === 'psi' ? latestPSI : latestPM25;
  const bandFn = heatMode === 'psi' ? psiBand : pm25Band;
  const val = src && src.byRegion[regionName];
  if(typeof val !== 'number') return {color:'#555', weight:1, fillColor:'#333', fillOpacity:0.3};
  const band = bandFn(val);
  return {color:'#15181c', weight:1, fillColor: band.color, fillOpacity:0.55};
}

function updateHeatmap(){
  if(!map || !regionCoords) return;
  const src = heatMode === 'psi' ? latestPSI : latestPM25;
  const bandFn = heatMode === 'psi' ? psiBand : pm25Band;

  if(geoLayer){ map.removeLayer(geoLayer); geoLayer = null; }
  if(regionGeoJSON){
    geoLayer = L.geoJSON(regionGeoJSON, {
      style: feat => styleForRegion(feat.properties.region),
      onEachFeature: (feat, layer) => {
        const r = feat.properties.region;
        const val = src && src.byRegion[r];
        const band = typeof val === 'number' ? bandFn(val) : null;
        layer.bindPopup(
          `<strong>${r.charAt(0).toUpperCase()+r.slice(1)} region</strong><br>` +
          (typeof val === 'number'
            ? `${heatMode==='psi'?'PSI (24-hr)':'PM2.5 (1-hr)'}: <strong>${val}${heatMode==='pm25'?' µg/m³':''}</strong><br>${band.label}<br>Reading time: ${fmtTime(src.ts)}<br>`
            : 'No current reading<br>') +
          `Source: <a href="${heatMode==='psi'?PSI_URL:PM25_URL}" target="_blank" rel="noopener">NEA ${heatMode==='psi'?'PSI':'PM2.5'} API</a><br>` +
          `<em>Boundary shown is a computed Voronoi partition of NEA's single reference point for this region — not an NEA-published shape.</em>`
        );
      }
    }).addTo(map);
  }

  regionMarkers.forEach(m => map.removeLayer(m));
  regionMarkers = [];
  if(!src) return;

  REGIONS.forEach(r=>{
    const coord = regionCoords[r];
    if(!coord) return;
    const val = src.byRegion[r];
    if(typeof val !== 'number') return;
    const marker = L.circleMarker(coord, {
      radius:5, color:'#fff', weight:1.5, fillColor:'#15181c', fillOpacity:1
    }).addTo(map);
    marker.bindPopup(
      `<strong>${r.charAt(0).toUpperCase()+r.slice(1)} — exact NEA reading point</strong><br>` +
      `${heatMode==='psi'?'PSI (24-hr)':'PM2.5 (1-hr)'}: <strong>${val}${heatMode==='pm25'?' µg/m³':''}</strong><br>` +
      `Reading time: ${fmtTime(src.ts)}<br>` +
      `Source: <a href="${heatMode==='psi'?PSI_URL:PM25_URL}" target="_blank" rel="noopener">NEA ${heatMode==='psi'?'PSI':'PM2.5'} API</a>`
    );
    regionMarkers.push(marker);
  });
}

function setHeatMode(mode){
  heatMode = mode;
  document.querySelectorAll('.heat-toggle button').forEach(b=>b.classList.toggle('active', b.dataset.mode===mode));
  updateHeatmap();
}

/* ============== Historical charts ============== */
let psiChart, pm25Chart;

function sgtDateString(daysAgo){
  // Compute a YYYY-MM-DD date string for "today - daysAgo" in SGT, independent of viewer's local timezone.
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
  const res = await fetch(`${PSI_URL}?date=${dateStr}`);
  if(!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  return (json.items||[]).map(item=>{
    const vals = REGIONS.map(r=>item.readings.psi_twenty_four_hourly[r]).filter(v=>typeof v==='number');
    const avg = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
    return {t:item.timestamp, v: avg!==null?Math.round(avg*10)/10:null};
  });
}
async function fetchDayPM25(dateStr){
  const res = await fetch(`${PM25_URL}?date=${dateStr}`);
  if(!res.ok) throw new Error('HTTP ' + res.status);
  const json = await res.json();
  if(json.code !== 0) throw new Error(json.errorMsg || 'API error');
  return (json.data.items||[]).map(item=>{
    const vals = REGIONS.map(r=>item.readings.pm25_one_hourly[r]).filter(v=>typeof v==='number');
    const avg = vals.length ? vals.reduce((a,b)=>a+b,0)/vals.length : null;
    return {t:item.timestamp, v: avg!==null?Math.round(avg*10)/10:null};
  });
}

function shortLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString('en-SG',{timeZone:'Asia/Singapore', month:'short', day:'2-digit', hour:'2-digit'});
}

async function loadHistory(){
  const statusEl = document.getElementById('history-status');
  statusEl.textContent = `Loading last ${HISTORY_DAYS} days…`;

  const dateStrs = Array.from({length:HISTORY_DAYS}, (_,i)=>sgtDateString(HISTORY_DAYS-1-i)); // oldest -> newest

  const failedPSIDays = [];
  const failedPM25Days = [];
  let psiPoints = [];
  let pm25Points = [];

  for(const d of dateStrs){
    try{ psiPoints = psiPoints.concat(await fetchDayPSI(d)); }
    catch(e){ failedPSIDays.push(d); }
    try{ pm25Points = pm25Points.concat(await fetchDayPM25(d)); }
    catch(e){ failedPM25Days.push(d); }
  }

  psiPoints.sort((a,b)=> new Date(a.t) - new Date(b.t));
  pm25Points.sort((a,b)=> new Date(a.t) - new Date(b.t));

  renderHistChart('psi-chart', psiPoints, 'PSI (24-hr, 5-region average)', '#d4a843');
  renderHistChart('pm25-chart', pm25Points, 'PM2.5 (1-hr, 5-region average, µg/m³)', '#e07a3f');

  let status = `Loaded ${psiPoints.length} PSI points and ${pm25Points.length} PM2.5 points over ${HISTORY_DAYS} days, direct from NEA's API (same source as the live panel).`;
  if(failedPSIDays.length) status += ` PSI missing for: ${failedPSIDays.join(', ')} (not interpolated — shown as a gap).`;
  if(failedPM25Days.length) status += ` PM2.5 missing for: ${failedPM25Days.join(', ')} (not interpolated — shown as a gap).`;
  statusEl.textContent = status;
}

function renderHistChart(canvasId, points, label, color){
  const ctx = document.getElementById(canvasId).getContext('2d');
  const labels = points.map(p=>shortLabel(p.t));
  const data = points.map(p=>p.v);
  const existing = canvasId === 'psi-chart' ? psiChart : pm25Chart;
  if(existing) existing.destroy();

  const chart = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{
      label, data, borderColor: color, backgroundColor: color+'33',
      borderWidth:1.5, pointRadius:0, fill:true, tension:0.15, spanGaps:false
    }]},
    options:{
      responsive:true, maintainAspectRatio:false,
      animation:false,
      scales:{
        x:{ ticks:{ color:'#6b7280', maxTicksLimit:10, autoSkip:true }, grid:{ color:'#262b33' } },
        y:{ ticks:{ color:'#6b7280' }, grid:{ color:'#262b33' }, beginAtZero:true }
      },
      plugins:{ legend:{ labels:{ color:'#9aa3af' } } }
    }
  });
  if(canvasId==='psi-chart') psiChart = chart; else pm25Chart = chart;
}

/* ============== Init ============== */
function refreshLive(){ loadPSI(); loadPM25(); }

document.addEventListener('DOMContentLoaded', ()=>{
  tickClock();
  setInterval(tickClock, 1000);

  initMap();
  refreshLive();
  setInterval(refreshLive, 5 * 60 * 1000);

  loadHistory();

  document.querySelectorAll('.heat-toggle button').forEach(b=>{
    b.addEventListener('click', ()=>setHeatMode(b.dataset.mode));
  });
});
