// TdF Tippspiel 2026 – Vercel API
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'tdf2026admin';
const KV_URL        = process.env.KV_REST_API_URL;
const KV_TOKEN      = process.env.KV_REST_API_TOKEN;

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  const j = await r.json();
  return j.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value) {
  await fetch(`${KV_URL}/set/${key}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(JSON.stringify(value))
  });
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

// Try multiple sources for rider data
async function fetchRidersFromPCS() {
  // Try 1: Direct fetch with browser-like headers
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    'Cache-Control': 'no-cache',
    'Referer': 'https://www.procyclingstats.com/',
  };

  const url = 'https://www.procyclingstats.com/race/tour-de-france/2026/startlist';
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const html = await r.text();

  // PCS startlist: riders appear as links like /rider/tadej-pogacar with display name
  // Try multiple regex patterns to be robust
  let riders = [];

  // Pattern 1: /rider/ links
  const p1 = [...html.matchAll(/href="\/rider\/[^"]+"\s*(?:title="[^"]*")?>([^<]{3,40})<\/a>/g)];
  if (p1.length > 0) {
    riders = p1.map(m => m[1].trim()).filter(r => r.includes(' ') && /[A-Z]/.test(r[0]));
  }

  // Pattern 2: data-name attributes (PCS sometimes uses these)
  if (riders.length < 50) {
    const p2 = [...html.matchAll(/data-name="([A-Z][^"]{3,40})"/g)];
    riders = [...riders, ...p2.map(m => m[1].trim())];
  }

  // Pattern 3: rider class spans
  if (riders.length < 50) {
    const p3 = [...html.matchAll(/class="[^"]*rider[^"]*"[^>]*>([A-Z][^<]{3,40})<\//g)];
    riders = [...riders, ...p3.map(m => m[1].trim()).filter(r => r.includes(' '))];
  }

  const unique = [...new Set(riders.map(r => r.trim()).filter(Boolean))].sort();
  if (unique.length < 20) throw new Error(`Only ${unique.length} riders found – site may be blocking`);
  return unique;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;

  if (req.method === 'GET' && action === 'state') {
    const state = await kvGet('tdf2026_state');
    return res.status(200).json(state || {});
  }

  if (req.method === 'POST' && action === 'state') {
    const { state, adminOp, password } = req.body;
    if (adminOp && password !== ADMIN_PASSWORD)
      return res.status(403).json({ error: 'Falsches Passwort' });
    await kvSet('tdf2026_state', state);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'POST' && action === 'auth') {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) return res.status(200).json({ ok: true });
    return res.status(403).json({ error: 'Falsches Passwort' });
  }

  if (req.method === 'GET' && action === 'riders') {
    // Always return cached if available (ignore age – admin can force refresh)
    const force = req.query.force === '1';
    if (!force) {
      const cached = await kvGet('tdf2026_riders');
      if (cached?.riders?.length > 20) {
        return res.status(200).json({ riders: cached.riders, cached: true, ts: cached.ts });
      }
    }
    try {
      const riders = await fetchRidersFromPCS();
      await kvSet('tdf2026_riders', { riders, ts: Date.now() });
      return res.status(200).json({ riders, cached: false });
    } catch(e) {
      // Return cached even if stale, rather than failing completely
      const cached = await kvGet('tdf2026_riders');
      if (cached?.riders?.length > 0) {
        return res.status(200).json({ riders: cached.riders, cached: true, stale: true });
      }
      return res.status(500).json({ error: e.message, hint: 'procyclingstats.com may be blocking the request. Try again later or use manual import.' });
    }
  }

  // Manual rider list import (admin can POST a list directly)
  if (req.method === 'POST' && action === 'riders') {
    const { riders, password } = req.body;
    if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Falsches Passwort' });
    if (!Array.isArray(riders) || riders.length < 5) return res.status(400).json({ error: 'Ungültige Fahrerliste' });
    await kvSet('tdf2026_riders', { riders, ts: Date.now() });
    return res.status(200).json({ ok: true, count: riders.length });
  }

  return res.status(404).json({ error: 'Unknown action' });
}
