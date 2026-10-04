'use strict';

const net = require('net');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { postJson } = require('./http');

const CACHE_FILE = path.join(process.cwd(), '.cache', 'geo.json');
const CDN_RE = /(cloudflare|cloudfastly|fastly|akamai|akamaized|edgekey|edgesuite|cloudfront|azureedge|azurefd|googlehosted|ghs|cdn|edgesuite)/i;

function flag(cc) {
  if (!/^[A-Za-z]{2}$/.test(cc || '')) return '🌐';
  const up = cc.toUpperCase();
  const A = 0x1f1e6;
  return String.fromCodePoint(A + up.charCodeAt(0) - 65, A + up.charCodeAt(1) - 65);
}

function loadCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  } catch (e) {}
}

async function resolveHost(host) {
  if (net.isIP(host)) return [host];
  const out = [];
  try {
    out.push(...(await dns.resolve4(host)));
  } catch (e) {}
  try {
    out.push(...(await dns.resolve6(host)));
  } catch (e) {}
  return out;
}

async function resolveCnameChain(host) {
  const chain = [];
  let cur = host;
  for (let i = 0; i < 10; i++) {
    if (net.isIP(cur)) break;
    try {
      const next = (await dns.resolveCname(cur))[0];
      if (!next || chain.includes(next)) break;
      chain.push(next);
      cur = next;
    } catch (e) {
      break;
    }
  }
  return chain;
}

async function looksLikeCdn(host) {
  if (net.isIP(host)) return false;
  try {
    const chain = await resolveCnameChain(host);
    if (chain.length && CDN_RE.test(chain.join(' '))) return true;
    const ips = await resolveHost(host);
    if (ips.some((ip) => net.isIP(ip) === 6 && /cloudflare/i.test(host))) return true;
  } catch (e) {}
  return false;
}

async function lookupCountries(ips, opts = {}) {
  const delay = opts.batchDelayMs || 1500;
  const cache = loadCache();
  const pending = [...new Set(ips.filter((ip) => ip && net.isIP(ip) && !cache[ip]))];
  const chunks = [];
  for (let i = 0; i < pending.length; i += 100) chunks.push(pending.slice(i, i + 100));

  for (const chunk of chunks) {
    try {
      const res = await postJson(
        'http://ip-api.com/batch?fields=query,status,countryCode,country',
        chunk.map((q) => ({ query: q })),
        { timeoutMs: 20000 }
      );
      if (Array.isArray(res)) {
        for (const r of res) {
          if (r && r.status === 'success' && r.query) {
            cache[r.query] = { cc: (r.countryCode || '').toUpperCase(), country: r.country || '' };
          }
        }
      }
    } catch (e) {
      console.log(`[geo] batch failed: ${e.message || e}`);
    }
    if (chunks.length > 1) await new Promise((r) => setTimeout(r, delay));
  }

  saveCache(cache);
  return cache;
}

module.exports = { flag, loadCache, saveCache, resolveHost, resolveCnameChain, looksLikeCdn, lookupCountries };
