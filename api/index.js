// TdF Tippspiel 2026 – Vercel API
// Handles: state sync, rider fetch from procyclingstats, admin auth
// Deploy to Vercel – uses KV store (Vercel KV / Upstash Redis)

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'tdf2026admin';
const KV_URL        = process.env.KV_REST_API_URL;
const KV_TOKEN      = process.env.KV_REST_API_TOKEN;

// ── KV helpers (Upstash Redis REST API) ──────────────
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

// ── CORS headers ──────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

// ── Main handler ──────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // ── GET state ──
  if (req.method === 'GET' && action === 'state') {
    const state = await kvGet('tdf2026_state');
    return res.status(200).json(state || {});
  }

  // ── POST state (requires admin password for certain ops) ──
  if (req.method === 'POST' && action === 'state') {
    const { state, adminOp, password } = req.body;
    if (adminOp) {
      if (password !== ADMIN_PASSWORD) return res.status(403).json({ error: 'Falsches Passwort' });
    }
    await kvSet('tdf2026_state', state);
    return res.status(200).json({ ok: true });
  }

  // ── Admin login check ──
  if (req.method === 'POST' && action === 'auth') {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) return res.status(200).json({ ok: true });
    return res.status(403).json({ error: 'Falsches Passwort' });
  }

  // ── Fetch riders from procyclingstats ──
  if (req.method === 'GET' && action === 'riders') {
    try {
      const cached = await kvGet('tdf2026_riders');
      // Return cached if less than 24h old
      if (cached && cached.ts && Date.now() - cached.ts < 86400000) {
        return res.status(200).json({ riders: cached.riders, cached: true });
      }

      const html = await fetch('https://www.procyclingstats.com/race/tour-de-france/2026/startlist', {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TdF-Tippspiel/1.0)' }
      }).then(r => r.text());

      // Parse rider names – PCS uses <a> tags with /rider/ paths
      const matches = [...html.matchAll(/href="\/rider\/[^"]+">([^<]+)<\/a>/g)];
      const riders = [...new Set(
        matches
          .map(m => m[1].trim())
          .filter(r => r.length > 3 && r.includes(' ') && /[A-Z]/.test(r[0]))
      )].sort();

      if (riders.length > 50) {
        await kvSet('tdf2026_riders', { riders, ts: Date.now() });
        return res.status(200).json({ riders, cached: false });
      }
      throw new Error('Too few riders parsed: ' + riders.length);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(404).json({ error: 'Unknown action' });
}
