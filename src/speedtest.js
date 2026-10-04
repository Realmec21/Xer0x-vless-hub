'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const SPEEDTEST_URL = 'https://speed.cloudflare.com/__down?bytes=2097152';
const SPEEDTEST_TIMEOUT = 15;

async function measureSpeed(port) {
  const args = [
    '-sS',
    '-x', `http://127.0.0.1:${port}`,
    '--max-time', String(SPEEDTEST_TIMEOUT),
    '--connect-timeout', '8',
    '-o', process.platform === 'win32' ? 'NUL' : '/dev/null',
    '-w', '%{size_download} %{time_total}',
    SPEEDTEST_URL,
  ];
  try {
    const { stdout } = await execFileAsync('curl', args, { maxBuffer: 1024 });
    const parts = stdout.trim().split(/\s+/);
    const bytes = parseFloat(parts[0]) || 0;
    const secs = parseFloat(parts[1]) || 0;
    if (bytes < 100000 || secs <= 0) return null;
    const mbps = (bytes * 8) / (secs * 1000000);
    return Math.round(mbps * 10) / 10;
  } catch (e) {
    return null;
  }
}

module.exports = { measureSpeed };
