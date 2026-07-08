/* =========================================================================
   ORBIT backend — real-time world events + country/state drill-down + Groq.

   Endpoints:
     GET  /api/health
     GET  /api/events                 -> live events (USGS + GDELT), region-tagged
     GET  /api/geo/countries          -> world country boundaries (GeoJSON)
     GET  /api/geo/states/:iso        -> states/provinces for one country (GeoJSON)
     POST /api/brief                  -> Groq-written impact brief for one event
     (everything in /public is served as the frontend)

   The Groq API key lives ONLY here on the server. The browser never sees it.
   ========================================================================= */

require('dotenv').config();
const express = require('express');
const path = require('path');
const Parser = require('rss-parser');
const rss = new Parser({ timeout: 9000, headers: { 'User-Agent': 'ORBIT-NewsGlobe/1.0' } });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

/* ---------------- boundary data (loaded once, cached) ---------------- */
const COUNTRIES_URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson';
const STATES_50M    = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces.geojson';   // ~2MB, ~9 big countries
const STATES_10M    = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson';  // ~41MB, full global coverage

let COUNTRIES = null;        // GeoJSON FeatureCollection
let STATES_BY_ISO = {};      // iso_a2 -> [features]
let fullStatesReady = false; // true once 10m global coverage has loaded

function indexStates(fc) {
  const map = {};
  for (const f of fc.features) {
    const iso = (f.properties.iso_a2 || f.properties.ISO_A2 || '').toUpperCase();
    if (!iso || iso === '-99') continue;
    (map[iso] ||= []).push(f);
  }
  return map;
}

async function loadBoundaries() {
  // The globe only needs country outlines (for the coastline fallback) + centroids (for geocoding).
  try {
    COUNTRIES = await fetch(COUNTRIES_URL).then(r => r.json());
    console.log(`✓ boundaries: ${COUNTRIES.features.length} countries loaded`);
  } catch (e) {
    console.warn('⚠ could not load country boundaries:', e.message);
  }
  // Optional: full state/province coverage (large, ~41MB). Only if you actually need state data.
  if (!process.env.FULL_STATES) return;
  fetch(STATES_10M).then(r => r.json()).then(s => {
    STATES_BY_ISO = indexStates(s); fullStatesReady = true;
    console.log(`✓ full state coverage ready: ${s.features.length} states`);
  }).catch(e => console.warn('⚠ full state load failed:', e.message));
}

/* ---------------- point-in-polygon (ray casting, no deps) ---------------- */
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pointInPoly(x, y, rings) {
  if (!pointInRing(x, y, rings[0])) return false;
  for (let k = 1; k < rings.length; k++) if (pointInRing(x, y, rings[k])) return false; // holes
  return true;
}
function pointInGeom(x, y, geom) {
  if (!geom) return false;
  if (geom.type === 'Polygon') return pointInPoly(x, y, geom.coordinates);
  if (geom.type === 'MultiPolygon') return geom.coordinates.some(p => pointInPoly(x, y, p));
  return false;
}
function findCountry(lon, lat) {
  if (!COUNTRIES) return null;
  for (const f of COUNTRIES.features) {
    if (pointInGeom(lon, lat, f.geometry)) {
      const p = f.properties;
      return { iso: (p.ISO_A2 || p.iso_a2 || '').toUpperCase(), name: p.ADMIN || p.NAME || p.name || 'Unknown' };
    }
  }
  return null;
}
function findState(lon, lat, iso) {
  const list = STATES_BY_ISO[iso];
  if (!list) return null;
  for (const f of list) {
    if (pointInGeom(lon, lat, f.geometry)) return f.properties.name || f.properties.name_en || null;
  }
  return null;
}
function tagRegion(ev) {
  const c = findCountry(ev.lon, ev.lat);
  if (c) { ev.countryIso = c.iso; ev.countryName = c.name; ev.state = findState(ev.lon, ev.lat, c.iso); }
  return ev;
}

