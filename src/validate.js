'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildXrayConfig, buildBatchXrayConfig, sanitizeProfile } = require('./vless');
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

function getFreePorts(n) {
  return new Promise((resolve, reject) => {
    const servers = [];
    let failed = false;
    const err = (e) => {
      if (failed) return;
      failed = true;
      servers.forEach((s) => {
        try {
          s.close();
        } catch (e2) {}
      });
      reject(e);
    };
    for (let i = 0; i < n; i++) {
      const srv = net.createServer();
      srv.once('error', err);
      servers.push(srv);
      srv.listen(0, '127.0.0.1', () => {
        if (failed) return;
        if (servers.filter((s) => s.listening).length === n) {
          const ports = servers.map((s) => s.address().port);
          servers.forEach((s) => s.close());
          resolve(ports);
        }
      });
    }
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

function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch (e) {}
      resolve(ok);
    };
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => done(false), timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function isTcpProbeSkipped(p) {
  const t = (p.type || 'tcp').toLowerCase();
  return t === 'kcp' || t === 'quic';
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
  const checkOne = async (url) => {
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
      return { host, ok: false, code, error: `${host}: curl exit ${code}: ${stderr.trim().slice(0, 120) || stdout.trim().slice(0, 120)}` };
    }
    const secs = parseFloat(stdout.trim());
    if (!Number.isFinite(secs) || secs < 0) {
      return { host, ok: false, code, error: `${host}: bad time output` };
    }
    return { host, ok: true, ms: Math.round(secs * 1000) };
  };
  const results = await Promise.all(list.map(checkOne));
  const errors = results.filter((r) => !r.ok && r.error).map((r) => r.error);
  const okMs = results.filter((r) => r.ok).map((r) => r.ms);
  const bestMs = okMs.length ? Math.min(...okMs) : null;
  const failedAllLocal = results.length > 0 && results.every((r) => !r.ok && r.code === 7);
  return { alive: results.some((r) => r.ok), latencyMs: bestMs, results, error: errors.join(' | '), localDown: failedAllLocal };
}

async function probeThrough(port, timeoutSec, opts) {
  const checks = await checkUrlsThrough(port, timeoutSec, opts.checkUrls);
  if (!checks.alive) {
    const err = new Error(checks.error || 'all checks failed');
    err.localDown = !!checks.localDown;
    throw err;
  }
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
  const passed = checks.results.filter((r) => r.ok).map((r) => r.host).join(',');
  return { ok: true, latencyMs: checks.latencyMs, egressIp, egressCountry, speedMbps, checkedVia: passed };
}

async function validateProfile(p, xrayBin, opts) {
  const san = sanitizeProfile(p);
  if (san.error) return { ok: false, error: san.error };
  p = san.p;
  const timeoutSec = opts.timeoutSec || 9;
  const retry = opts.retry || 0;
  const tcpTimeoutMs = opts.tcpTimeoutMs || 2500;
  if (!isTcpProbeSkipped(p) && !(await tcpProbe(p.host, p.port, tcpTimeoutMs))) {
    return { ok: false, error: `tcp unreachable ${p.host}:${p.port}` };
  }
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
      const res = await probeThrough(port, timeoutSec, opts);
      if (child.exitCode === null) {
        try {
          child.kill();
        } catch (e) {}
      }
      return res;
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

async function validateBatch(items, xrayBin, opts) {
  const timeoutSec = opts.timeoutSec || 9;
  const ports = await getFreePorts(items.length);
  const cfgPath = path.join(os.tmpdir(), `xh-b-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(buildBatchXrayConfig(items.map((it, i) => ({ port: ports[i], profile: it.p })))));
  const errChunks = [];
  const child = spawn(xrayBin, ['-c', cfgPath, '-format', 'json'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    errChunks.push(d.toString());
    if (errChunks.length > 40) errChunks.shift();
  });
  child.on('error', () => {});
  try {
    await Promise.all(ports.map((port) => waitPort(port, 6000, child)));
    const results = new Array(items.length);
    let idx = 0;
    const worker = async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) break;
        try {
          results[i] = await probeThrough(ports[i], timeoutSec, opts);
        } catch (e) {
          results[i] = { ok: false, error: String(e.message || e), localDown: !!e.localDown };
        }
      }
    };
    const n = Math.max(1, Math.min(opts.concurrency || 8, 32));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
  } catch (e) {
    const tail = errChunks.join('').trim().slice(-300);
    if (tail) e.message = `${e.message} | xray: ${tail}`;
    throw e;
  } finally {
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch (e) {}
    }
    try {
      fs.unlinkSync(cfgPath);
    } catch (e) {}
  }
}

async function tcpPrefilter(profiles, opts, onReach) {
  const tcpTimeoutMs = opts.tcpTimeoutMs || 2500;
  const reachable = new Array(profiles.length);
  let idx = 0;
  const worker = async () => {
    for (;;) {
      const i = idx++;
      if (i >= profiles.length) break;
      const p = profiles[i];
      reachable[i] = isTcpProbeSkipped(p) ? true : await tcpProbe(p.host, p.port, tcpTimeoutMs);
      if (reachable[i] && onReach) onReach(i);
    }
  };
  const n = Math.max(1, Math.min(opts.tcpConcurrency || 128, 256));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return reachable;
}

async function validateAll(profiles, xrayBin, opts, onProgress) {
  const results = new Array(profiles.length);
  const batchSize = Math.max(2, opts.batchSize || 40);
  let done = 0;
  const markDone = (i, res) => {
    results[i] = res;
    done++;
    if (onProgress) onProgress(done, profiles.length, res);
  };

  for (let i = 0; i < profiles.length; i++) {
    const san = sanitizeProfile(profiles[i]);
    if (san.error) markDone(i, { ok: false, error: san.error });
    else if (san.p) profiles[i] = san.p;
  }

  if (opts.noBatch) {
    let idx = 0;
    const worker = async () => {
      for (;;) {
        const i = idx++;
        if (i >= profiles.length) break;
        if (results[i] !== undefined) continue;
        markDone(i, await validateProfile(profiles[i], xrayBin, opts));
      }
    };
    const n = Math.max(1, Math.min(opts.concurrency || 8, 32));
    await Promise.all(Array.from({ length: n }, () => worker()));
    return results;
  }

  const reachable = await tcpPrefilter(profiles, opts);
  const reached = reachable.reduce((s, v) => s + (v ? 1 : 0), 0);
  console.log(`[validate] tcp prefilter: ${reached}/${profiles.length} reachable`);

  const batchIdx = [];
  for (let i = 0; i < profiles.length; i++) if (reachable[i] && results[i] === undefined) batchIdx.push(i);
  const batchCount = Math.max(1, Math.ceil(batchIdx.length / batchSize));
  let batchNo = 0;

  for (let start = 0; start < batchIdx.length; start += batchSize) {
    batchNo++;
    const indices = batchIdx.slice(start, start + batchSize);
    const items = indices.map((i) => ({ p: profiles[i] }));
    let batchResults = null;
    let batchErr = '';
    try {
      batchResults = await validateBatch(items, xrayBin, opts);
    } catch (e) {
      batchErr = String(e.message || e);
    }
    let alive = 0;
    const needIndividual = [];
    for (let k = 0; k < indices.length; k++) {
      const res = batchResults ? batchResults[k] : null;
      if (res && res.ok) {
        alive++;
        markDone(indices[k], res);
      } else if (res && res.localDown) {
        needIndividual.push(indices[k]);
      } else if (batchResults) {
        markDone(indices[k], res);
      } else {
        needIndividual.push(indices[k]);
      }
    }
    if (batchErr) console.log(`[validate] batch ${batchNo}/${batchCount} failed (${batchErr})`);
    console.log(`[validate] batch ${batchNo}/${batchCount}: alive=${alive}/${indices.length} retry=${needIndividual.length}`);
    for (const i of needIndividual) {
      markDone(i, await validateProfile(profiles[i], xrayBin, opts));
    }
  }

  for (let i = 0; i < profiles.length; i++) {
    if (results[i] === undefined) {
      markDone(i, { ok: false, error: `tcp unreachable ${profiles[i].host}:${profiles[i].port}` });
    }
  }
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
