'use strict';
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const { ensureXray } = require('../src/xray');
const { parseVless, buildBatchXrayConfig } = require('../src/vless');
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

(async () => {
  const xrayBin = await ensureXray();
  const uris = JSON.parse(fs.readFileSync('.cache/pool.json', 'utf8'));
  const sample = uris.slice(0, 25).map((u) => parseVless(u)).filter(Boolean);
  const ports = await getFreePorts(sample.length);
  console.log('unique ports:', new Set(ports).size, '/', ports.length);
  const cfg = buildBatchXrayConfig(sample.map((p, i) => ({ port: ports[i], profile: p })));
  const cfgPath = path.join(require('os').tmpdir(), 'ab-debug.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const child = spawn(xrayBin, ['-c', cfgPath, '-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += d.toString()));
  child.on('exit', (code, signal) => {
    console.log('exit code:', code, 'signal:', signal);
    console.log('--- xray output ---');
    console.log(out.slice(0, 3000));
  });
  setTimeout(() => {
    if (child.exitCode === null) {
      console.log('still running after 4s => config OK');
      child.kill();
      setTimeout(() => process.exit(0), 500);
    }
  }, 4000);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
