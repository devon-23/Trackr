// State
let currentArtist = null;
let currentTour = null;
let map = null;
let markers = [];
let routeLine = null;
let currentShows = [];
let eventSource = null;

// Playback state
let isPlaying = false;
let playIndex = 0;
let playSpeed = 1;
let playTimeout = null;
const BASE_DWELL = 3500;

function initMap() {
    if (map) return;

    map = L.map('map', {
    zoomControl: false,
    attributionControl: false
    }).setView([30, 0], 2);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19
    }).addTo(map);

    L.control.attribution({ position: 'bottomright' }).addTo(map);
    L.control.zoom({ position: 'topright' }).addTo(map);
}

function formatDate(dateStr) {
    const [d, m, y] = dateStr.split('-');
    const date = new Date(`${y}-${m}-${d}`);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function setError(msg) {
    document.getElementById('errorMsg').textContent = msg;
}
function clearError() {
    document.getElementById('errorMsg').textContent = '';
}

async function searchArtist() {
    const input = document.getElementById('artistInput');
    const btn = document.getElementById('searchBtn');
    const name = input.value.trim();

    if (!name) return;

    clearError();
    stopPlayback();

    // Close any existing SSE
    if (eventSource) {
    eventSource.close();
    eventSource = null;
    }

    btn.disabled = true;
    btn.innerHTML = 'Searching<span class="loading"></span>';

    // Reset downstream UI
    document.getElementById('scanProgress').classList.remove('visible');
    document.getElementById('tourSelectWrapper').classList.remove('visible');
    document.getElementById('statsBar').classList.remove('visible');
    document.getElementById('mapSection').classList.remove('visible');
    document.getElementById('stopsSection').classList.remove('visible');
    document.getElementById('playControls').classList.remove('visible');
    document.getElementById('tourSelect').innerHTML = '<option value="">Select a tour...</option>';

    try {
    const res = await fetch(`/api/search-artist?name=${encodeURIComponent(name)}`);
    if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Artist not found');
    }

    currentArtist = await res.json();

    // Start SSE stream for ALL tours (no page cap)
    startTourStream(currentArtist.mbid);

    } catch (err) {
    setError(err.message || 'Something went wrong. Try again.');
    btn.disabled = false;
    btn.textContent = 'Search';
    }
}

function startTourStream(mbid) {
    const scanProgress = document.getElementById('scanProgress');
    const scanBarFill = document.getElementById('scanBarFill');
    const scanTourCount = document.getElementById('scanTourCount');
    const scanDetail = document.getElementById('scanDetail');
    const select = document.getElementById('tourSelect');
    const btn = document.getElementById('searchBtn');

    scanProgress.classList.add('visible');

    eventSource = new EventSource(`/api/tours-stream?mbid=${mbid}`);

    eventSource.onmessage = (e) => {
    const data = JSON.parse(e.data);

    if (data.type === 'progress') {
        const pct = data.totalPages > 0 ? (data.page / data.totalPages) * 100 : 0;
        scanBarFill.style.width = pct + '%';
        scanTourCount.textContent = `${data.toursFound} tour${data.toursFound !== 1 ? 's' : ''} found`;
        scanDetail.textContent = `Page ${data.page} of ${data.totalPages} — ${data.setlistsFound} setlists scanned`;

        // Incrementally populate dropdown as tours are discovered
        select.innerHTML = '<option value="">Select a tour...</option>';
        data.tours.forEach(tour => {
        const opt = document.createElement('option');
        opt.value = tour;
        opt.textContent = tour;
        select.appendChild(opt);
        });
    }

    if (data.type === 'complete') {
        scanBarFill.style.width = '100%';
        scanTourCount.textContent = `${data.tours.length} tour${data.tours.length !== 1 ? 's' : ''} found`;
        scanDetail.textContent = `Done — scanned ${data.totalSetlists} setlists across ${data.totalPages} pages`;

        // Final populate
        select.innerHTML = '<option value="">Select a tour...</option>';
        data.tours.forEach(tour => {
        const opt = document.createElement('option');
        opt.value = tour;
        opt.textContent = tour;
        select.appendChild(opt);
        });

        document.getElementById('tourSelectWrapper').classList.add('visible');
        btn.disabled = false;
        btn.textContent = 'Search';

        // Hide scan progress after a moment
        setTimeout(() => {
        scanProgress.classList.remove('visible');
        }, 2000);

        eventSource.close();
        eventSource = null;
    }

    if (data.type === 'error') {
        scanDetail.textContent = `Error on page ${data.page}: ${data.message}`;
    }
    };

    eventSource.onerror = (err) => {
    console.error('SSE error:', err);
    scanDetail.textContent = 'Connection error. Retrying...';
    eventSource.close();
    eventSource = null;
    btn.disabled = false;
    btn.textContent = 'Search';
    };
}

