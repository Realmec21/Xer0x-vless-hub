'use strict';

const fs = require('fs');
const path = require('path');
const { remarkUri } = require('./vless');
const { isWhitelistCandidate } = require('./classify');
const { flag } = require('./geo');

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
    r.uri = remarkUri(r.profile, nickname, flag(r.serverCc), r.badge, r.index);
    r.whitelist = isWhitelistCandidate(r, cfg.whitelist);
  });

  const white = validated.filter((r) => r.whitelist);
  const black = validated.filter((r) => !r.whitelist);
  const fast = validated.filter((r) => r.latencyMs < 300);

  const whitePath = path.join(outDir, 'whitelist.txt');
  const blackPath = path.join(outDir, 'blacklist.txt');
  const fastPath = path.join(outDir, 'fast.txt');

  fs.writeFileSync(whitePath, white.length ? white.map((r) => r.uri).join('\n') + '\n' : '');
  fs.writeFileSync(blackPath, black.length ? black.map((r) => r.uri).join('\n') + '\n' : '');
  fs.writeFileSync(fastPath, fast.length ? fast.map((r) => r.uri).join('\n') + '\n' : '');

  const byCountry = {};
  for (const r of validated) {
    const cc = r.serverCc || '??';
    byCountry[cc] = (byCountry[cc] || 0) + 1;
  }

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
      egress_ip: r.egressIp,
      egress_cc: r.egressCountry || null,
      latency_ms: r.latencyMs,
      public_tls: !!r.hasPublicTls,
      cdn: !!r.isCdn,
      whitelist: !!r.whitelist,
    })),
  };

  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));

  return { whitePath, blackPath, fastPath, white, black, fast, validated };
}

module.exports = { build };
