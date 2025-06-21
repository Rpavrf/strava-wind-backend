require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const STRAVA_CLIENT_ID = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const STRAVA_REDIRECT_URI = process.env.STRAVA_REDIRECT_URI;
const TOMORROW_API_KEY = process.env.TOMORROW_API_KEY;

const TOKEN_FILE = path.join(__dirname, 'tokens.json');
function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
}
function loadTokens() {
  if (fs.existsSync(TOKEN_FILE)) {
    return JSON.parse(fs.readFileSync(TOKEN_FILE));
  }
  return {};
}
let tokens = loadTokens();

app.get('/auth/strava', (req, res) => {
  const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${STRAVA_REDIRECT_URI}&approval_prompt=force&scope=read,activity:read_all,profile:read_all`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  try {
    const tokenRes = await axios.post('https://www.strava.com/oauth/token', {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code'
    });
    tokens = tokenRes.data;
    saveTokens(tokens);
    res.redirect(`http://localhost:5173/?access_token=${tokens.access_token}`);
  } catch (err) {
    res.status(500).send('Strava authentication failed.');
  }
});

async function ensureAccessTokenValid() {
  if (tokens.expires_at * 1000 < Date.now()) {
    const refreshRes = await axios.post('https://www.strava.com/oauth/token', {
      client_id: STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token
    });
    tokens = refreshRes.data;
    saveTokens(tokens);
  }
}

app.get('/routes', async (req, res) => {
  try {
    await ensureAccessTokenValid();
    const routes = await axios.get('https://www.strava.com/api/v3/athletes/@me/routes', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    res.json(routes.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch routes.' });
  }
});

app.get('/route/:id', async (req, res) => {
  try {
    await ensureAccessTokenValid();
    const { id } = req.params;
    const route = await axios.get(`https://www.strava.com/api/v3/routes/${id}`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    res.json(route.data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch route details.' });
  }
});

function bearing(lat1, lon1, lat2, lon2) {
  const toRad = x => x * Math.PI / 180;
  const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
            Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function windImpact(routeBearing, windDirection, windSpeed) {
  const angleDiff = Math.abs(routeBearing - windDirection);
  const relative = Math.min(angleDiff, 360 - angleDiff);
  const impact = windSpeed * Math.cos(relative * Math.PI / 180);
  return impact;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

app.post('/forecast', async (req, res) => {
  const { coordinates, timeISO } = req.body;
  try {
    const forecasts = [];
    for (let i = 0; i < coordinates.length; i++) {
      const [lat, lon] = coordinates[i];
      const url = `https://api.tomorrow.io/v4/weather/forecast?location=${lat},${lon}&timesteps=1h&apikey=${TOMORROW_API_KEY}`;
      const result = await axios.get(url);
      const hourData = result.data.timelines.hourly.find(d => d.time >= timeISO);
      if (!hourData) continue;
      const windSpeed = hourData.values.windSpeed || 0;
      const windDirection = hourData.values.windDirection || 0;
      const bearingDeg = i < coordinates.length - 1 ? bearing(lat, lon, coordinates[i+1][0], coordinates[i+1][1]) : 0;
      const impact = windImpact(bearingDeg, windDirection, windSpeed);
      forecasts.push({ lat, lon, windSpeed, windDirection, bearing: bearingDeg, impact });
      await sleep(100);
    }
    res.json(forecasts);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch wind forecast.' });
  }
});

app.listen(4000, () => console.log('Backend running on http://localhost:4000'));
