const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const LASTFM_KEY = process.env.LASTFM_API_KEY;
const GENIUS_TOKEN = process.env.GENIUS_ACCESS_TOKEN;

// --- Enrichment sources ---

async function enrichLastfm(title, artist) {
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=track.getInfo&api_key=${LASTFM_KEY}&artist=${encodeURIComponent(artist)}&track=${encodeURIComponent(title)}&format=json`;
    const r = await fetch(url);
    const d = await r.json();
    if (!d.track || !d.track.toptags) return {};
    const moodWords = ['melancholic','dreamy','atmospheric','dark','upbeat','aggressive','chill','ethereal','haunting','psychedelic','lo-fi','noisy','ambient','experimental','female vocals','male vocals','instrumental','minor key','acoustic','electronic'];
    const tags = d.track.toptags.tag
      .map(t => t.name.toLowerCase())
      .filter(t => moodWords.some(m => t.includes(m)) || t.length < 20)
      .slice(0, 5);
    return { tags };
  } catch { return {}; }
}

async function enrichMusicBrainz(title, artist) {
  try {
    const url = `https://musicbrainz.org/ws/2/recording/?query=recording:${encodeURIComponent(title)}+AND+artist:${encodeURIComponent(artist)}&fmt=json&limit=1`;
    const r = await fetch(url, { headers: { 'User-Agent': 'MusicElevator/1.0 (elevator.jeff.garden)' } });
    const d = await r.json();
    if (!d.recordings || !d.recordings.length) return {};
    const rec = d.recordings[0];
    const mbid = rec.id || null;
    const year = rec['first-release-date'] ? rec['first-release-date'].slice(0, 4) : null;
    const genres = (rec.tags || []).map(t => t.name).slice(0, 3);
    return { mbid, year, genres };
  } catch { return {}; }
}

async function enrichGenius(title, artist) {
  if (!GENIUS_TOKEN) return {};
  try {
    const q = encodeURIComponent(`${title} ${artist}`);
    const url = `https://api.genius.com/search?q=${q}`;
    const r = await fetch(url, { headers: { 'Authorization': `Bearer ${GENIUS_TOKEN}` } });
    const d = await r.json();
    if (!d.response || !d.response.hits || !d.response.hits.length) return {};
    const hit = d.response.hits[0].result;
    const hasVocals = hit.lyrics_state === 'complete';
    return { hasVocals };
  } catch { return {}; }
}

async function enrichSong(song) {
  // Run all three in parallel
  const [lastfm, mb, genius] = await Promise.all([
    enrichLastfm(song.title, song.artist),
    enrichMusicBrainz(song.title, song.artist),
    enrichGenius(song.title, song.artist),
  ]);

  return {
    title: song.title,
    artist: song.artist,
    reason: song.reason || null,
    tags: lastfm.tags || [],
    year: mb.year || null,
    genres: mb.genres || [],
    mbid: mb.mbid || null,
    hasVocals: genius.hasVocals != null ? genius.hasVocals : null,
  };
}

async function enrichAll(songs) {
  // Enrich in batches of 3 to respect MusicBrainz rate limit (~1 req/sec)
  const results = [];
  for (let i = 0; i < songs.length; i += 3) {
    const batch = songs.slice(i, i + 3);
    const enriched = await Promise.all(batch.map(s => enrichSong(s)));
    results.push(...enriched);
    if (i + 3 < songs.length) await new Promise(r => setTimeout(r, 1100));
  }
  return results;
}

// --- Main handler ---

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query, context } = req.body;
  if (!query || typeof query !== 'string' || query.length > 500) {
    return res.status(400).json({ error: 'Invalid query' });
  }

  if (!ANTHROPIC_KEY) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    // Build system prompt with optional enriched context
    let systemPrompt = 'You are a music recommendation engine with deep knowledge of niche, historical, and genre-fringe recordings. When given an aesthetic query, return 3–5 song recommendations. For each song, use your knowledge of Every Noise at Once genre clusters, Discogs style tags, Last.fm folksonomy tags, MusicBrainz metadata, and Genius lyric presence as your reasoning framework — even if you are not calling these sources live. Return ONLY a JSON object (no markdown fences) with two keys: "label" (a short 2-5 word abbreviated chapter title derived from the query, suitable for a UI header — e.g. "Surreal 50s Croon" or "No-Guitar Outsider") and "songs" (an array where each object has: title, artist, reason).';

    if (context && Array.isArray(context) && context.length > 0) {
      const recent = context.slice(-3);
      systemPrompt += `\n\nHere are recent songs from the user's list with enriched metadata: ${JSON.stringify(recent)}. Use this as your reference frame for the aesthetic query that follows.`;
    }

    // Call Claude
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: query }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const text = data.content[0].text;

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const objMatch = text.match(/\{[\s\S]*\}/);
      const arrMatch = text.match(/\[[\s\S]*\]/);
      if (objMatch) parsed = JSON.parse(objMatch[0]);
      else if (arrMatch) parsed = { songs: JSON.parse(arrMatch[0]) };
      else return res.status(500).json({ error: 'Failed to parse response', raw: text });
    }

    const rawSongs = parsed.songs || (Array.isArray(parsed) ? parsed : []);
    const label = parsed.label || null;

    // Enrich the recommended songs
    const enrichedSongs = await enrichAll(rawSongs);

    return res.status(200).json({ songs: enrichedSongs, label });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
