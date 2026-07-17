require('dotenv').config();
const axios = require('axios');

const API_KEY = process.env.SETLIST_API_KEY;
const BASE_URL = 'https://api.setlist.fm/rest/1.0';

// Rate limit helper: wait 600ms between requests (safe under 2/sec limit)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Generic API request wrapper
async function apiRequest(endpoint) {
  try {
    const response = await axios.get(`${BASE_URL}${endpoint}`, {
      headers: {
        'Accept': 'application/json',
        'x-api-key': API_KEY
      }
    });
    await sleep(600); // Respect rate limit
    return response.data;
  } catch (err) {
    console.error(`API Error on ${endpoint}:`, err.response?.data || err.message);
    throw err;
  }
}

// Step 1: Search for artist by name to get their MBID
async function getArtistMBID(artistName) {
  const data = await apiRequest(`/search/artists?artistName=${encodeURIComponent(artistName)}&p=1&sort=relevance`);
  
  if (!data.artist || data.artist.length === 0) {
    throw new Error(`No artist found for "${artistName}"`);
  }
  
  const artist = data.artist[0];
  console.log(`Found artist: ${artist.name} (MBID: ${artist.mbid})`);
  return artist.mbid;
}

// Step 2: Fetch ALL setlists for an artist (handles pagination)
async function getAllSetlists(mbid) {
  const allSetlists = [];
  let page = 1;
  let totalPages = 1;
  
  do {
    console.log(`Fetching page ${page}...`);
    const data = await apiRequest(`/artist/${mbid}/setlists?p=${page}`);
    
    if (data.setlist) {
      allSetlists.push(...data.setlist);
    }
    
    totalPages = Math.ceil(data.total / data.itemsPerPage);
    page++;
  } while (page <= totalPages && page <= 100); // Safety cap at 100 pages
  
  console.log(`Total setlists fetched: ${allSetlists.length}`);
  return allSetlists;
}

// Step 3: Filter setlists by tour name
function filterByTour(setlists, tourName) {
  // Case-insensitive partial match (e.g., "Blurryface" matches "Blurryface Tour")
  const normalizedSearch = tourName.toLowerCase();
  
  return setlists.filter(s => {
    if (!s.tour || !s.tour.name) return false;
    return s.tour.name.toLowerCase().includes(normalizedSearch);
  });
}

// Step 4: Extract and normalize the data we need
function extractShowData(setlists) {
  // Sort by date
  const sorted = setlists.sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate));
  
  return sorted.map((s, index) => ({
    order: index + 1,
    date: s.eventDate,        // Format: "DD-MM-YYYY"
    venue: s.venue?.name || 'Unknown Venue',
    city: s.venue?.city?.name || 'Unknown City',
    country: s.venue?.city?.country?.name || 'Unknown Country',
    coords: s.venue?.city?.coords || null,  // { lat: 39.1, long: -84.5 }
    tour: s.tour?.name || 'No Tour',
    setlistId: s.id,
    url: s.url
  }));
}

// Step 5: Deduplicate multi-night stands (optional — one dot per city)
function dedupeByCity(shows) {
  const seen = new Set();
  return shows.filter(show => {
    const key = `${show.city}-${show.date}`; // Or just city if you want one dot per city total
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Main execution
async function main() {
  const artistName = process.argv[2] || 'Twenty One Pilots';
  const tourName = process.argv[3] || 'Blurryface';  // Partial match works
  
  try {
    console.log(`\n🔍 Searching for: ${artistName}`);
    const mbid = await getArtistMBID(artistName);
    
    console.log(`\n📥 Fetching all setlists...`);
    const allSetlists = await getAllSetlists(mbid);
    
    console.log(`\n🎸 Filtering for tour: "${tourName}"`);
    const tourSetlists = filterByTour(allSetlists, tourName);
    console.log(`Found ${tourSetlists.length} shows for this tour.`);
    
    if (tourSetlists.length === 0) {
      // Show available tours so user can pick
      const tours = [...new Set(allSetlists
        .filter(s => s.tour?.name)
        .map(s => s.tour.name))];
      console.log(`\nAvailable tours for ${artistName}:`);
      tours.forEach(t => console.log(`  - ${t}`));
      return;
    }
    
    const shows = extractShowData(tourSetlists);
    
    console.log(`\n📍 Tour Route (${shows.length} stops):`);
    shows.forEach(s => {
      const coords = s.coords ? `(${s.coords.lat}, ${s.coords.long})` : '(no coords)';
      console.log(`  ${s.order}. ${s.date} — ${s.city}, ${s.country} @ ${s.venue} ${coords}`);
    });
    
    // Save to JSON
    const fs = require('fs');
    const output = {
      artist: artistName,
      tour: tourName,
      totalShows: shows.length,
      shows: shows
    };
    
    const filename = `${artistName.replace(/\s+/g, '_')}_${tourName.replace(/\s+/g, '_')}.json`;
    fs.writeFileSync(filename, JSON.stringify(output, null, 2));
    console.log(`\n💾 Saved to ${filename}`);
    
  } catch (err) {
    console.error('Script failed:', err.message);
    process.exit(1);
  }
}

main();