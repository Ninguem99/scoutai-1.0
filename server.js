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

// Helper
async function fdApi(endpoint, params = {}) {
  const url = new URL(FD_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: { 'X-Auth-Token': FD_KEY() }
  });
  if (!r.ok) throw new Error(`FD API ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── Search teams ─────────────────────────────────────────────────
app.get('/api/search-team', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name || name.length < 2) return res.json([]);

    // Search across top competitions
    const COMPETITIONS = ['PL','PD','BL1','SA','FL1','PPL','CL','EL','BSA'];
    const seen = new Set();
    const results = [];

    for (const comp of COMPETITIONS) {
      try {
        const data = await fdApi(`/competitions/${comp}/teams`);
        for (const t of (data.teams || [])) {
          if (!seen.has(t.id) && (
            t.name.toLowerCase().includes(name.toLowerCase()) ||
            t.shortName?.toLowerCase().includes(name.toLowerCase()) ||
            t.tla?.toLowerCase().includes(name.toLowerCase())
          )) {
            seen.add(t.id);
            results.push({
              id: t.id,
              name: t.name,
              shortName: t.shortName || t.name,
              logo: t.crest,
              country: data.competition?.area?.name || '',
              competition: data.competition?.name || comp
            });
          }
        }
      } catch(e) { /* skip competition on error */ }
      if (results.length >= 10) break;
    }

    res.json(results.slice(0, 8));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gather match data ─────────────────────────────────────────────
app.post('/api/gather-data', async (req, res) => {
  const { homeId, awayId, homeName, awayName } = req.body;

  try {
    // Fetch matches for both teams + H2H
    const [homeMatches, awayMatches, h2hData] = await Promise.all([
      fdApi(`/teams/${homeId}/matches`, { status: 'FINISHED', limit: 30 }),
      fdApi(`/teams/${awayId}/matches`, { status: 'FINISHED', limit: 30 }),
      fdApi(`/teams/${homeId}/matches`, { status: 'FINISHED', limit: 60 })
        .catch(() => ({ matches: [] }))
    ]);

    // Also try to get team info
    const [homeInfo, awayInfo] = await Promise.all([
      fdApi(`/teams/${homeId}`).catch(() => ({})),
      fdApi(`/teams/${awayId}`).catch(() => ({}))
    ]);

    const processMatches = (matches, teamId) => {
      return (matches.matches || []).map(m => {
        const isHome = m.homeTeam.id === teamId;
        const gf = isHome ? m.score.fullTime.home : m.score.fullTime.away;
        const ga = isHome ? m.score.fullTime.away : m.score.fullTime.home;
        if (gf === null || ga === null) return null;
        return {
          date: m.utcDate?.slice(0, 10),
          opponent: isHome ? m.awayTeam.name : m.homeTeam.name,
          score: `${m.score.fullTime.home}-${m.score.fullTime.away}`,
          result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
          goalsFor: gf,
          goalsAgainst: ga,
          venue: isHome ? 'home' : 'away',
          competition: m.competition?.name,
          season: m.season?.startDate?.slice(0, 4)
        };
      }).filter(Boolean);
    };

    const homeFixtures = processMatches(homeMatches, homeId);
    const awayFixtures = processMatches(awayMatches, awayId);

    // H2H: matches between the two teams
    const h2hMatches = (h2hData.matches || []).filter(m =>
      (m.homeTeam.id === homeId && m.awayTeam.id === awayId) ||
      (m.homeTeam.id === awayId && m.awayTeam.id === homeId)
    ).slice(0, 15).map(m => ({
      date: m.utcDate?.slice(0, 10),
      home: m.homeTeam.name,
      away: m.awayTeam.name,
      score: `${m.score.fullTime.home}-${m.score.fullTime.away}`,
      totalGoals: (m.score.fullTime.home || 0) + (m.score.fullTime.away || 0),
      winner: m.score.fullTime.home > m.score.fullTime.away
        ? m.homeTeam.name
        : m.score.fullTime.away > m.score.fullTime.home
          ? m.awayTeam.name : 'Empate'
    })).filter(m => m.score !== 'null-null');

    const avg = (arr, fn) => arr.length
      ? (arr.reduce((s, x) => s + fn(x), 0) / arr.length).toFixed(2)
      : null;

    const homeRecent = homeFixtures.slice(0, 15);
    const awayRecent = awayFixtures.slice(0, 15);
    const homeHome = homeFixtures.filter(f => f.venue === 'home').slice(0, 10);
    const awayAway = awayFixtures.filter(f => f.venue === 'away').slice(0, 10);

    const calcStats = (fixtures) => ({
      wins: fixtures.filter(f => f.result === 'W').length,
      draws: fixtures.filter(f => f.result === 'D').length,
      losses: fixtures.filter(f => f.result === 'L').length,
      cleanSheets: fixtures.filter(f => f.goalsAgainst === 0).length,
      failedToScore: fixtures.filter(f => f.goalsFor === 0).length,
      over25: fixtures.filter(f => f.goalsFor + f.goalsAgainst > 2.5).length,
      btts: fixtures.filter(f => f.goalsFor > 0 && f.goalsAgainst > 0).length,
    });

    res.json({
      success: true,
      data: {
        home: {
          name: homeName,
          info: { venue: homeInfo.venue?.name, founded: homeInfo.founded, coach: homeInfo.coach?.name },
          recentForm: homeRecent.map(f => f.result).join(''),
          recentFixtures: homeRecent,
          homeFixtures: homeHome,
          avgGoalsFor: avg(homeRecent, f => f.goalsFor),
          avgGoalsAgainst: avg(homeRecent, f => f.goalsAgainst),
          avgGoalsForAtHome: avg(homeHome, f => f.goalsFor),
          avgGoalsAgainstAtHome: avg(homeHome, f => f.goalsAgainst),
          stats: calcStats(homeRecent),
          homeStats: calcStats(homeHome),
        },
        away: {
          name: awayName,
          info: { venue: awayInfo.venue?.name, founded: awayInfo.founded, coach: awayInfo.coach?.name },
          recentForm: awayRecent.map(f => f.result).join(''),
          recentFixtures: awayRecent,
          awayFixtures: awayAway,
          avgGoalsFor: avg(awayRecent, f => f.goalsFor),
          avgGoalsAgainst: avg(awayRecent, f => f.goalsAgainst),
          avgGoalsForAway: avg(awayAway, f => f.goalsFor),
          avgGoalsAgainstAway: avg(awayAway, f => f.goalsAgainst),
          stats: calcStats(awayRecent),
          awayStats: calcStats(awayAway),
        },
        h2h: h2hMatches,
        h2hSummary: {
          total: h2hMatches.length,
          homeWins: h2hMatches.filter(m => m.winner === homeName).length,
          awayWins: h2hMatches.filter(m => m.winner === awayName).length,
          draws: h2hMatches.filter(m => m.winner === 'Empate').length,
          avgGoals: avg(h2hMatches, m => m.totalGoals),
          over25: h2hMatches.filter(m => m.totalGoals > 2.5).length,
          btts: h2hMatches.filter(m => {
            const p = m.score.split('-');
            return parseInt(p[0]) > 0 && parseInt(p[1]) > 0;
          }).length
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
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AI_KEY(),
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    res.json(await response.json());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`✅ ScoutAI v3.0 (football-data.org) — porta ${PORT}`));
