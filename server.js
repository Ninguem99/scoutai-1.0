require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FD_KEY = () => process.env.FOOTBALL_DATA_KEY || '';
const AI_KEY = () => process.env.ANTHROPIC_KEY || '';
const FD_BASE = 'https://api.football-data.org/v4';

// Cache to avoid repeated calls
const teamsCache = { data: null, ts: 0 };

async function fdApi(endpoint, params = {}) {
  const url = new URL(FD_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: { 'X-Auth-Token': FD_KEY() }
  });
  if (!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}

// Load all teams once and cache for 1 hour
async function getAllTeams() {
  const now = Date.now();
  if (teamsCache.data && (now - teamsCache.ts) < 3600000) return teamsCache.data;

  const COMPETITIONS = ['PL','PD','BL1','SA','FL1','PPL','CL','EL','BSA'];
  const teams = [];
  const seen = new Set();

  // Fetch competitions in parallel — all at once (9 calls, within limit)
  const results = await Promise.allSettled(
    COMPETITIONS.map(c => fdApi(`/competitions/${c}/teams`))
  );

  results.forEach(r => {
    if (r.status !== 'fulfilled') return;
    const comp = r.value;
    (comp.teams || []).forEach(t => {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        teams.push({
          id: t.id,
          name: t.name,
          shortName: t.shortName || t.name,
          logo: t.crest,
          country: comp.competition?.area?.name || '',
          competition: comp.competition?.name || ''
        });
      }
    });
  });

  teamsCache.data = teams;
  teamsCache.ts = now;
  return teams;
}

// ── Search teams (instant, from cache) ───────────────────────────
app.get('/api/search-team', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name || name.length < 2) return res.json([]);

    const all = await getAllTeams();
    const q = name.toLowerCase();
    const matches = all.filter(t =>
      t.name.toLowerCase().includes(q) ||
      t.shortName.toLowerCase().includes(q)
    ).slice(0, 8);

    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gather match data ─────────────────────────────────────────────
app.post('/api/gather-data', async (req, res) => {
  const { homeId, awayId, homeName, awayName } = req.body;

  try {
    const [homeMatches, awayMatches, homeInfo, awayInfo] = await Promise.all([
      fdApi(`/teams/${homeId}/matches`, { status: 'FINISHED', limit: 30 }),
      fdApi(`/teams/${awayId}/matches`, { status: 'FINISHED', limit: 30 }),
      fdApi(`/teams/${homeId}`).catch(() => ({})),
      fdApi(`/teams/${awayId}`).catch(() => ({}))
    ]);

    const processMatches = (data, teamId) =>
      (data.matches || []).map(m => {
        const isHome = m.homeTeam.id === teamId;
        const gf = isHome ? m.score.fullTime.home : m.score.fullTime.away;
        const ga = isHome ? m.score.fullTime.away : m.score.fullTime.home;
        if (gf === null || ga === null) return null;
        return {
          date: m.utcDate?.slice(0, 10),
          opponent: isHome ? m.awayTeam.name : m.homeTeam.name,
          score: `${m.score.fullTime.home}-${m.score.fullTime.away}`,
          result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
          goalsFor: gf, goalsAgainst: ga,
          venue: isHome ? 'home' : 'away',
          competition: m.competition?.name
        };
      }).filter(Boolean);

    const homeFixtures = processMatches(homeMatches, homeId);
    const awayFixtures = processMatches(awayMatches, awayId);

    // H2H from combined matches
    const allMatches = [...(homeMatches.matches || []), ...(awayMatches.matches || [])];
    const h2hMatches = allMatches.filter(m =>
      (m.homeTeam.id === homeId && m.awayTeam.id === awayId) ||
      (m.homeTeam.id === awayId && m.awayTeam.id === homeId)
    ).slice(0, 12).map(m => ({
      date: m.utcDate?.slice(0, 10),
      home: m.homeTeam.name, away: m.awayTeam.name,
      score: `${m.score.fullTime.home}-${m.score.fullTime.away}`,
      totalGoals: (m.score.fullTime.home || 0) + (m.score.fullTime.away || 0),
      winner: m.score.fullTime.home > m.score.fullTime.away ? m.homeTeam.name
            : m.score.fullTime.away > m.score.fullTime.home ? m.awayTeam.name : 'Empate'
    }));

    const avg = (arr, fn) => arr.length ? (arr.reduce((s, x) => s + fn(x), 0) / arr.length).toFixed(2) : 'N/A';
    const stats = (arr) => ({
      wins: arr.filter(f => f.result === 'W').length,
      draws: arr.filter(f => f.result === 'D').length,
      losses: arr.filter(f => f.result === 'L').length,
      cleanSheets: arr.filter(f => f.goalsAgainst === 0).length,
      failedToScore: arr.filter(f => f.goalsFor === 0).length,
      btts: arr.filter(f => f.goalsFor > 0 && f.goalsAgainst > 0).length,
      over25: arr.filter(f => f.goalsFor + f.goalsAgainst > 2.5).length,
    });

    const homeRecent = homeFixtures.slice(0, 15);
    const awayRecent = awayFixtures.slice(0, 15);
    const homeHome = homeFixtures.filter(f => f.venue === 'home').slice(0, 10);
    const awayAway = awayFixtures.filter(f => f.venue === 'away').slice(0, 10);

    res.json({
      success: true,
      data: {
        home: {
          name: homeName,
          coach: homeInfo.coach?.name || null,
          venue: homeInfo.venue?.name || null,
          recentForm: homeRecent.map(f => f.result).join(''),
          recentFixtures: homeRecent,
          homeFixtures: homeHome,
          avgGoalsFor: avg(homeRecent, f => f.goalsFor),
          avgGoalsAgainst: avg(homeRecent, f => f.goalsAgainst),
          avgGoalsForAtHome: avg(homeHome, f => f.goalsFor),
          avgGoalsAgainstAtHome: avg(homeHome, f => f.goalsAgainst),
          stats: stats(homeRecent),
          homeStats: stats(homeHome),
        },
        away: {
          name: awayName,
          coach: awayInfo.coach?.name || null,
          venue: awayInfo.venue?.name || null,
          recentForm: awayRecent.map(f => f.result).join(''),
          recentFixtures: awayRecent,
          awayFixtures: awayAway,
          avgGoalsFor: avg(awayRecent, f => f.goalsFor),
          avgGoalsAgainst: avg(awayRecent, f => f.goalsAgainst),
          avgGoalsForAway: avg(awayAway, f => f.goalsFor),
          avgGoalsAgainstAway: avg(awayAway, f => f.goalsAgainst),
          stats: stats(awayRecent),
          awayStats: stats(awayAway),
        },
        h2h: h2hMatches,
        h2hSummary: {
          total: h2hMatches.length,
          homeWins: h2hMatches.filter(m => m.winner === homeName).length,
          awayWins: h2hMatches.filter(m => m.winner === awayName).length,
          draws: h2hMatches.filter(m => m.winner === 'Empate').length,
          avgGoals: avg(h2hMatches, m => m.totalGoals),
          over25: h2hMatches.filter(m => m.totalGoals > 2.5).length,
        }
      }
    });

  } catch (err) {
    console.error('gather-data error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Anthropic ────────────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AI_KEY(),
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    res.json(await r.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Warmup cache on start
setTimeout(() => {
  console.log('🔄 A carregar equipas em cache...');
  getAllTeams().then(t => console.log(`✅ ${t.length} equipas em cache`)).catch(console.error);
}, 2000);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`✅ ScoutAI v3.0 — porta ${PORT}`));
