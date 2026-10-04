'use strict';

const fs = require('fs');
const path = require('path');

const HISTORY_FILE = path.join(process.cwd(), '.cache', 'history.json');
const ALIVE_GRACE = 3;

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveHistory(h) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(h));
  } catch (e) {}
}

function recordRun(profiles, results) {
  const h = loadHistory();
  const now = Date.now();
  const seen = new Set();
  for (let i = 0; i < profiles.length; i++) {
    const p = profiles[i];
    const r = results[i];
    const key = `${p.uuid}@${p.host}:${p.port}`;
    seen.add(key);
    if (!h[key]) h[key] = { first: now, alive: 0, total: 0, lastAlive: 0 };
    h[key].total++;
    if (r.ok) {
      h[key].alive++;
      h[key].lastAlive = now;
    }
  }
  const stale = [];
  for (const k of Object.keys(h)) {
    if (!seen.has(k)) {
      if (now - (h[k].lastAlive || h[k].first) > 7 * 24 * 3600 * 1000) stale.push(k);
    }
  }
  for (const k of stale) delete h[k];
  saveHistory(h);
  return h;
}

function uptimeOf(h, key) {
  const e = h[key];
  if (!e || !e.total) return 0;
  return Math.round((e.alive / e.total) * 100);
}

function shouldRetryDead(h, key) {
  const e = h[key];
  if (!e) return false;
  if (e.total < 3 && e.alive === 0) return false;
  if (e.alive > 0) return true;
  return e.total < ALIVE_GRACE;
}

module.exports = { loadHistory, saveHistory, recordRun, uptimeOf, shouldRetryDead };