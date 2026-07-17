require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SETLIST_API_KEY;

// In-memory cache
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.time > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  return item.data;
}
function setCache(key, data) {
  cache.set(key, { data, time: Date.now() });
}

// Rate limit: 600ms between requests
let lastRequest = 0;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function apiRequest(endpoint, retries = 3) {
  const cacheKey = endpoint;
  const cached = getCache(cacheKey);
  if (cached) {
    console.log(`[CACHE] ${endpoint}`);
    return cached;
  }

  const now = Date.now();
  const wait = Math.max(0, 600 - (now - lastRequest));
  await sleep(wait);
  lastRequest = Date.now();

  const url = `https://api.setlist.fm/rest/1.0${endpoint}`;

  try {
    const res = await axios.get(url, {
      headers: {
        'Accept': 'application/json',
        'x-api-key': API_KEY
      },
      timeout: 15000 // 15 second timeout
    });

    setCache(cacheKey, res.data);
    return res.data;
  } catch (err) {
    if (retries > 0 && (err.response?.status === 429 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT')) {
      console.log(`[RETRY] ${endpoint} — ${err.message}, retries left: ${retries}`);
      await sleep(2000);
      return apiRequest(endpoint, retries - 1);
    }
    throw err;
  }
}

app.use(express.static(path.join(__dirname, 'public')));

// Search artist by name
app.get('/api/search-artist', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ error: 'Name required' });

    const data = await apiRequest(`/search/artists?artistName=${encodeURIComponent(name)}&p=1&sort=relevance`);

    // FIX: Handle both possible response structures
    const artists = data.artist || data.artists?.artist || [];
    if (!artists.length) return res.status(404).json({ error: 'Artist not found' });

    const artist = artists[0];
    res.json({ mbid: artist.mbid, name: artist.name });
  } catch (err) {
    console.error('Search artist error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get all unique tours for an artist
app.get('/api/tours', async (req, res) => {
  try {
    const { mbid } = req.query;
    if (!mbid) return res.status(400).json({ error: 'MBID required' });

    const allSetlists = [];
    let page = 1;
    let totalPages = 1;
    const MAX_PAGES = 25; // Reduced from 50 — recent tours are in recent setlists

    do {
      console.log(`[TOURS] Fetching page ${page} for ${mbid}...`);
      const data = await apiRequest(`/artist/${mbid}/setlists?p=${page}`);

      // FIX: Handle multiple possible response structures
      const setlists = data.setlist || data.setlists?.setlist || [];
      if (Array.isArray(setlists) && setlists.length > 0) {
        allSetlists.push(...setlists);
      }

      // FIX: Safer pagination calculation
      const total = parseInt(data.total) || 0;
      const perPage = parseInt(data.itemsPerPage) || 20;
      totalPages = total > 0 ? Math.ceil(total / perPage) : 1;

      console.log(`[TOURS] Page ${page}: got ${setlists.length} setlists, total=${total}, perPage=${perPage}, totalPages=${totalPages}`);

      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    console.log(`[TOURS] Total setlists collected: ${allSetlists.length}`);

    const tours = [...new Set(allSetlists
      .filter(s => s.tour?.name)
      .map(s => s.tour.name))].sort();

    console.log(`[TOURS] Found ${tours.length} unique tours:`, tours.slice(0, 10));

    res.json({ tours, totalSetlists: allSetlists.length });
  } catch (err) {
    console.error('Tours error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get shows for a specific tour
app.get('/api/tour-shows', async (req, res) => {
  try {
    const { mbid, tour } = req.query;
    if (!mbid || !tour) return res.status(400).json({ error: 'MBID and tour required' });

    const allSetlists = [];
    let page = 1;
    let totalPages = 1;
    const MAX_PAGES = 30;

    do {
      console.log(`[SHOWS] Fetching page ${page} for tour "${tour}"...`);
      const data = await apiRequest(`/artist/${mbid}/setlists?p=${page}`);

      const setlists = data.setlist || data.setlists?.setlist || [];
      if (Array.isArray(setlists) && setlists.length > 0) {
        allSetlists.push(...setlists);
      }

      const total = parseInt(data.total) || 0;
      const perPage = parseInt(data.itemsPerPage) || 20;
      totalPages = total > 0 ? Math.ceil(total / perPage) : 1;

      page++;
    } while (page <= totalPages && page <= MAX_PAGES);

    const filtered = allSetlists.filter(s => {
      if (!s.tour?.name) return false;
      return s.tour.name.toLowerCase() === tour.toLowerCase() || 
             s.tour.name.toLowerCase().includes(tour.toLowerCase());
    });

    const shows = filtered
      .sort((a, b) => {
        const [da, ma, ya] = a.eventDate.split('-');
        const [db, mb, yb] = b.eventDate.split('-');
        return new Date(`${ya}-${ma}-${da}`) - new Date(`${yb}-${mb}-${db}`);
      })
      .map((s, i) => ({
        order: i + 1,
        date: s.eventDate,
        venue: s.venue?.name || 'Unknown Venue',
        city: s.venue?.city?.name || 'Unknown City',
        state: s.venue?.city?.state || s.venue?.city?.stateCode || '',
        country: s.venue?.city?.country?.name || 'Unknown Country',
        coords: s.venue?.city?.coords || null,
        setlistUrl: s.url
      }));

    res.json({ tour, totalShows: shows.length, shows });
  } catch (err) {
    console.error('Tour shows error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});