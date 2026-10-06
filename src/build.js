'use strict';

const fs = require('fs');
const path = require('path');
const { remarkUri } = require('./vless');
const { isWhitelistCandidate } = require('./classify');
const { flag } = require('./geo');
const { buildClashFile, buildSingBoxFile } = require('./formats');

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

  return { white, black, fast, validated };
}

module.exports = { build };
