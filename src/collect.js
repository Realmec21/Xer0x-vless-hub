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
  const stats = new Array(sources.length);
  const seen = new Map();
  let totalRaw = 0;

  let idx = 0;
  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= sources.length) break;
      const url = sources[i];
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 1500));
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
              seen.set(key, { p, url });
              added++;
            }
          }
          stats[i] = { url, ok: true, found: found.length, added };
          console.log(`[collect] ${url} -> ${found.length} vless, +${added} new`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
        }
      }
      if (lastErr) {
        stats[i] = { url, ok: false, error: String(lastErr.message || lastErr) };
        console.log(`[collect] FAILED ${url}: ${lastErr.message || lastErr}`);
      }
    }
  };
  const n = Math.max(1, Math.min(c.concurrency || 8, 16));
  await Promise.all(Array.from({ length: n }, () => worker()));

  let entries = [...seen.values()];
  const beforeEndpoint = entries.length;
  if (c.dedupeByEndpoint) {
    const byEndpoint = new Map();
    for (const e of entries) {
      const ek = `${e.p.uuid}@${e.p.host}:${e.p.port}`;
      if (!byEndpoint.has(ek)) byEndpoint.set(ek, e);
    }
    entries = [...byEndpoint.values()];
    if (entries.length !== beforeEndpoint) {
      console.log(`[collect] endpoint dedupe: ${beforeEndpoint} -> ${entries.length}`);
    }
  }

  const shuffleArr = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };

  const maxConfigs = c.maxConfigs || 500;
  let picked;
  if (c.sourceQuota) {
    const bySrc = new Map();
    for (const e of entries) {
      if (!bySrc.has(e.url)) bySrc.set(e.url, []);
      bySrc.get(e.url).push(e);
    }
    const pools = [...bySrc.values()].map(shuffleArr);
    picked = [];
    for (let round = 0; picked.length < maxConfigs; round++) {
      let addedAny = false;
      for (const pool of pools) {
        if (round < pool.length) {
          picked.push(pool[round]);
          addedAny = true;
          if (picked.length >= maxConfigs) break;
        }
      }
      if (!addedAny) break;
    }
    console.log(`[collect] source quota: ${pools.length} sources, picked ${picked.length} of ${entries.length}`);
  } else {
    picked = shuffleArr(entries).slice(0, maxConfigs);
  }
  const profiles = picked.map((e) => e.p);

  return { profiles, stats, totalRaw, unique: seen.size };
}

module.exports = { collect, extractFromText };
