'use strict';

const fs = require('fs');
const path = require('path');
const { remarkUri } = require('./vless');
const { isWhitelistCandidate } = require('./classify');
const { flag } = require('./geo');
const { buildClashFile, buildSingBoxFile, buildClashAutoFile, buildXrayAutoConfig } = require('./formats');

function speedBadge(latencyMs) {
  if (latencyMs < 300) return '⚡';
  if (latencyMs < 500) return '🔵';
  return '🔴';
}

function build(records, cfg, collectionStats) {
  const nickname = cfg.nickname || 'Xer0x';
  const outDir = path.resolve(process.cwd(), cfg.outputDir || 'subscriptions');
  fs.mkdirSync(outDir, { recursive: true });

  const validated = records
    .filter((r) => r.ok)
    .sort((a, b) => a.latencyMs - b.latencyMs);

  validated.forEach((r, i) => {
    r.index = i + 1;
    r.badge = speedBadge(r.latencyMs);
    r.flag = flag(r.serverCc);
    const speedPart = r.speedMbps ? ` ~${r.speedMbps}Mbps` : '';
    r.remark = [r.badge, r.flag, speedPart.trim(), `${nickname}-${String(r.index).padStart(2, '0')}`].filter(Boolean).join(' ');
    r.uri = remarkUri(r.profile, r.remark);
    r.whitelist = isWhitelistCandidate(r, cfg.whitelist);
  });

  const white = validated.filter((r) => r.whitelist);
  const black = validated.filter((r) => !r.whitelist);
  const fast = validated.filter((r) => r.latencyMs < 300);

  fs.writeFileSync(path.join(outDir, 'whitelist.txt'), white.length ? white.map((r) => r.uri).join('\n') + '\n' : '');
  fs.writeFileSync(path.join(outDir, 'blacklist.txt'), black.length ? black.map((r) => r.uri).join('\n') + '\n' : '');
  fs.writeFileSync(path.join(outDir, 'fast.txt'), fast.length ? fast.map((r) => r.uri).join('\n') + '\n' : '');

  const allUris = validated.map((r) => r.uri);
  fs.writeFileSync(path.join(outDir, 'all.txt'), allUris.length ? allUris.join('\n') + '\n' : '');
  fs.writeFileSync(path.join(outDir, 'all.base64.txt'), allUris.length ? Buffer.from(allUris.join('\n'), 'utf8').toString('base64') + '\n' : '');

  const pCfg = cfg.profiles || {};
  const wifiMax = (pCfg.wifi && pCfg.wifi.maxLatencyMs) || 500;
  const lteMax = (pCfg.lte && pCfg.lte.maxLatencyMs) || 800;
  const lteFromWhitelist = !pCfg.lte || pCfg.lte.fromWhitelist !== false;
  let wifiPool = validated.filter((r) => r.latencyMs < wifiMax);
  let ltePool = (lteFromWhitelist ? validated.filter((r) => r.whitelist) : validated).filter((r) => r.latencyMs < lteMax);
  if (wifiPool.length < 5) wifiPool = validated.slice(0, Math.min(20, validated.length));
  if (ltePool.length < 5) ltePool = white.slice(0, Math.min(20, white.length));
  if (!ltePool.length) ltePool = validated.slice(0, Math.min(20, validated.length));

  fs.writeFileSync(path.join(outDir, 'wifi.yaml'), buildClashAutoFile(wifiPool, 'WiFi'));
  fs.writeFileSync(path.join(outDir, 'lte.yaml'), buildClashAutoFile(ltePool, 'LTE'));
  fs.writeFileSync(path.join(outDir, 'lte.json'), buildXrayAutoConfig(ltePool, 'lte'));
  fs.writeFileSync(path.join(outDir, 'wifi.json'), buildXrayAutoConfig(wifiPool, 'wifi'));
  fs.writeFileSync(
    path.join(outDir, 'auto.txt'),
    buildXrayAutoConfig(ltePool, 'lte').trimEnd() + '\n####\n' + buildXrayAutoConfig(wifiPool, 'wifi').trimEnd() + '\n'
  );

  fs.writeFileSync(path.join(outDir, 'clash.yaml'), buildClashFile(validated));
  fs.writeFileSync(path.join(outDir, 'sing-box.json'), buildSingBoxFile(validated));

  const byCountry = {};
  for (const r of validated) {
    const cc = r.serverCc || '??';
    byCountry[cc] = (byCountry[cc] || 0) + 1;
  }

  const speeds = validated.filter((r) => r.speedMbps !== null && r.speedMbps !== undefined);
  const avgSpeed = speeds.length ? Math.round(speeds.reduce((s, r) => s + r.speedMbps, 0) / speeds.length * 10) / 10 : null;
  const avgLatency = validated.length ? Math.round(validated.reduce((s, r) => s + r.latencyMs, 0) / validated.length) : null;

  const report = {
    generated_at: new Date().toISOString(),
    nickname,
    totals: {
      fetched: collectionStats ? collectionStats.totalRaw : 0,
      unique: collectionStats ? collectionStats.unique : 0,
      validated: validated.length,
      failed: records.length - validated.length,
      whitelist: white.length,
      blacklist: black.length,
      fast: fast.length,
      all: validated.length,
      wifi_profile: wifiPool.length,
      lte_profile: ltePool.length,
      avg_latency_ms: avgLatency,
      avg_speed_mbps: avgSpeed,
    },
    sources: collectionStats ? collectionStats.sources : [],
    whitelist_criteria: cfg.whitelist || {},
    top_countries: Object.entries(byCountry)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([cc, n]) => ({ cc, count: n })),
    profiles: validated.map((r) => ({
      idx: r.index,
      host: r.profile.host,
      port: r.profile.port,
      type: r.profile.type,
      security: r.profile.security || 'none',
      server_cc: r.serverCc || null,
      server_country: r.serverCountry || null,
      egress_ip: r.egressIp || null,
      egress_cc: r.egressCountry || null,
      check: r.checkedVia || null,
      latency_ms: r.latencyMs,
      speed_mbps: r.speedMbps || null,
      uptime: r.uptime !== undefined ? r.uptime : null,
      public_tls: !!r.hasPublicTls,
      cdn: !!r.isCdn,
      whitelist: !!r.whitelist,
      fast: r.latencyMs < 300,
    })),
  };

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  const docsRoot = path.resolve(process.cwd(), 'docs');
  if (fs.existsSync(path.join(docsRoot, 'index.html'))) {
    const docsOut = path.join(docsRoot, 'subscriptions');
    fs.mkdirSync(docsOut, { recursive: true });
    for (const f of fs.readdirSync(outDir)) {
      const src = path.join(outDir, f);
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(docsOut, f));
    }
  }

  return { white, black, fast, validated, wifiPool, ltePool };
}

module.exports = { build };
