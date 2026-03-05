require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const NINJAS_KEY = () => process.env.NINJAS_KEY || '';
const AI_KEY = () => process.env.ANTHROPIC_KEY || '';
const NINJAS_BASE = 'https://api.api-ninjas.com/v1';

async function ninjasApi(endpoint, params = {}) {
  const url = new URL(NINJAS_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: { 'X-Api-Key': NINJAS_KEY() }
  });
  if (!r.ok) throw new Error(`API ${r.status}: ${await r.text()}`);
  return r.json();
}

// ── Search teams ──────────────────────────────────────────────────
app.get('/api/search-team', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name || name.length < 2) return res.json([]);
    const data = await ninjasApi('/teams', { name });
    const results = (Array.isArray(data) ? data : []).slice(0, 8).map(t => ({
      id: t.id || t.name,
      name: t.name,
      shortName: t.name,
      logo: null,
      country: t.country || '',
      competition: t.league || ''
    }));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Gather match data ─────────────────────────────────────────────
app.post('/api/gather-data', async (req, res) => {
  const { homeId, awayId, homeName, awayName } = req.body;

  try {
    // Get games for each team
    const [homeGames, awayGames] = await Promise.all([
      ninjasApi('/games', { team: homeName, limit: 30 }).catch(() => []),
      ninjasApi('/games', { team: awayName, limit: 30 }).catch(() => [])
    ]);

    const processGames = (games, teamName) => {
      return (Array.isArray(games) ? games : []).map(g => {
        const isHome = g.home_team?.toLowerCase() === teamName.toLowerCase();
        const gf = isHome ? parseInt(g.home_score) : parseInt(g.away_score);
        const ga = isHome ? parseInt(g.away_score) : parseInt(g.home_score);
        if (isNaN(gf) || isNaN(ga)) return null;
        return {
          date: g.date,
          opponent: isHome ? g.away_team : g.home_team,
          score: `${g.home_score}-${g.away_score}`,
          result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
          goalsFor: gf, goalsAgainst: ga,
          venue: isHome ? 'home' : 'away',
          competition: g.league || ''
        };
      }).filter(Boolean);
    };

    const homeFixtures = processGames(homeGames, homeName);
    const awayFixtures = processGames(awayGames, awayName);

    // H2H from combined
    const allGames = [...(Array.isArray(homeGames) ? homeGames : []), ...(Array.isArray(awayGames) ? awayGames : [])];
    const h2hMatches = allGames.filter(g => {
      const ht = g.home_team?.toLowerCase(), at = g.away_team?.toLowerCase();
      const hn = homeName.toLowerCase(), an = awayName.toLowerCase();
      return (ht === hn && at === an) || (ht === an && at === hn);
    }).slice(0, 12).map(g => ({
      date: g.date,
      home: g.home_team, away: g.away_team,
      score: `${g.home_score}-${g.away_score}`,
      totalGoals: (parseInt(g.home_score) || 0) + (parseInt(g.away_score) || 0),
      winner: parseInt(g.home_score) > parseInt(g.away_score) ? g.home_team
            : parseInt(g.away_score) > parseInt(g.home_score) ? g.away_team : 'Empate'
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`✅ ScoutAI v3.0 (API-Ninjas) — porta ${PORT}`));
