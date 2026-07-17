require('dotenv').config();
const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.SETLIST_API_KEY;

// In-memory cache
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60 * 6; // 6 hours

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
      timeout: 15000
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

    const artists = data.artist || data.artists?.artist || [];
    if (!artists.length) return res.status(404).json({ error: 'Artist not found' });

    const artist = artists[0];
    res.json({ mbid: artist.mbid, name: artist.name });
  } catch (err) {
    console.error('Search artist error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// SSE stream for fetching ALL tours (no page cap)
app.get('/api/tours-stream', async (req, res) => {
  const { mbid } = req.query;
  if (!mbid) {
    res.status(400).json({ error: 'MBID required' });
    return;
  }

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // First, get page 1 to find total pages
    const firstPage = await apiRequest(`/artist/${mbid}/setlists?p=1`);
    const setlistsFirst = firstPage.setlist || firstPage.setlists?.setlist || [];
    const total = parseInt(firstPage.total) || setlistsFirst.length;
    const perPage = parseInt(firstPage.itemsPerPage) || 20;
    const totalPages = total > 0 ? Math.ceil(total / perPage) : 1;

    const allSetlists = [...setlistsFirst];
    const tours = new Set();

    // Collect tours from page 1
    setlistsFirst.forEach(s => {
      if (s.tour?.name) tours.add(s.tour.name);
    });

    send({
      type: 'progress',
      page: 1,
      totalPages,
      setlistsFound: allSetlists.length,
      toursFound: tours.size,
      tours: [...tours].sort()
    });

    // Fetch remaining pages — NO MAX_PAGES CAP
    for (let page = 2; page <= totalPages; page++) {
      try {
        const data = await apiRequest(`/artist/${mbid}/setlists?p=${page}`);
        const setlists = data.setlist || data.setlists?.setlist || [];

        if (setlists.length === 0) break; // No more data

        allSetlists.push(...setlists);

        setlists.forEach(s => {
          if (s.tour?.name) tours.add(s.tour.name);
        });

        send({
          type: 'progress',
          page,
          totalPages,
          setlistsFound: allSetlists.length,
          toursFound: tours.size,
          tours: [...tours].sort()
        });

      } catch (err) {
        console.error(`[SSE] Error on page ${page}:`, err.message);
        send({
          type: 'error',
          page,
          message: err.message
        });
        // Continue to next page instead of crashing
        await sleep(2000);
      }
    }

    send({
      type: 'complete',
      totalSetlists: allSetlists.length,
      tours: [...tours].sort(),
      totalPages
    });

  } catch (err) {
    console.error('[SSE] Fatal error:', err.message);
    send({ type: 'error', message: err.message });
  } finally {
    res.end();
  }
});

// Get shows for a specific tour (also no cap now)
app.get('/api/tour-shows', async (req, res) => {
  try {
    const { mbid, tour } = req.query;
    if (!mbid || !tour) return res.status(400).json({ error: 'MBID and tour required' });

    const allSetlists = [];
    let page = 1;
    let totalPages = 1;

    do {
      const data = await apiRequest(`/artist/${mbid}/setlists?p=${page}`);

      const setlists = data.setlist || data.setlists?.setlist || [];
      if (Array.isArray(setlists) && setlists.length > 0) {
        allSetlists.push(...setlists);
      }

      const total = parseInt(data.total) || 0;
      const perPage = parseInt(data.itemsPerPage) || 20;
      totalPages = total > 0 ? Math.ceil(total / perPage) : 1;

      page++;
    } while (page <= totalPages);

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