/* ---------------- live data sources ---------------- */
const ago = ms => { const s = (Date.now() - ms) / 1000;
  if (s < 60) return Math.max(0, Math.floor(s)) + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago'; };
const magToSev = m => m >= 6 ? 5 : m >= 5.5 ? 4 : m >= 5 ? 3 : m >= 4.5 ? 2 : 1;

async function fetchUSGS() {
  const r = await fetch('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson');
  if (!r.ok) throw new Error('USGS ' + r.status);
  const j = await r.json();
  return j.features.map(f => {
    const p = f.properties, g = f.geometry.coordinates, m = p.mag || 0;
    return {
      id: 'q' + (p.code || f.id), source: 'usgs', cat: 'disaster',
      sev: p.tsunami ? 5 : magToSev(m), live: (Date.now() - p.time) < 86400000,
      title: p.title || ('M ' + m.toFixed(1)), place: p.place || 'Offshore',
      lat: g[1], lon: g[0], time: p.time, updated: ago(p.time),
      mag: m, depth: g[2], alert: p.alert, tsunami: p.tsunami, felt: p.felt, sig: p.sig, url: p.url,
    };
  });
}

// ===== Real news outlets via RSS (free, no key). Dead/blocked feeds are skipped automatically. =====
// NOTE: these are the news *websites* behind the TV channels. Live TV video is not ingestible here.
const NEWS_FEEDS = [
  // ---- International ----
  { outlet:'BBC',            cat:'news',        url:'http://feeds.bbci.co.uk/news/world/rss.xml' },
  { outlet:'CNN',            cat:'news',        url:'http://rss.cnn.com/rss/edition_world.rss' },
  { outlet:'Al Jazeera',     cat:'conflict',    url:'https://www.aljazeera.com/xml/rss/all.xml' },
  { outlet:'France 24',      cat:'news',        url:'https://www.france24.com/en/rss' },
  { outlet:'Sky News',       cat:'news',        url:'https://feeds.skynews.com/feeds/rss/world.xml' },
  { outlet:'Euronews',       cat:'news',        url:'https://www.euronews.com/rss?level=theme&name=news' },
  { outlet:'DW',             cat:'news',        url:'https://rss.dw.com/rdf/rss-en-all' },
  { outlet:'CNA',            cat:'news',        url:'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml' },
  { outlet:'ABC (AU)',       cat:'news',        url:'https://www.abc.net.au/news/feed/45910/rss.xml' },
  { outlet:'CBC',            cat:'news',        url:'https://www.cbc.ca/webfeed/rss/rss-world' },
  { outlet:'Al Arabiya',     cat:'news',        url:'https://english.alarabiya.net/.mrss/en.xml' },
  { outlet:'The Guardian',   cat:'news',        url:'https://www.theguardian.com/world/rss' },
  // ---- United States ----
  { outlet:'Fox News',       cat:'news',        url:'https://moxie.foxnews.com/google-publisher/world.xml' },
  { outlet:'NBC News',       cat:'news',        url:'http://feeds.nbcnews.com/nbcnews/public/news' },
  { outlet:'CBS News',       cat:'news',        url:'https://www.cbsnews.com/latest/rss/world' },
  { outlet:'NPR',            cat:'news',        url:'https://feeds.npr.org/1001/rss.xml' },
  { outlet:'PBS NewsHour',   cat:'news',        url:'https://www.pbs.org/newshour/feeds/rss/headlines' },
  { outlet:'CNBC',           cat:'markets',     url:'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362' },
  // ---- United Kingdom / Europe ----
  { outlet:'ITV News',       cat:'news',        url:'https://www.itv.com/news/index.rss' },
  { outlet:'BBC Tech',       cat:'tech',        url:'http://feeds.bbci.co.uk/news/technology/rss.xml' },
  { outlet:'BBC Business',   cat:'markets',     url:'http://feeds.bbci.co.uk/news/business/rss.xml' },
  // ---- Middle East ----
  { outlet:'Press TV',       cat:'conflict',    url:'https://www.presstv.ir/rss.xml' },
  // ---- India ----
  { outlet:'TOI',            cat:'news',        url:'https://timesofindia.indiatimes.com/rssfeedstopstories.cms' },
  { outlet:'TOI India',      cat:'news',        url:'https://timesofindia.indiatimes.com/rssfeeds/-2128936835.cms' },
  { outlet:'TOI World',      cat:'news',        url:'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms' },
  { outlet:'TOI Business',   cat:'markets',     url:'https://timesofindia.indiatimes.com/rssfeeds/1898055.cms' },
  { outlet:'TOI Sports',     cat:'sports'    , url:'https://timesofindia.indiatimes.com/rssfeeds/4719148.cms' },
  { outlet:'The Hindu',      cat:'news',        url:'https://www.thehindu.com/news/national/feeder/default.rss' },
  { outlet:'The Hindu World',cat:'news',        url:'https://www.thehindu.com/news/international/feeder/default.rss' },
  { outlet:'NDTV',           cat:'news',        url:'https://feeds.feedburner.com/ndtvnews-top-stories' },
  { outlet:'NDTV India',     cat:'news',        url:'https://feeds.feedburner.com/ndtvnews-india-news' },
  { outlet:'NDTV World',     cat:'news',        url:'https://feeds.feedburner.com/ndtvnews-world-news' },
  { outlet:'India Today',    cat:'news',        url:'https://www.indiatoday.in/rss/1206578' },
  { outlet:'News18 India',   cat:'news',        url:'https://www.news18.com/rss/india.xml' },
  { outlet:'News18 World',   cat:'news',        url:'https://www.news18.com/rss/world.xml' },
  { outlet:'India TV',       cat:'news',        url:'https://www.indiatvnews.com/rssnews/topstory.xml' },
  { outlet:'Zee News',       cat:'news',        url:'https://zeenews.india.com/rss/india-national-news.xml' },
  { outlet:'Zee World',      cat:'news',        url:'https://zeenews.india.com/rss/world-news.xml' },
  { outlet:'Hindustan Times',cat:'news',        url:'https://www.hindustantimes.com/feeds/rss/india-news/rssfeed.xml' },
  { outlet:'HT World',       cat:'news',        url:'https://www.hindustantimes.com/feeds/rss/world-news/rssfeed.xml' },
  { outlet:'Indian Express', cat:'news',        url:'https://indianexpress.com/section/india/feed/' },
  { outlet:'Firstpost',      cat:'news',        url:'https://www.firstpost.com/rss/world.xml' },
  { outlet:'Firstpost India',cat:'news',        url:'https://www.firstpost.com/rss/india.xml' },
  { outlet:'Economic Times', cat:'markets',     url:'https://economictimes.indiatimes.com/rssfeedstopstories.cms' },
  { outlet:'Mint',           cat:'markets',     url:'https://www.livemint.com/rss/news' },
  { outlet:'Business Std',   cat:'markets',     url:'https://www.business-standard.com/rss/home_page_top_stories.rss' },
  { outlet:'The Print',      cat:'news',        url:'https://theprint.in/feed/' },
  // ---- Sports ----
  { outlet:'BBC Sport',      cat:'sports'    , url:'http://feeds.bbci.co.uk/sport/rss.xml' },
  { outlet:'ESPN',           cat:'sports'    , url:'https://www.espn.com/espn/rss/news' },
  { outlet:'ESPNcricinfo',   cat:'sports'    , url:'https://www.espncricinfo.com/rss/content/story/feeds/0.xml' },
  { outlet:'Sky Sports',     cat:'sports'    , url:'https://www.skysports.com/rss/12040' },
  { outlet:'Guardian Sport', cat:'sports'    , url:'https://www.theguardian.com/sport/rss' },
  { outlet:'TOI Cricket',    cat:'sports'    , url:'https://timesofindia.indiatimes.com/rssfeeds/54829575.cms' },
  { outlet:'NDTV Sports',    cat:'sports'    , url:'https://feeds.feedburner.com/ndtvsports-latest' },
  { outlet:'HT Sports',      cat:'sports'    , url:'https://www.hindustantimes.com/feeds/rss/sports/rssfeed.xml' },
  { outlet:'IE Sports',      cat:'sports'    , url:'https://indianexpress.com/section/sports/feed/' },
  { outlet:'Guardian FB',    cat:'sports'    , url:'https://www.theguardian.com/football/rss' },
  // ---- more countries ----
  { outlet:'NYT',            cat:'news',        url:'https://rss.nytimes.com/services/xml/rss/nyt/World.xml' },
  { outlet:'Japan Times',    cat:'news',        url:'https://www.japantimes.co.jp/feed/' },
  { outlet:'Straits Times',  cat:'news',        url:'https://www.straitstimes.com/news/world/rss.xml' },
  { outlet:'Deccan Herald',  cat:'news',        url:'https://www.deccanherald.com/rss/top-stories.rss' },
];

function classify(t) {
  const s = (t || '').toLowerCase();
  if (/cricket|football|soccer|\bmatch\b|tournament|olympic|fifa|\bipl\b|world cup|\bnba\b|\bnfl\b|tennis|formula|\bf1\b|wicket|league|athlet/.test(s)) return 'sports';
  if (/festival|film|movie|music|concert|celebrity|bollywood|hollywood|\bawards?\b|box office|entertainment|fashion|trailer/.test(s)) return 'culture';
  if (/health|covid|virus|outbreak|vaccine|hospital|disease|medical|cancer|mental health|dengue|malaria|flu\b/.test(s)) return 'health';
  if (/flood|storm|cyclone|hurricane|typhoon|wildfire|heat ?wave|drought|tornado|monsoon/.test(s)) return 'weather';
  if (/quake|earthquake|tsunami|landslide|eruption|volcano|blast|explosion|crash|collapse|evacuat/.test(s)) return 'disaster';
  if (/protest|strike|\bwar\b|clash|attack|terror|election|sanction|border|military|coup|ceasefire|missile|troops|diplomac/.test(s)) return 'conflict';
  if (/stock|sensex|nifty|market|inflation|\bgdp\b|economy|rupee|dollar|\btrade\b|tariff|earnings|\bipo\b|rate cut|\bbank\b/.test(s)) return 'markets';
  if (/\bai\b|artificial intelligence|chip|semiconductor|\btech\b|cyber|software|startup|smartphone|google|apple|microsoft|gadget/.test(s)) return 'tech';
  return 'news';
}

/* ---- geolocation: place a headline on the globe by names it mentions ---- */
let GAZ = null;
const CITY_COORDS = {
  // --- India: major cities ---
  'new delhi':[28.61,77.21,'New Delhi'],'delhi':[28.61,77.21,'Delhi'],'mumbai':[19.08,72.88,'Mumbai'],
  'bengaluru':[12.97,77.59,'Bengaluru'],'bangalore':[12.97,77.59,'Bengaluru'],'chennai':[13.08,80.27,'Chennai'],
  'kolkata':[22.57,88.36,'Kolkata'],'hyderabad':[17.39,78.49,'Hyderabad'],'pune':[18.52,73.86,'Pune'],
  'ahmedabad':[23.03,72.58,'Ahmedabad'],'jaipur':[26.91,75.79,'Jaipur'],'lucknow':[26.85,80.95,'Lucknow'],
  'nagpur':[21.15,79.09,'Nagpur'],'indore':[22.72,75.86,'Indore'],'bhopal':[23.26,77.41,'Bhopal'],
  'patna':[25.59,85.14,'Patna'],'kanpur':[26.45,80.33,'Kanpur'],'surat':[21.17,72.83,'Surat'],
  'vadodara':[22.31,73.18,'Vadodara'],'visakhapatnam':[17.69,83.22,'Visakhapatnam'],'vizag':[17.69,83.22,'Visakhapatnam'],
  'kochi':[9.93,76.27,'Kochi'],'coimbatore':[11.02,76.96,'Coimbatore'],'madurai':[9.93,78.12,'Madurai'],
  'varanasi':[25.32,82.97,'Varanasi'],'agra':[27.18,78.01,'Agra'],'amritsar':[31.63,74.87,'Amritsar'],
  'ranchi':[23.34,85.31,'Ranchi'],'raipur':[21.25,81.63,'Raipur'],'guwahati':[26.14,91.74,'Guwahati'],
  'srinagar':[34.08,74.80,'Srinagar'],'jammu':[32.73,74.87,'Jammu'],'chandigarh':[30.73,76.78,'Chandigarh'],
  'dehradun':[30.32,78.03,'Dehradun'],'thiruvananthapuram':[8.52,76.94,'Thiruvananthapuram'],
  'mysuru':[12.30,76.64,'Mysuru'],'nashik':[19.99,73.79,'Nashik'],'rajkot':[22.30,70.80,'Rajkot'],
  'gurugram':[28.46,77.03,'Gurugram'],'gurgaon':[28.46,77.03,'Gurugram'],'noida':[28.54,77.39,'Noida'],
  'prayagraj':[25.44,81.85,'Prayagraj'],'allahabad':[25.44,81.85,'Prayagraj'],'vijayawada':[16.51,80.65,'Vijayawada'],
  'jamshedpur':[22.80,86.20,'Jamshedpur'],'bhubaneswar':[20.30,85.82,'Bhubaneswar'],'goa':[15.30,74.12,'Goa'],
  // --- India: states/UTs ---
  'kerala':[10.85,76.27,'Kerala'],'gujarat':[22.26,71.19,'Gujarat'],'punjab':[31.15,75.34,'Punjab'],
  'kashmir':[34.08,74.80,'Jammu & Kashmir'],'bihar':[25.10,85.31,'Bihar'],'assam':[26.20,92.94,'Assam'],
  'tamil nadu':[11.13,78.66,'Tamil Nadu'],'karnataka':[15.32,75.71,'Karnataka'],'telangana':[17.99,79.59,'Telangana'],
  'andhra pradesh':[15.91,79.74,'Andhra Pradesh'],'west bengal':[22.99,87.85,'West Bengal'],'odisha':[20.95,85.10,'Odisha'],
  'rajasthan':[27.02,74.22,'Rajasthan'],'madhya pradesh':[23.47,77.95,'Madhya Pradesh'],'uttar pradesh':[26.85,80.95,'Uttar Pradesh'],
  'uttarakhand':[30.07,79.09,'Uttarakhand'],'haryana':[29.06,76.09,'Haryana'],'himachal':[31.10,77.17,'Himachal Pradesh'],
  'jharkhand':[23.61,85.28,'Jharkhand'],'chhattisgarh':[21.28,81.87,'Chhattisgarh'],'maharashtra':[19.75,75.71,'Maharashtra'],
  'manipur':[24.66,93.91,'Manipur'],'meghalaya':[25.47,91.37,'Meghalaya'],'nagaland':[26.16,94.56,'Nagaland'],
  'tripura':[23.94,91.99,'Tripura'],'sikkim':[27.53,88.51,'Sikkim'],'arunachal':[28.22,94.73,'Arunachal Pradesh'],
  // --- World cities ---
  'london':[51.51,-0.13,'London'],'new york':[40.71,-74.0,'New York'],'washington':[38.9,-77.03,'Washington'],
  'chicago':[41.88,-87.63,'Chicago'],'los angeles':[34.05,-118.24,'Los Angeles'],'san francisco':[37.77,-122.42,'San Francisco'],
  'paris':[48.85,2.35,'Paris'],'berlin':[52.52,13.40,'Berlin'],'rome':[41.90,12.50,'Rome'],'madrid':[40.42,-3.70,'Madrid'],
  'brussels':[50.85,4.35,'Brussels'],'geneva':[46.20,6.14,'Geneva'],'moscow':[55.75,37.62,'Moscow'],
  'kyiv':[50.45,30.52,'Kyiv'],'kiev':[50.45,30.52,'Kyiv'],'istanbul':[41.01,28.98,'Istanbul'],'ankara':[39.93,32.86,'Ankara'],
  'beijing':[39.90,116.40,'Beijing'],'shanghai':[31.23,121.47,'Shanghai'],'hong kong':[22.32,114.17,'Hong Kong'],
  'tokyo':[35.68,139.69,'Tokyo'],'seoul':[37.57,126.98,'Seoul'],'taipei':[25.03,121.57,'Taipei'],
  'jakarta':[-6.21,106.85,'Jakarta'],'bangkok':[13.76,100.50,'Bangkok'],'manila':[14.60,120.98,'Manila'],
  'kuala lumpur':[3.14,101.69,'Kuala Lumpur'],'singapore':[1.35,103.82,'Singapore'],'sydney':[-33.87,151.21,'Sydney'],
  'melbourne':[-37.81,144.96,'Melbourne'],'toronto':[43.65,-79.38,'Toronto'],'ottawa':[45.42,-75.70,'Ottawa'],
  'beirut':[33.89,35.50,'Beirut'],'gaza':[31.50,34.47,'Gaza'],'jerusalem':[31.78,35.22,'Jerusalem'],'tel aviv':[32.08,34.78,'Tel Aviv'],
  'tehran':[35.69,51.39,'Tehran'],'baghdad':[33.31,44.36,'Baghdad'],'riyadh':[24.71,46.68,'Riyadh'],'doha':[25.29,51.53,'Doha'],
  'dubai':[25.20,55.27,'Dubai'],'abu dhabi':[24.45,54.38,'Abu Dhabi'],'cairo':[30.04,31.24,'Cairo'],'kabul':[34.56,69.21,'Kabul'],
  'islamabad':[33.69,73.06,'Islamabad'],'karachi':[24.86,67.01,'Karachi'],'lahore':[31.55,74.34,'Lahore'],
  'dhaka':[23.81,90.41,'Dhaka'],'colombo':[6.93,79.86,'Colombo'],'kathmandu':[27.72,85.32,'Kathmandu'],
  'johannesburg':[-26.20,28.05,'Johannesburg'],'nairobi':[-1.29,36.82,'Nairobi'],'lagos':[6.52,3.38,'Lagos'],
  'sao paulo':[-23.55,-46.63,'Sao Paulo'],'rio':[-22.91,-43.17,'Rio de Janeiro'],'buenos aires':[-34.60,-58.38,'Buenos Aires'],
  'mexico city':[19.43,-99.13,'Mexico City'],'bogota':[4.71,-74.07,'Bogota'],
};
const COUNTRY_ALIASES = {
  'united states':'United States of America','u.s.':'United States of America','usa':'United States of America',
  'america':'United States of America','uk':'United Kingdom','britain':'United Kingdom','u.k.':'United Kingdom',
  'uae':'United Arab Emirates','south korea':'South Korea','north korea':'North Korea',
};
const reEsc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function buildGazetteer() {
  const arr = [];
  for (const k in CITY_COORDS) { const c = CITY_COORDS[k]; arr.push({ re:new RegExp('\\b'+reEsc(k)+'\\b','i'), lat:c[0], lon:c[1], name:c[2] }); }
  if (COUNTRIES) {
    for (const f of COUNTRIES.features) {
      const p = f.properties, lat = p.LABEL_Y, lon = p.LABEL_X, name = p.ADMIN || p.NAME;
      if (lat == null || lon == null || !name) continue;
      new Set([name, p.NAME_LONG, p.BRK_NAME].filter(Boolean)).forEach(n =>
        arr.push({ re:new RegExp('\\b'+reEsc(n)+'\\b','i'), lat, lon, name }));
    }
    for (const a in COUNTRY_ALIASES) {
      const f = COUNTRIES.features.find(x => (x.properties.ADMIN||x.properties.NAME) === COUNTRY_ALIASES[a]);
      if (f) arr.push({ re:new RegExp('\\b'+reEsc(a)+'\\b','i'), lat:f.properties.LABEL_Y, lon:f.properties.LABEL_X, name:COUNTRY_ALIASES[a] });
    }
  }
  GAZ = arr;
  // resolve each city's country once (cheap, one-time) so news can be grouped by country
  for (const g of GAZ) {
    if (g.country) continue;
    const c = findCountry(g.lon, g.lat);
    g.country = c ? c.name : g.name;
  }
}
function geocode(text) {
  if (!GAZ) buildGazetteer();
  for (const g of (GAZ || [])) if (g.re.test(text)) return { lat:g.lat, lon:g.lon, name:g.name, country:g.country };
  return null;
}

const hash = s => { let h = 5381; for (let i=0;i<s.length;i++) h = ((h<<5)+h+s.charCodeAt(i))|0; return (h>>>0).toString(36); };

async function fetchFeed(f) {
  const feed = await rss.parseURL(f.url);
  return (feed.items || []).slice(0, 25).map(it => {
    const tRaw = it.isoDate || it.pubDate;
    let time = tRaw ? Date.parse(tRaw) : Date.now(); if (isNaN(time)) time = Date.now();
    const summary = (it.contentSnippet || it.summary || '').replace(/\s+/g, ' ').trim().slice(0, 280);
    const cat = (f.cat === 'news') ? classify((it.title||'') + ' ' + summary) : f.cat;
    const geo = geocode((it.title||'') + ' ' + summary);
    return {
      id: 'r' + hash((it.link || it.title || '') + f.outlet), source: 'rss', outlet: f.outlet, cat,
      sev: (cat==='disaster'||cat==='conflict') ? 3 : (cat==='weather') ? 3 : 2,
      live: (Date.now() - time) < 8*3600000,
      title: (it.title || 'Untitled').trim(),
      place: geo ? geo.name : '', country: geo ? geo.country : '',
      lat: geo ? geo.lat : null, lon: geo ? geo.lon : null,
      time, updated: ago(time), summary, url: it.link,
      articles: [{ title: (it.title||'').trim(), url: it.link, domain: f.outlet }],
    };
  });
}

async function fetchNews() {
  const res = await Promise.allSettled(NEWS_FEEDS.map(fetchFeed));
  let all = [];
  for (const r of res) if (r.status === 'fulfilled') all = all.concat(r.value);
  // de-dupe by normalized title, newest first
  const seen = new Set(), dedup = [];
  for (const e of all.sort((a,b) => b.time - a.time)) {
    const key = (e.title||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().slice(0, 70);
    if (!key || seen.has(key)) continue; seen.add(key); dedup.push(e);
  }
  // keep every category represented (so Sports/Health/etc. never get starved by a global cut)
  const perCat = {}, out = [];
  for (const e of dedup) {
    perCat[e.cat] = (perCat[e.cat] || 0);
    if (perCat[e.cat] >= 140) continue;
    perCat[e.cat]++; out.push(e);
    if (out.length >= 600) break;
  }
  return out.sort((a,b) => b.time - a.time);
}

/* events cache (refresh at most once a minute) */
let eventsCache = { at: 0, data: [] };
async function getEvents() {
  if (Date.now() - eventsCache.at < 60000 && eventsCache.data.length) return eventsCache.data;
  const results = await Promise.allSettled([fetchUSGS(), fetchNews()]);
  let events = [];
  for (const r of results) if (r.status === 'fulfilled') events = events.concat(r.value);
  if (!events.length) throw new Error('all live feeds failed');
  events.sort((a, b) => b.time - a.time);
  eventsCache = { at: Date.now(), data: events };
  return events;
}

/* ---------------- Groq brief ---------------- */
const briefCache = new Map(); // event id -> brief json
async function groqBrief(ev) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY not set on the server');
  if (briefCache.has(ev.id)) return briefCache.get(ev.id);

  const facts = {
    title: ev.title, category: ev.cat, place: ev.place,
    country: ev.countryName, state: ev.state,
    outlet: ev.outlet, headline_summary: ev.summary,
    magnitude: ev.mag, depth_km: ev.depth, tsunami: ev.tsunami, significance: ev.sig,
    article_count: ev.count, when: ev.updated, source: ev.source,
  };
  const body = {
    model: GROQ_MODEL,
    temperature: 0.4,
    max_completion_tokens: 500,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content:
        'You are a careful newsroom analyst. Given a factual event record, write a brief. ' +
        'Respond ONLY with a JSON object: {"summary": string (2-3 sentences), "why_it_matters": string (1-2 sentences), ' +
        '"affected": string[] (3-5 short items), "confidence": number (0-100)}. ' +
        'Be neutral and factual. Do not invent specifics that are not implied by the data. ' +
        'If the record is thin, say so and lower the confidence.' },
      { role: 'user', content: 'Event record:\n' + JSON.stringify(facts, null, 2) },
    ],
  };
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + GROQ_API_KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Groq ' + r.status + ' ' + txt.slice(0, 200));
  }
  const j = await r.json();
  let parsed;
  try { parsed = JSON.parse(j.choices[0].message.content); }
  catch { parsed = { summary: j.choices?.[0]?.message?.content || 'No content.', why_it_matters: '', affected: [], confidence: 50 }; }
  briefCache.set(ev.id, parsed);
  return parsed;
}

