'use strict';

function escapeYaml(s) {
  if (/[:#&*!|>'"%@`]/.test(s) || s === '' || /\s/.test(s)) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return s;
}

function toClash(p) {
  const name = p.remark;
  const base = {
    name,
    type: 'vless',
    server: p.profile.host,
    port: p.profile.port,
    uuid: p.profile.uuid,
    tls: p.profile.security === 'tls' || p.profile.security === 'reality',
    udp: true,
  };
  if (p.profile.security === 'tls') {
    base.servername = p.profile.sni || p.profile.host;
    base['client-fingerprint'] = p.profile.fp || 'chrome';
    base['skip-cert-verify'] = false;
  }
  if (p.profile.security === 'reality') {
    base.servername = p.profile.sni || p.profile.host;
    base['client-fingerprint'] = p.profile.fp || 'chrome';
    base['reality-opts'] = { 'public-key': p.profile.pbk, 'short-id': p.profile.sid || '' };
  }
  if (p.profile.flow) base.flow = p.profile.flow;
  const t = p.profile.type || 'tcp';
  if (t === 'ws') {
    base.network = 'ws';
    base['ws-opts'] = { path: p.profile.path || '/' };
    if (p.profile.hostHeader) base['ws-opts'].headers = { Host: p.profile.hostHeader.split(',')[0].trim() };
  } else if (t === 'grpc') {
    base.network = 'grpc';
    base['grpc-opts'] = { 'grpc-service-name': (p.profile.serviceName || p.profile.path || '').replace(/^\//, '') };
  }
  if (t !== 'tcp' && t !== 'ws' && t !== 'grpc') base.network = t;
  return base;
}

function toSingBox(p) {
  const t = p.profile.type || 'tcp';
  const transport = t === 'tcp' ? 'none' : t;
  const ob = {
    type: 'vless',
    tag: p.remark,
    server: p.profile.host,
    server_port: p.profile.port,
    uuid: p.profile.uuid,
    transport: { type: transport },
  };
  if (p.profile.flow) ob.flow = p.profile.flow;
  if (t === 'ws') {
    ob.transport.path = p.profile.path || '/';
    if (p.profile.hostHeader) ob.transport.headers = { Host: p.profile.hostHeader.split(',')[0].trim() };
  }
  if (t === 'grpc') {
    ob.transport.service_name = (p.profile.serviceName || p.profile.path || '').replace(/^\//, '');
  }
  if (p.profile.security === 'tls') {
    ob.tls = { enabled: true, server_name: p.profile.sni || p.profile.host, utls: { enabled: true, fingerprint: p.profile.fp || 'chrome' } };
  }
  if (p.profile.security === 'reality') {
    ob.tls = {
      enabled: true,
      server_name: p.profile.sni || p.profile.host,
      utls: { enabled: true, fingerprint: p.profile.fp || 'chrome' },
      reality: { enabled: true, public_key: p.profile.pbk, short_id: p.profile.sid || '' },
    };
  }
  return ob;
}

function buildClashFile(records) {
  const proxies = records.map(toClash);
  const lines = ['# Xer0x-vless-hub Clash proxies', 'proxies:'];
  for (const p of proxies) {
    lines.push('  - name: ' + escapeYaml(p.name));
    for (const [k, v] of Object.entries(p)) {
      if (k === 'name') continue;
      if (typeof v === 'object' && v !== null) {
        lines.push('    ' + k + ':');
        for (const [k2, v2] of Object.entries(v)) {
          if (typeof v2 === 'object' && v2 !== null) {
            lines.push('      ' + k2 + ':');
            for (const [k3, v3] of Object.entries(v2)) {
              lines.push('        ' + k3 + ': ' + (typeof v3 === 'string' ? escapeYaml(v3) : v3));
            }
          } else {
            lines.push('      ' + k2 + ': ' + (typeof v2 === 'string' ? escapeYaml(v2) : v2));
          }
        }
      } else if (typeof v === 'boolean') {
        lines.push('    ' + k + ': ' + v);
      } else {
        lines.push('    ' + k + ': ' + (typeof v === 'number' ? v : escapeYaml(v)));
      }
    }
  }
  return lines.join('\n') + '\n';
}

function buildSingBoxFile(records) {
  const outbounds = records.map(toSingBox);
  return JSON.stringify({ outbounds }, null, 2) + '\n';
}

module.exports = { toClash, toSingBox, buildClashFile, buildSingBoxFile };