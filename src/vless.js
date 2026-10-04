'use strict';

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

function parseVless(uri) {
  if (typeof uri !== 'string') return null;
  const raw = uri.trim();
  if (!/^vless:\/\//i.test(raw)) return null;
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  if (u.protocol !== 'vless:') return null;
  const uuid = u.username;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? parseInt(u.port, 10) : 443;
  if (!uuid || !host || !Number.isFinite(port) || port <= 0 || port > 65535) return null;

  const q = u.searchParams;
  let name = '';
  if (u.hash && u.hash.length > 1) name = safeDecode(u.hash.slice(1));

  const type = (q.get('type') || q.get('headerType') || 'tcp').toLowerCase();
  const security = (q.get('security') || 'none').toLowerCase();
  const hostHeader = q.get('host') || '';
  const pathRaw = q.get('path') || '';

  return {
    raw,
    uuid,
    host,
    port,
    type: type === 'none' ? 'tcp' : type,
    security: security === 'none' ? '' : security,
    sni: q.get('sni') || q.get('peer') || '',
    hostHeader,
    path: pathRaw,
    serviceName: q.get('serviceName') || '',
    flow: q.get('flow') || '',
    pbk: q.get('pbk') || '',
    sid: q.get('sid') || '',
    spx: q.get('spx') || '',
    fp: q.get('fp') || '',
    headerType: q.get('headerType') || '',
    name,
  };
}

function dedupeKey(p) {
  const q = new URLSearchParams();
  const keep = ['type', 'security', 'sni', 'host', 'path', 'serviceName', 'flow', 'pbk', 'sid', 'fp', 'headerType'];
  let u;
  try {
    u = new URL(p.raw.split('#')[0]);
  } catch (e) {
    return p.raw.split('#')[0];
  }
  keep.forEach((k) => {
    let v = u.searchParams.get(k);
    if (!v) return;
    if (k === 'type' && (v === 'tcp' || v === 'none')) return;
    if (k === 'security' && v === 'none') return;
    if (k === 'headerType' && (v === 'none' || v === '')) return;
    q.append(k, v);
  });
  q.sort();
  return `${p.uuid}@${p.host}:${p.port}?${q.toString()}`;
}

function buildXrayConfig(listenPort, p) {
  const network = p.type || 'tcp';
  const security = p.security || '';
  const stream = { network };

  if (security === 'tls') {
    stream.security = 'tls';
    stream.tlsSettings = {
      serverName: p.sni || p.host,
      allowInsecure: false,
      fingerprint: p.fp || 'chrome',
    };
  } else if (security === 'reality') {
    stream.security = 'reality';
    stream.realitySettings = {
      serverName: p.sni || p.host,
      fingerprint: p.fp || 'chrome',
      publicKey: p.pbk,
      shortId: p.sid || '',
      spiderX: p.spx || '/',
    };
  }

  if (network === 'ws') {
    stream.wsSettings = {
      path: p.path || '/',
      ...(p.hostHeader ? { headers: { Host: p.hostHeader.split(',')[0].trim() } } : {}),
    };
  } else if (network === 'grpc') {
    stream.grpcSettings = {
      serviceName: (p.serviceName || p.path || '').replace(/^\//, ''),
      ...(p.hostHeader ? { authority: p.hostHeader.split(',')[0].trim() } : {}),
    };
  } else if (network === 'tcp') {
    const ht = (p.headerType || '').toLowerCase();
    stream.tcpSettings = {
      header: { type: ht && ht !== 'none' ? ht : 'none' },
    };
  } else if (network === 'http') {
    stream.httpSettings = {
      path: p.path || '/',
      ...(p.hostHeader ? { host: p.hostHeader.split(',').map((s) => s.trim()) } : {}),
    };
  } else if (network === 'httpupgrade') {
    stream.httpupgradeSettings = {
      path: p.path || '/',
      host: (p.hostHeader || p.host).split(',')[0].trim(),
    };
  } else if (network === 'xhttp') {
    stream.xhttpSettings = {
      path: p.path || '/',
      host: (p.hostHeader || p.host).split(',')[0].trim(),
    };
  } else if (network === 'kcp') {
    const ht = (p.headerType || 'srtp').toLowerCase();
    stream.kcpSettings = {
      mtu: 1350,
      header: { type: ['none', 'srtp', 'utp', 'wechat-video', 'dtls', 'wireguard'].includes(ht) ? ht : 'srtp' },
    };
  }

  const user = { id: p.uuid, encryption: 'none' };
  if (p.flow) user.flow = p.flow;

  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'http-in',
        listen: '127.0.0.1',
        port: listenPort,
        protocol: 'http',
        settings: { timeout: 8 },
      },
    ],
    outbounds: [
      {
        tag: 'proxy',
        protocol: 'vless',
        settings: {
          vnext: [
            {
              address: p.host,
              port: p.port,
              users: [user],
            },
          ],
        },
        streamSettings: stream,
      },
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'block', protocol: 'blackhole' },
    ],
    policy: {
      levels: { '0': { handshake: 4, connIdle: 8, uplinkOnly: 2, downlinkOnly: 5 } },
      system: { statsInboundUplink: false, statsInboundDownlink: false },
    },
  };
}

function remarkUri(p, nickname, flag, index) {
  const base = p.raw.split('#')[0];
  const num = `${nickname}-${String(index).padStart(2, '0')}`;
  const remark = flag ? `${flag} ${num}` : num;
  return `${base}#${encodeURIComponent(remark)}`;
}

module.exports = { parseVless, dedupeKey, buildXrayConfig, remarkUri };
