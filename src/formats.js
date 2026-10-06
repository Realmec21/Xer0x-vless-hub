'use strict';

const { buildVlessOutbound } = require('./vless');

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

const AUTO_URLTEST = { url: 'http://www.gstatic.com/generate_204', interval: 300, tolerance: 50 };

function buildClashAutoFile(records, groupName) {
  const lines = [buildClashFile(records).trimEnd()];
  const names = records.map((r) => r.remark);
  const autoName = `${groupName} Auto`;
  lines.push('proxy-groups:');
  lines.push('  - name: ' + escapeYaml(autoName));
  lines.push('    type: url-test');
  lines.push('    url: ' + AUTO_URLTEST.url);
  lines.push('    interval: ' + AUTO_URLTEST.interval);
  lines.push('    tolerance: ' + AUTO_URLTEST.tolerance);
  lines.push('    proxies:');
  for (const n of names) lines.push('      - ' + escapeYaml(n));
  lines.push('  - name: ' + escapeYaml(`${groupName} Manual`));
  lines.push('    type: select');
  lines.push('    proxies:');
  lines.push('      - ' + escapeYaml(autoName));
  for (const n of names) lines.push('      - ' + escapeYaml(n));
  lines.push('rules:');
  lines.push('  - MATCH,' + autoName);
  return lines.join('\n') + '\n';
}

function buildSingBoxFile(records) {
  const outbounds = records.map(toSingBox);
  return JSON.stringify({ outbounds }, null, 2) + '\n';
}

const XRAY_AUTO = {
  torrentPorts: '6881-6889,6969,51413,6346-6347,4444,4662,4672,1337,2710,17417,21413,37305',
  ruDomains: [
    'domain:gosuslugi.ru', 'domain:mos.ru', 'domain:nalog.gov.ru', 'domain:rzd.ru', 'domain:tutu.ru',
    'domain:avito.ru', 'domain:avito.st', 'domain:ozon.ru', 'domain:ozone.ru', 'domain:ozonusercontent.com',
    'domain:wildberries.ru', 'domain:wb.ru', 'domain:wbbasket.ru', 'domain:wb-basket.ru', 'domain:wbstatic.net',
    'domain:yandex.ru', 'domain:yandex.net', 'domain:yastatic.net', 'domain:ya.ru', 'domain:kinopoisk.ru',
    'domain:mail.ru', 'domain:mailcdn.ru', 'domain:imgsmail.ru', 'domain:vk.com', 'domain:vk.ru',
    'domain:vk-portal.net', 'domain:userapi.com', 'domain:vkuseraudio.net', 'domain:vkuserlive.net', 'domain:vkuservideo.net',
    'domain:vkvideo.ru', 'domain:ok.ru', 'domain:okcdn.ru', 'domain:mycdn.me', 'domain:max.ru',
    'domain:oneme.ru', 'domain:rutube.ru', 'domain:okko.tv', 'domain:premier.one', 'domain:smotrim.ru',
    'domain:rustore.ru', 'domain:2gis.ru', 'domain:2gis.com', 'domain:mts.ru', 'domain:t2.ru',
    'domain:tele2.ru', 'domain:beeline.ru', 'domain:megafon.ru',
  ],
  dnsIps: ['9.9.9.12', '149.112.112.12'],
};

function buildXrayAutoConfig(records, kind) {
  const isLte = kind === 'lte';
  const balTag = isLte ? 'balancer-lte' : 'balancer-wifi';
  const outbounds = records.map((r, i) =>
    buildVlessOutbound(r.profile, isLte ? (i === 0 ? 'proxy' : `proxy-${i + 1}`) : `proxy-main-${i + 1}`)
  );
  outbounds.push({ tag: 'direct', protocol: 'freedom' });
  outbounds.push({ tag: 'block', protocol: 'blackhole' });
  const config = {
    routing: {
      balancers: [
        {
          fallbackTag: 'block',
          selector: ['proxy'],
          tag: balTag,
          strategy: isLte
            ? { settings: { maxRTT: '8s', expected: 1, tolerance: 0.25 }, type: 'leastLoad' }
            : { type: 'leastPing' },
        },
      ],
      domainStrategy: 'IPIfNonMatch',
      rules: [
        { protocol: ['bittorrent'], type: 'field', outboundTag: 'direct' },
        { port: XRAY_AUTO.torrentPorts, type: 'field', outboundTag: 'direct', network: 'tcp,udp' },
        { domain: XRAY_AUTO.ruDomains, type: 'field', outboundTag: 'direct' },
        { port: '53', ip: XRAY_AUTO.dnsIps, type: 'field', outboundTag: 'direct', network: 'tcp,udp' },
        { port: '443', type: 'field', outboundTag: 'block', network: 'udp' },
        { balancerTag: balTag, type: 'field', network: 'tcp,udp' },
      ],
      domainMatcher: 'hybrid',
    },
    log: { loglevel: 'warning' },
    outbounds,
    stats: {},
    dns: {
      servers: [
        { address: XRAY_AUTO.dnsIps[0], tag: 'DNS_QUAD9_ECS_PRIMARY_1' },
        { address: XRAY_AUTO.dnsIps[1], tag: 'DNS_QUAD9_ECS_PRIMARY_2' },
      ],
      queryStrategy: 'UseIP',
    },
    burstObservatory: {
      subjectSelector: ['proxy'],
      pingConfig: {
        connectivity: 'http://connectivitycheck.gstatic.com/generate_204',
        sampling: isLte ? 4 : 1,
        destination: 'http://www.gstatic.com/generate_204',
        interval: '15s',
        timeout: '3s',
      },
    },
    inbounds: [
      {
        settings: { udp: true, auth: 'noauth' },
        protocol: 'socks',
        port: 10808,
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
        tag: 'socks',
        listen: '127.0.0.1',
      },
      {
        settings: { allowTransparent: false },
        protocol: 'http',
        port: 10809,
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] },
        tag: 'http',
        listen: '127.0.0.1',
      },
    ],
    remarks: isLte ? 'Xer0x LTE auto (leastLoad)' : 'Xer0x WiFi auto (leastPing)',
    policy: { system: { statsOutboundUplink: true, statsOutboundDownlink: true } },
  };
  return JSON.stringify(config) + '\n';
}

module.exports = { toClash, toSingBox, buildClashFile, buildSingBoxFile, buildClashAutoFile, buildXrayAutoConfig };