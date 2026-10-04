'use strict';

const { fetchText } = require('./http');
const { parseVless, dedupeKey } = require('./vless');

const VLESS_RE = /vless:\/\/[^\s"'<>\\]+/gi;

function tryBase64(s) {
  try {
    const t = s.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/]+=*$/.test(t) || t.length < 40) return null;
    const buf = Buffer.from(t, 'base64');
    if (!buf.length) return null;
    const text = buf.toString('utf8');
    if (!/[\x20-\x7E]/.test(text.slice(0, 200))) return null;
    return text;
  } catch (e) {
    return null;
  }
}

function extractFromText(text) {
  const out = new Set();
  const scan = (t) => {
    let m;
    VLESS_RE.lastIndex = 0;
    while ((m = VLESS_RE.exec(t)) !== null) out.add(m[0].trim());
  };

  scan(text);

  if (out.size === 0) {
    const dec = tryBase64(text.trim());
    if (dec) scan(dec);
  }

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (s.length < 40 || s.length > 4000 || !/^[A-Za-z0-9+/=]+$/.test(s)) continue;
    const dec = tryBase64(s);
    if (dec && dec.includes('vless://')) scan(dec);
    if (out.size > 20000) break;
  }

  return [...out];
}

async function collect(cfg) {
  const c = cfg.collection || {};
  const timeoutMs = (c.timeoutSec || 25) * 1000;
  const maxBytes = c.maxBytes || 41943040;
  const sources = cfg.sources || [];
  const stats = [];
  const seen = new Map();
  let totalRaw = 0;

  for (const url of sources) {
    try {
      const text = await fetchText(url, { timeoutMs, maxBytes: maxBytes + 1024 });
      const found = extractFromText(text);
      let added = 0;
      for (const uri of found) {
        const p = parseVless(uri);
        if (!p) continue;
        totalRaw++;
        const key = dedupeKey(p);
        if (!seen.has(key)) {
          seen.set(key, p);
          added++;
        }
      }
      stats.push({ url, ok: true, found: found.length, added });
      console.log(`[collect] ${url} -> ${found.length} vless, +${added} new`);
    } catch (e) {
      stats.push({ url, ok: false, error: String(e.message || e) });
      console.log(`[collect] FAILED ${url}: ${e.message || e}`);
    }
  }

  let profiles = [...seen.values()];
  const beforeEndpoint = profiles.length;
  if (c.dedupeByEndpoint) {
    const byEndpoint = new Map();
    for (const p of profiles) {
      const ek = `${p.uuid}@${p.host}:${p.port}`;
      if (!byEndpoint.has(ek)) byEndpoint.set(ek, p);
    }
    profiles = [...byEndpoint.values()];
    if (profiles.length !== beforeEndpoint) {
      console.log(`[collect] endpoint dedupe: ${beforeEndpoint} -> ${profiles.length}`);
    }
  }
  const maxConfigs = c.maxConfigs || 500;
  if (c.shuffle) {
    for (let i = profiles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [profiles[i], profiles[j]] = [profiles[j], profiles[i]];
    }
  }
  if (profiles.length > maxConfigs) profiles = profiles.slice(0, maxConfigs);

  return { profiles, stats, totalRaw, unique: seen.size };
}

module.exports = { collect, extractFromText };
