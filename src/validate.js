'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildXrayConfig } = require('./vless');
const { measureSpeed } = require('./speedtest');

const execFileAsync = promisify(execFile);

const TRACE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';
const CHECK_DEFAULT_URLS = ['https://www.instagram.com/robots.txt', 'https://www.youtube.com/robots.txt'];
const DEVNULL = process.platform === 'win32' ? 'NUL' : '/dev/null';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function waitPort(port, timeoutMs, child) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const attempt = () => {
      if (child && child.exitCode !== null) {
        return reject(new Error(`xray exited early (code ${child.exitCode})`));
      }
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - started > timeoutMs) reject(new Error('xray inbound did not start'));
        else setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}

function parseTrace(body, timeLine) {
  const kv = {};
  for (const line of body.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) kv[line.slice(0, i)] = line.slice(i + 1);
  }
  const latencyMs = Math.round(parseFloat(timeLine) * 1000);
  if (!kv.ip) throw new Error('no egress ip in trace');
  return { egressIp: kv.ip, egressCountry: (kv.loc || '').toUpperCase(), latencyMs: Number.isFinite(latencyMs) ? latencyMs : 0 };
}

async function curlThrough(port, timeoutSec) {
  const args = [
    '-sS',
    '-x', `http://127.0.0.1:${port}`,
    '--max-time', String(timeoutSec),
    '--connect-timeout', String(timeoutSec),
    '-w', '\n%{time_total}',
    TRACE_URL,
  ];
  let stdout = '';
  let stderr = '';
  let code = 0;
  try {
    const res = await execFileAsync('curl', args, { maxBuffer: 1024 * 1024 });
    stdout = res.stdout;
    stderr = res.stderr || '';
  } catch (e) {
    stdout = (e.stdout || '') + '';
    stderr = (e.stderr || '') + '';
    code = e.code || 1;
    if (typeof code !== 'number') code = 1;
  }
  if (code !== 0) {
    throw new Error(`curl exit ${code}: ${stderr.trim().slice(0, 160) || stdout.trim().slice(0, 160)}`);
  }
  const nl = stdout.lastIndexOf('\n');
  if (nl < 0) throw new Error('empty response');
  const body = stdout.slice(0, nl);
  const timeLine = stdout.slice(nl + 1).trim();
  return parseTrace(body, timeLine);
}

async function checkUrlsThrough(port, timeoutSec, urls) {
  const list = Array.isArray(urls) && urls.length ? urls : CHECK_DEFAULT_URLS;
  const results = [];
  const errors = [];
  let bestMs = null;
  for (const url of list) {
    let host = url;
    try {
      host = new URL(url).hostname;
    } catch (e) {}
    const args = [
      '-sS',
      '-x', `http://127.0.0.1:${port}`,
      '--max-time', String(timeoutSec),
      '--connect-timeout', String(timeoutSec),
      '-o', DEVNULL,
      '-w', '%{time_total}',
      url,
    ];
    let stdout = '';
    let stderr = '';
    let code = 0;
    try {
      const res = await execFileAsync('curl', args, { maxBuffer: 1024 });
      stdout = res.stdout || '';
      stderr = res.stderr || '';
    } catch (e) {
      stdout = (e.stdout || '') + '';
      stderr = (e.stderr || '') + '';
      code = e.code || 1;
      if (typeof code !== 'number') code = 1;
    }
    if (code !== 0) {
      errors.push(`${host}: curl exit ${code}: ${stderr.trim().slice(0, 120) || stdout.trim().slice(0, 120)}`);
      results.push({ host, ok: false });
      continue;
    }
    const secs = parseFloat(stdout.trim());
    if (!Number.isFinite(secs) || secs < 0) {
      errors.push(`${host}: bad time output`);
      results.push({ host, ok: false });
      continue;
    }
    const ms = Math.round(secs * 1000);
    results.push({ host, ok: true, ms });
    if (bestMs === null || ms < bestMs) bestMs = ms;
  }
  return { alive: results.some((r) => r.ok), latencyMs: bestMs, results, error: errors.join(' | ') };
}

