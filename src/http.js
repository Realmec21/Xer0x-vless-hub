'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const { URL } = require('url');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function request(url, { method = 'GET', body = null, headers = {}, timeoutMs = 20000, redirects = 5 }) {
  return new Promise((resolve, reject) => {
    const go = (u, left) => {
      let parsed;
      try {
        parsed = new URL(u);
      } catch (e) {
        return reject(new Error('bad url: ' + u));
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(
        parsed,
        {
          method,
          headers: { 'User-Agent': UA, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
          timeout: timeoutMs,
        },
        (res) => {
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location &&
            left > 0
          ) {
            res.resume();
            return go(new URL(res.headers.location, parsed).toString(), left - 1);
          }
          const chunks = [];
          let n = 0;
          res.on('data', (c) => {
            n += c.length;
            if (n > 64 * 1024 * 1024) {
              res.destroy();
              reject(new Error('response too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode} for ${u}`));
            } else {
              resolve(buf);
            }
          });
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    };
    go(url, redirects);
  });
}

async function fetchText(url, opts = {}) {
  const buf = await request(url, opts);
  return buf.toString('utf8');
}

async function postJson(url, data, opts = {}) {
  const buf = await request(url, { ...opts, method: 'POST', body: JSON.stringify(data) });
  return JSON.parse(buf.toString('utf8'));
}

function downloadFile(url, dest, { timeoutMs = 180000, redirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const go = (u, left) => {
      let parsed;
      try {
        parsed = new URL(u);
      } catch (e) {
        return reject(new Error('bad url: ' + u));
      }
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.request(
        parsed,
        { headers: { 'User-Agent': UA }, timeout: timeoutMs },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && left > 0) {
            res.resume();
            return go(new URL(res.headers.location, parsed).toString(), left - 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          const out = fs.createWriteStream(dest);
          res.pipe(out);
          out.on('finish', () => out.close(() => resolve(dest)));
          out.on('error', reject);
          res.on('error', reject);
        }
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.end();
    };
    go(url, redirects);
  });
}

module.exports = { fetchText, postJson, downloadFile };
