require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AI_KEY = () => process.env.ANTHROPIC_KEY || '';

// ── Search teams via Claude knowledge ────────────────────────────
app.get('/api/search-team', async (req, res) => {
  try {
    const { name } = req.query;
    if (!name || name.length < 2) return res.json([]);

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': AI_KEY(),
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: `Responds ONLY with a JSON array, no markdown, no extra text.`,
        messages: [{
          role: 'user',
          content: `List up to 8 real football teams whose name contains "${name}". Return JSON array:
[{"id":1,"name":"Full Team Name","shortName":"Short","country":"Country","competition":"Main League"}]
Use sequential numbers as id. Only real teams. If none found return [].`
        }]
      })
    });

    const data = await r.json();
    const raw = data.content?.map(b => b.text || '').join('') || '[]';
    const teams = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json(teams);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Full analysis via Claude ──────────────────────────────────────
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

app.listen(PORT, () => console.log(`✅ ScoutAI v3.0 (Claude-powered) — porta ${PORT}`));