async function validateProfile(p, xrayBin, opts) {
  const timeoutSec = opts.timeoutSec || 9;
  const retry = opts.retry || 0;
  let lastErr = 'unknown';
  for (let attempt = 0; attempt <= retry; attempt++) {
    let port;
    let cfgPath;
    let child = null;
    const errChunks = [];
    try {
      port = await getFreePort();
      cfgPath = path.join(os.tmpdir(), `xh-${process.pid}-${port}-${Date.now()}.json`);
      fs.writeFileSync(cfgPath, JSON.stringify(buildXrayConfig(port, p)));
      child = spawn(xrayBin, ['-c', cfgPath, '-format', 'json'], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      child.stderr.on('data', (d) => {
        errChunks.push(d.toString());
        if (errChunks.length > 40) errChunks.shift();
      });
      child.on('error', () => {});
      await waitPort(port, 4000, child);
      const checks = await checkUrlsThrough(port, timeoutSec, opts.checkUrls);
      if (!checks.alive) throw new Error(checks.error || 'all checks failed');
      let egressIp = '';
      let egressCountry = '';
      try {
        const trace = await curlThrough(port, timeoutSec);
        if (trace.egressIp) {
          egressIp = trace.egressIp;
          egressCountry = trace.egressCountry;
        }
      } catch (e) {}
      const speedMbps = await measureSpeed(port);
      if (child.exitCode === null) {
        try {
          child.kill();
        } catch (e) {}
      }
      const passed = checks.results.filter((r) => r.ok).map((r) => r.host).join(',');
      return { ok: true, latencyMs: checks.latencyMs, egressIp, egressCountry, speedMbps, checkedVia: passed };
    } catch (e) {
      lastErr = String(e.message || e);
      const tail = errChunks.join('').trim().slice(-200);
      if (tail && !lastErr.includes(tail.slice(0, 30))) lastErr += ` | xray: ${tail}`;
    } finally {
      if (child && child.exitCode === null) {
        try {
          child.kill();
        } catch (e) {}
      }
      if (cfgPath) {
        try {
          fs.unlinkSync(cfgPath);
        } catch (e) {}
      }
    }
  }
  return { ok: false, error: lastErr };
}

async function validateAll(profiles, xrayBin, opts, onProgress) {
  const results = new Array(profiles.length);
  let idx = 0;
  let done = 0;
  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= profiles.length) break;
      results[i] = await validateProfile(profiles[i], xrayBin, opts);
      done++;
      if (onProgress) onProgress(done, profiles.length, results[i]);
    }
  };
  const n = Math.max(1, Math.min(opts.concurrency || 8, 32));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

function checkPublicTls(host, port, servername, ips, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    let name = servername || host;
    let skipIdentity = false;
    if (net.isIP(name)) {
      skipIdentity = true;
      name = undefined;
    }
    const targets = ips && ips.length ? ips : [host];
    const tryAt = (i) => {
      if (i >= targets.length) return finish(false);
      let sock;
      try {
        sock = tls.connect({
          host: targets[i],
          port,
          servername: name,
          rejectUnauthorized: false,
          timeout: timeoutMs,
        });
      } catch (e) {
        return finish(false);
      }
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          sock.destroy();
        } catch (e) {}
        finish(false);
      }, timeoutMs + 500);
      const next = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        tryAt(i + 1);
      };
      sock.once('secureConnect', () => {
        if (settled) return;
        let ok = false;
        try {
          const cert = sock.getPeerCertificate();
          ok = sock.authorized === true;
          if (ok && !skipIdentity && cert) {
            ok = !tls.checkServerIdentity(servername || host, cert);
          }
        } catch (e) {
          ok = false;
        }
        settled = true;
        clearTimeout(timer);
        try {
          sock.end();
          sock.destroy();
        } catch (e) {}
        if (ok) finish(true);
        else tryAt(i + 1);
      });
      sock.once('error', next);
    };
    tryAt(0);
  });
}

module.exports = { validateAll, validateProfile, checkPublicTls };
