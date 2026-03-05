require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const FB_KEY = () => process.env.API_FOOTBALL_KEY || '';
const AI_KEY = () => process.env.ANTHROPIC_KEY || '';
const FB_BASE = 'https://v3.football.api-sports.io';
const SEASONS = [2024, 2023, 2022];

async function fbApi(endpoint, params = {}) {
  const url = new URL(FB_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), {
    headers: { 'x-apisports-key': FB_KEY() }
  });
  const data = await r.json();
  return data.response || [];
}

// Search teams
app.get('/api/search-team', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name || name.length < 2) return res.json([]);
    const results = await fbApi('/teams', { search: name });
    res.json(results.slice(0, 8).map(t => ({
      id: t.team.id,
      name: t.team.name,
      logo: t.team.logo,
      country: t.team.country
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Gather all match data
app.post('/api/gather-data', async (req, res) => {
  const { homeId, awayId, homeName, awayName } = req.body;
  try {
    // Fetch in parallel where possible
    const [homeF2024, homeF2023, homeF2022, awayF2024, awayF2023, awayF2022, h2hRaw, homeStats, awayStats] = await Promise.all([
      fbApi('/fixtures', { team: homeId, season: 2024, last: 15 }),
      fbApi('/fixtures', { team: homeId, season: 2023, last: 15 }),
      fbApi('/fixtures', { team: homeId, season: 2022, last: 10 }),
      fbApi('/fixtures', { team: awayId, season: 2024, last: 15 }),
      fbApi('/fixtures', { team: awayId, season: 2023, last: 15 }),
      fbApi('/fixtures', { team: awayId, season: 2022, last: 10 }),
      fbApi('/fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: 20 }),
      fbApi('/teams/statistics', { team: homeId, season: 2024 }),
      fbApi('/teams/statistics', { team: awayId, season: 2024 })
    ]);

    const processFixtures = (fixtures, teamId) =>
      fixtures.map(f => {
        const isHome = f.teams.home.id === teamId;
        const gf = isHome ? f.goals.home : f.goals.away;
        const ga = isHome ? f.goals.away : f.goals.home;
        if (f.fixture.status.short !== 'FT' && f.fixture.status.short !== 'AET') return null;
        return {
          date: f.fixture.date?.slice(0, 10),
          opponent: isHome ? f.teams.away.name : f.teams.home.name,
          score: `${f.goals.home}-${f.goals.away}`,
          result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
          goalsFor: gf, goalsAgainst: ga,
          venue: isHome ? 'home' : 'away',
          league: f.league?.name,
          season: f.league?.season
        };
      }).filter(Boolean);

    const processStats = (s) => {
      if (!s || !s[0]) return {};
      const st = s[0];
      return {
        league: st.league?.name,
        form: st.form,
        played: st.fixtures?.played,
        wins: st.fixtures?.wins,
        draws: st.fixtures?.draws,
        loses: st.fixtures?.loses,
        goalsFor: st.goals?.for,
        goalsAgainst: st.goals?.against,
        avgGoalsFor: st.goals?.for?.average,
        avgGoalsAgainst: st.goals?.against?.average,
        cleanSheets: st.clean_sheet,
        failedToScore: st.failed_to_score,
        biggestWin: st.biggest?.wins,
        lineups: st.lineups?.slice(0, 2)
      };
    };

    const homeFixtures = processFixtures([...homeF2024, ...homeF2023, ...homeF2022], homeId);
    const awayFixtures = processFixtures([...awayF2024, ...awayF2023, ...awayF2022], awayId);

    const h2h = h2hRaw.filter(f => f.fixture.status.short === 'FT').slice(0, 15).map(f => ({
      date: f.fixture.date?.slice(0, 10),
      home: f.teams.home.name,
      away: f.teams.away.name,
      score: `${f.goals.home}-${f.goals.away}`,
      totalGoals: (f.goals.home || 0) + (f.goals.away || 0),
      winner: f.goals.home > f.goals.away ? f.teams.home.name : f.goals.away > f.goals.home ? f.teams.away.name : 'Empate'
    }));

    // Compute averages
    const avg = (arr, fn) => arr.length ? (arr.reduce((s, x) => s + fn(x), 0) / arr.length).toFixed(2) : null;
    const homeRecent = homeFixtures.slice(0, 10);
    const awayRecent = awayFixtures.slice(0, 10);
    const homeHome = homeFixtures.filter(f => f.venue === 'home').slice(0, 10);
    const awayAway = awayFixtures.filter(f => f.venue === 'away').slice(0, 10);

    res.json({
      success: true,
      data: {
        home: {
          name: homeName,
          stats: processStats(homeStats),
          recentForm: homeRecent.map(f => f.result).join(''),
          recentFixtures: homeRecent,
          homeFixtures: homeHome,
          avgGoalsFor: avg(homeRecent, f => f.goalsFor),
          avgGoalsAgainst: avg(homeRecent, f => f.goalsAgainst),
          avgGoalsForAtHome: avg(homeHome, f => f.goalsFor),
          avgGoalsAgainstAtHome: avg(homeHome, f => f.goalsAgainst),
          wins: homeRecent.filter(f => f.result === 'W').length,
          draws: homeRecent.filter(f => f.result === 'D').length,
          losses: homeRecent.filter(f => f.result === 'L').length,
        },
        away: {
          name: awayName,
          stats: processStats(awayStats),
          recentForm: awayRecent.map(f => f.result).join(''),
          recentFixtures: awayRecent,
          awayFixtures: awayAway,
          avgGoalsFor: avg(awayRecent, f => f.goalsFor),
          avgGoalsAgainst: avg(awayRecent, f => f.goalsAgainst),
          avgGoalsForAway: avg(awayAway, f => f.goalsFor),
          avgGoalsAgainstAway: avg(awayAway, f => f.goalsAgainst),
          wins: awayRecent.filter(f => f.result === 'W').length,
          draws: awayRecent.filter(f => f.result === 'D').length,
          losses: awayRecent.filter(f => f.result === 'L').length,
        },
        h2h,
        h2hSummary: {
          total: h2h.length,
          homeWins: h2h.filter(f => f.winner === homeName).length,
          awayWins: h2h.filter(f => f.winner === awayName).length,
          draws: h2h.filter(f => f.winner === 'Empate').length,
          avgGoals: avg(h2h, f => f.totalGoals),
          over25: h2h.filter(f => f.totalGoals > 2.5).length,
          btts: h2h.filter(f => {
            const parts = f.score.split('-');
            return parseInt(parts[0]) > 0 && parseInt(parts[1]) > 0;
          }).length
        }
      }
    });

  } catch (err) {
    console.error('gather-data error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Anthropic
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

app.listen(PORT, () => console.log(`✅ ScoutAI v3.0 — porta ${PORT}`));
