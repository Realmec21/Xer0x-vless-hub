'use strict';
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { ensureXray } = require('../src/xray');
const { collect } = require('../src/collect');
const { parseVless } = require('../src/vless');
const { validateAll } = require('../src/validate');

(async () => {
  const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  const xrayBin = await ensureXray();
  const poolPath = '.cache/pool.json';
  let uris;
  if (fs.existsSync(poolPath) && process.argv[2] !== 'fresh') {
    uris = JSON.parse(fs.readFileSync(poolPath, 'utf8'));
    console.log(`[pool] loaded ${uris.length} from cache`);
  } else {
    const col = await collect(cfg);
    uris = [...col.profiles.map((p) => p.raw)];
    fs.mkdirSync('.cache', { recursive: true });
    fs.writeFileSync(poolPath, JSON.stringify(uris));
    console.log(`[pool] saved ${uris.length}`);
  }
  const n = parseInt(process.argv[2] || '60', 10) || 60;
  const shuffled = uris.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const sample = shuffled.slice(0, n).map((u) => parseVless(u)).filter(Boolean);
  console.log(`[ab] sample=${sample.length}`);

  const opts = { timeoutSec: 9, concurrency: 10, retry: 0, batchSize: 40, tcpTimeoutMs: 2500 };

  console.log('[ab] batch run...');
  let t = Date.now();
  const batchRes = await validateAll(sample, xrayBin, { ...opts });
  const batchAlive = batchRes.filter((r) => r.ok).length;
  console.log(`[ab] batch: ${batchAlive}/${sample.length} alive in ${Math.round((Date.now() - t) / 1000)}s`);

  console.log('[ab] individual run...');
  t = Date.now();
  const indRes = await validateAll(sample, xrayBin, { ...opts, noBatch: true });
  const indAlive = indRes.filter((r) => r.ok).length;
  console.log(`[ab] individual: ${indAlive}/${sample.length} alive in ${Math.round((Date.now() - t) / 1000)}s`);

  let batchOnly = 0;
  let indOnly = 0;
  let both = 0;
  const disagreements = [];
  for (let i = 0; i < sample.length; i++) {
    const b = batchRes[i].ok;
    const d = indRes[i].ok;
    if (b && d) both++;
    else if (b && !d) batchOnly++;
    else if (!b && d) {
      indOnly++;
      disagreements.push(`${i}: IND-ALIVE(${indRes[i].latencyMs}ms) batchErr=${String(batchRes[i].error).slice(0, 80)}`);
    }
  }
  console.log(`[ab] both=${both} batchOnly=${batchOnly} individualOnly=${indOnly}`);
  disagreements.slice(0, 25).forEach((d) => console.log('  ' + d));
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
