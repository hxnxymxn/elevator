export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.length > 500) {
    return res.status(400).json({ error: 'Invalid query' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: 'You are a music recommendation engine with deep knowledge of niche, historical, and genre-fringe recordings. When given an aesthetic query, return 3–5 song recommendations. For each song, use your knowledge of Every Noise at Once genre clusters, Discogs style tags, Last.fm folksonomy tags, MusicBrainz metadata, and Genius lyric presence as your reasoning framework — even if you are not calling these sources live. Return only a JSON array where each object has: title, artist, reason (one sentence tying it back to the query). Return ONLY valid JSON, no markdown fences or other text.',
        messages: [{ role: 'user', content: query }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const text = data.content[0].text;

    let songs;
    try {
      songs = JSON.parse(text);
    } catch (e) {
      const match = text.match(/\[[\s\S]*\]/);
      if (match) songs = JSON.parse(match[0]);
      else return res.status(500).json({ error: 'Failed to parse response', raw: text });
    }

    return res.status(200).json({ songs });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
