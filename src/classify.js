'use strict';

function isWhitelistCandidate(r, criteria) {
  const c = criteria || {};
  if (!r.ok) return false;
  if (c.requirePublicTls && !r.hasPublicTls) return false;
  if (c.requireDomain && netIsIP(r.profile.host)) return false;
  if (c.requireCdn && !r.isCdn) return false;
  if (c.maxLatencyMs && r.latencyMs > c.maxLatencyMs) return false;
  return true;
}

function netIsIP(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

module.exports = { isWhitelistCandidate };
