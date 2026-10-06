'use strict';

const path = require('path');
const fs = require('fs');

const { ensureXray } = require('./xray');
const { collect } = require('./collect');
const { validateAll, checkPublicTls } = require('./validate');
const { resolveHost, looksLikeCdn, lookupCountries, loadCache, flag } = require('./geo');
const { build } = require('./build');
const { recordRun, uptimeOf, shouldRetryDead } = require('./uptime');

function loadConfig(argv) {
  let file = 'config.json';
  const i = argv.indexOf('--config');
  if (i >= 0 && argv[i + 1]) file = argv[i + 1];
  const cfg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), 'utf8'));
  const li = argv.indexOf('--limit');
  if (li >= 0 && argv[li + 1]) cfg.collection.maxConfigs = parseInt(argv[li + 1], 10) || cfg.collection.maxConfigs;
  return cfg;
}

async function pool(items, n, fn) {
  let idx = 0;
  const run = async () => {
    for (;;) {
      const i = idx++;
      if (i >= items.length) break;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, 64)) }, run));
}

async function main() {
  const argv = process.argv.slice(2);
  const cfg = loadConfig(argv);
  const started = Date.now();

  console.log('=== Xer0x-vless-hub ===');

  const xrayBin = await ensureXray();

  const col = await collect(cfg);
  console.log(`[collect] fetched=${col.totalRaw} unique=${col.unique} validating=${col.profiles.length}`);
  if (!col.profiles.length) {
    console.error('[fatal] no profiles collected, keeping previous subscriptions');
    process.exit(1);
  }

  const results = await validateAll(col.profiles, xrayBin, cfg.validation || {}, (done, total, res) => {
    if (done % 10 === 0 || done === total || res.ok) {
      console.log(`[validate] ${done}/${total} ok=${res.ok ? 'Y' : 'n'}`);
    }
  });

  const history = recordRun(col.profiles, results);
  const records = results.map((r, i) => {
    const p = col.profiles[i];
    const key = `${p.uuid}@${p.host}:${p.port}`;
    return { ...r, profile: p, uptime: uptimeOf(history, key) };
  });

  const okRecords = records.filter((r) => r.ok);
  const viaIg = okRecords.filter((r) => String(r.checkedVia || '').includes('instagram')).length;
  const viaYt = okRecords.filter((r) => String(r.checkedVia || '').includes('youtube')).length;
  console.log(`[validate] done: ${okRecords.length}/${records.length} alive (instagram=${viaIg}, youtube=${viaYt})`);
  if (!okRecords.length) {
    console.error('[fatal] nothing validated, keeping previous subscriptions');
    process.exit(1);
  }

  const hosts = [...new Set(okRecords.map((r) => r.profile.host))];
  const hostIps = new Map();
  await pool(hosts, 30, async (h) => {
    hostIps.set(h, await resolveHost(h));
  });

  await lookupCountries([...hostIps.values()].flat(), cfg.geo || {});
  const geoCache = loadCache();

  await pool(okRecords, 20, async (r) => {
    const ips = hostIps.get(r.profile.host) || [];
    r.serverIps = ips;
    const ip = ips[0];
    r.serverCc = ip && geoCache[ip] && geoCache[ip].cc ? geoCache[ip].cc : '';
    r.serverCountry = ip && geoCache[ip] ? geoCache[ip].country : '';
    if (!r.serverCc) r.serverCc = r.egressCountry || '';
    r.hasPublicTls = await checkPublicTls(
      r.profile.host,
      r.profile.port,
      r.profile.sni || r.profile.host,
      ips
    );
    r.isCdn = await looksLikeCdn(r.profile.host);
    r.flag = flag(r.serverCc);
  });

  const out = build(records, cfg, col);
  const secs = Math.round((Date.now() - started) / 1000);
  const speeds = out.validated.filter((r) => r.speedMbps);
  const avgSpeed = speeds.length ? (speeds.reduce((s, r) => s + r.speedMbps, 0) / speeds.length).toFixed(1) : 'n/a';
  console.log(`[build] whitelist=${out.white.length} blacklist=${out.black.length} fast=${out.fast.length} avg_speed=${avgSpeed}Mbps (${secs}s)`);
  console.log(`[build] ${cfg.outputDir}/whitelist.txt, blacklist.txt, fast.txt, clash.yaml, sing-box.json, report.json`);
}

main().catch((e) => {
  console.error('[fatal]', e && e.stack ? e.stack : e);
  process.exit(1);
});
