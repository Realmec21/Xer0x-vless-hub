'use strict';
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { ensureXray } = require('../src/xray');
const { parseVless, buildBatchXrayConfig, sanitizeProfile } = require('../src/vless');
const { spawn } = require('child_process');
const net = require('net');

function getFreePorts(n) {
  return new Promise((resolve, reject) => {
    const servers = [];
    for (let i = 0; i < n; i++) {
      const srv = net.createServer();
      srv.once('error', reject);
      servers.push(srv);
      srv.listen(0, '127.0.0.1', () => {
        if (servers.filter((s) => s.listening).length === n) {
          const ports = servers.map((s) => s.address().port);
          servers.forEach((s) => s.close());
          resolve(ports);
        }
      });
    }
  });
}

function runOnce(xrayBin, sample) {
  return new Promise(async (resolve) => {
    const ports = await getFreePorts(sample.length);
    const uniq = new Set(ports).size === ports.length;
    const cfg = buildBatchXrayConfig(sample.map((p, i) => ({ port: ports[i], profile: p })));
    const cfgPath = path.join(require('os').tmpdir(), `stress-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    const child = spawn(xrayBin, ['-c', cfgPath, '-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (out += d.toString()));
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null) child.kill();
      try { fs.unlinkSync(cfgPath); } catch (e) {}
      resolve({ ...result, uniq });
    };
    child.on('error', (e) => done({ code: 'spawn-err', msg: String(e) }));
    child.on('exit', (code, signal) => {
      const first = out.split('\n').filter((l) => /error|failed|cannot|listen/i.test(l)).slice(0, 3);
      done({ code, signal, errLines: first });
    });
    setTimeout(() => done({ code: 'OK-running' }), 3500);
  });
}

(async () => {
  const xrayBin = await ensureXray();
  const uris = JSON.parse(fs.readFileSync('.cache/pool.json', 'utf8'));
  for (let round = 1; round <= 10; round++) {
    const shuffled = uris.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const sample = shuffled
      .slice(0, 25)
      .map((u) => parseVless(u))
      .filter(Boolean)
      .map((p) => sanitizeProfile(p))
      .filter((s) => !s.error)
      .map((s) => s.p);
    const r = await runOnce(xrayBin, sample);
    console.log(`round ${round}: code=${r.code} signal=${r.signal || '-'} uniqPorts=${r.uniq} ${r.errLines ? JSON.stringify(r.errLines) : ''}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
