'use strict';
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { ensureXray } = require('../src/xray');
const { parseVless } = require('../src/vless');

(async () => {
  const xrayBin = await ensureXray();
  const count = parseInt(process.argv[2] || '10', 10);
  const lines = fs.readFileSync('subscriptions/whitelist.txt', 'utf8').split(/\r?\n/).filter(Boolean).slice(0, count);
  const opts = { timeoutSec: 8, retry: 0 };
  const { validateAll } = require('../src/validate');
  const started = Date.now();
  const pairs = lines.map((l) => ({ l, p: parseVless(l) })).filter((x) => x.p);
  const results = await validateAll(pairs.map((x) => x.p), xrayBin, opts);
  let alive = 0;
  let fast = 0;
  for (let i = 0; i < pairs.length; i++) {
    const res = results[i];
    const tag = pairs[i].l.split('#').pop().slice(0, 40);
    if (res.ok) {
      alive++;
      if (res.latencyMs < 300) fast++;
      console.log(`${i + 1}. ALIVE ${res.latencyMs}ms speed=${res.speedMbps || '-'}Mbps ip=${res.egressIp} | ${tag}`);
    } else {
      console.log(`${i + 1}. DEAD ${String(res.error).slice(0, 110)} | ${tag}`);
    }
  }
  console.log(`\n=== ${alive}/${pairs.length} alive, ${fast} fast <300ms, ${Math.round((Date.now() - started) / 1000)}s ===`);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
