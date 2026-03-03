require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── API Football proxy ──────────────────────────────────────────
app.get('/api/football/*', async (req, res) => {
  const endpoint = req.path.replace('/api/football', '');
  const query = new URLSearchParams(req.query).toString();
  const url = `https://v3.football.api-sports.io${endpoint}${query ? '?' + query : ''}`;

  const apiKey = process.env.API_FOOTBALL_KEY || req.headers['x-football-key'] || '';

  try {
    const response = await fetch(url, {
      headers: {
        'x-apisports-key': apiKey,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Anthropic proxy ─────────────────────────────────────────────
app.post('/api/analyze', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fallback ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`✅ ScoutAI a correr em http://localhost:${PORT}`);
});