/* ---------------- routes ---------------- */
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, groq: !!GROQ_API_KEY, model: GROQ_MODEL,
    boundaries: !!COUNTRIES, fullStates: fullStatesReady,
    statesCountries: Object.keys(STATES_BY_ISO).length }));

app.get('/api/events', async (_req, res) => {
  try { res.json({ events: await getEvents(), generated: Date.now() }); }
  catch (e) { res.status(502).json({ error: 'live data unavailable', detail: e.message }); }
});

app.get('/api/geo/countries', (_req, res) => {
  if (!COUNTRIES) return res.status(503).json({ error: 'boundaries not loaded' });
  res.json(COUNTRIES);
});

app.get('/api/geo/states/:iso', (req, res) => {
  const iso = (req.params.iso || '').toUpperCase();
  const list = STATES_BY_ISO[iso];
  if (!list) return res.json({ type: 'FeatureCollection', features: [] });
  res.json({ type: 'FeatureCollection', features: list });
});

app.post('/api/brief', async (req, res) => {
  const ev = req.body && req.body.event;
  if (!ev || !ev.id) return res.status(400).json({ error: 'missing event' });
  try { res.json(await groqBrief(ev)); }
  catch (e) { res.status(502).json({ error: 'brief failed', detail: e.message }); }
});

/* ---------------- start ---------------- */
loadBoundaries().finally(() => {
  app.listen(PORT, () => {
    console.log(`\n  ORBIT running →  http://localhost:${PORT}`);
    console.log(`  Groq key:    ${GROQ_API_KEY ? 'set ✓' : 'MISSING ✗  (set GROQ_API_KEY in .env)'}`);
    console.log(`  Groq model:  ${GROQ_MODEL}\n`);
  });
});