async function selectTour() {
    const select = document.getElementById('tourSelect');
    const tourName = select.value;

    if (!tourName || !currentArtist) return;

    clearError();
    stopPlayback();
    currentTour = tourName;
    select.disabled = true;

    try {
    const res = await fetch(`/api/tour-shows?mbid=${currentArtist.mbid}&tour=${encodeURIComponent(tourName)}`);
    if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to load tour');
    }

    const data = await res.json();
    currentShows = data.shows || [];

    if (currentShows.length === 0) {
        setError('No shows found for this tour.');
        return;
    }

    // Update stats
    const uniqueCities = new Set(currentShows.map(s => s.city));
    const uniqueCountries = new Set(currentShows.map(s => s.country));

    document.getElementById('statShows').textContent = currentShows.length;
    document.getElementById('statCities').textContent = uniqueCities.size;
    document.getElementById('statCountries').textContent = uniqueCountries.size;
    document.getElementById('statsBar').classList.add('visible');

    // Update map
    document.getElementById('mapTourName').textContent = tourName;
    document.getElementById('mapSection').classList.add('visible');
    initMap();
    renderRoute(currentShows);

    // Show play controls
    document.getElementById('playControls').classList.add('visible');
    updateProgress(0);

    // Update stops list
    document.getElementById('stopsSection').classList.add('visible');
    renderStops(currentShows);

    setTimeout(() => {
        document.getElementById('mapSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

    } catch (err) {
    setError(err.message || 'Failed to load tour data.');
    } finally {
    select.disabled = false;
    }
}

function renderRoute(shows) {
    markers.forEach(m => map.removeLayer(m));
    if (routeLine) map.removeLayer(routeLine);
    markers = [];

    const validShows = shows.filter(s => s.coords && s.coords.lat && s.coords.long);
    if (validShows.length === 0) {
    setError('No location data available for this tour.');
    return;
    }

    const latlngs = validShows.map(s => [s.coords.lat, s.coords.long]);

    routeLine = L.polyline(latlngs, {
    color: '#c9a87c',
    weight: 2.5,
    opacity: 0.7,
    lineCap: 'round',
    lineJoin: 'round'
    }).addTo(map);

    map.fitBounds(routeLine.getBounds(), { 
    padding: [60, 60],
    maxZoom: 10,
    animate: true,
    duration: 1.5
    });

    validShows.forEach((show, i) => {
    setTimeout(() => {
        const marker = L.circleMarker([show.coords.lat, show.coords.long], {
        radius: 7,
        fillColor: '#faf8f5',
        color: '#c9a87c',
        weight: 2.5,
        opacity: 1,
        fillOpacity: 0.95
        }).addTo(map);

        const stateLine = show.state ? `<div style="font-family: 'IBM Plex Mono', monospace; font-size: 0.7rem; color: #c9a87c; margin-bottom: 4px;">${show.state}</div>` : '';

        marker.bindPopup(`
        <div style="min-width: 160px;">
            <div style="font-family: 'Cormorant Garamond', serif; font-size: 1.1rem; font-weight: 600; color: #1a1a1a; margin-bottom: 4px;">
            ${show.order}. ${show.city}
            </div>
            ${stateLine}
            <div style="font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; color: #888; margin-bottom: 6px;">
            ${formatDate(show.date)}
            </div>
            <div style="font-size: 0.85rem; color: #555;">
            ${show.venue}
            </div>
            ${show.setlistUrl ? `<a href="${show.setlistUrl}" target="_blank" style="display: inline-block; margin-top: 8px; font-size: 0.8rem; color: #c9a87c; text-decoration: none;">View setlist →</a>` : ''}
        </div>
        `, { closeButton: false, offset: [0, -5] });

        marker.showData = show;
        marker.on('click', () => highlightStop(show.order, true));
        markers.push(marker);
    }, i * 80);
    });
}

function renderStops(shows) {
    const container = document.getElementById('stopsList');
    container.innerHTML = '';

    shows.forEach(show => {
    const card = document.createElement('div');
    card.className = 'stop-card';
    card.dataset.order = show.order;
    card.onclick = () => {
        stopPlayback();
        highlightStop(show.order, true);
        if (show.coords) {
        map.flyTo([show.coords.lat, show.coords.long], 12, {
            duration: 1.5,
            easeLinearity: 0.25
        });
        const marker = markers.find(m => m.showData.order === show.order);
        if (marker) marker.openPopup();
        }
    };

    const locationParts = [];
    if (show.state) locationParts.push(`<span class="state">${show.state}</span>`);
    if (show.country && show.country !== 'Unknown Country') {
        locationParts.push(show.country);
    }
    const locationHtml = locationParts.length > 0 
        ? `<div class="stop-location">${locationParts.join('<span class="sep">/</span>')}</div>` 
        : '';

    card.innerHTML = `
        <div class="stop-number">Stop ${show.order}</div>
        <div class="stop-city">${show.city}</div>
        <div class="stop-venue">${show.venue}</div>
        <div class="stop-date">${formatDate(show.date)}</div>
        ${locationHtml}
    `;

    container.appendChild(card);
    });
}

function highlightStop(order, shouldScroll = false) {
    document.querySelectorAll('.stop-card').forEach(c => {
    c.classList.remove('active', 'playing');
    });
    const card = document.querySelector(`.stop-card[data-order="${order}"]`);
    if (card) {
    card.classList.add('active');
    if (shouldScroll) {
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    }
}

// ==================== PLAYBACK ====================

function togglePlay() {
    if (isPlaying) {
    stopPlayback();
    } else {
    startPlayback();
    }
}

function startPlayback() {
    if (currentShows.length === 0) return;

    isPlaying = true;
    document.getElementById('playIcon').style.display = 'none';
    document.getElementById('pauseIcon').style.display = 'block';

    if (playIndex >= currentShows.length) {
    playIndex = 0;
    }

    playNext();
}

function stopPlayback() {
    isPlaying = false;
    if (playTimeout) {
    clearTimeout(playTimeout);
    playTimeout = null;
    }
    document.getElementById('playIcon').style.display = 'block';
    document.getElementById('pauseIcon').style.display = 'none';
    document.querySelectorAll('.stop-card').forEach(c => c.classList.remove('playing'));
}

function playNext() {
    if (!isPlaying || playIndex >= currentShows.length) {
    if (playIndex >= currentShows.length) {
        stopPlayback();
        playIndex = 0;
        updateProgress(0);
    }
    return;
    }

    const show = currentShows[playIndex];

    document.querySelectorAll('.stop-card').forEach(c => c.classList.remove('playing'));
    const card = document.querySelector(`.stop-card[data-order="${show.order}"]`);
    if (card) {
    card.classList.add('playing');
    }

    updateProgress(playIndex + 1);

    if (show.coords && show.coords.lat && show.coords.long) {
    map.flyTo([show.coords.lat, show.coords.long], 10, {
        duration: 2.0 / playSpeed,
        easeLinearity: 0.25
    });

    const marker = markers.find(m => m.showData.order === show.order);
    if (marker) {
        setTimeout(() => {
        if (isPlaying) marker.openPopup();
        }, (1200 / playSpeed));
    }
    }

    playTimeout = setTimeout(() => {
    playIndex++;
    playNext();
    }, BASE_DWELL / playSpeed);
}

function updateProgress(completed) {
    const total = currentShows.length;
    const pct = total > 0 ? (completed / total) * 100 : 0;
    document.getElementById('progressFill').style.width = pct + '%';
    document.getElementById('progressCount').textContent = `${completed} / ${total}`;

    if (completed > 0 && completed <= total) {
    const show = currentShows[completed - 1];
    document.getElementById('progressCity').textContent = show.city;
    document.getElementById('progressCity').classList.add('current-city');
    } else if (completed === 0) {
    document.getElementById('progressCity').textContent = 'Ready';
    document.getElementById('progressCity').classList.remove('current-city');
    }
}

function setSpeed(speed) {
    playSpeed = speed;
    document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.speed) === speed);
    });
}

document.getElementById('artistInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') searchArtist();
});