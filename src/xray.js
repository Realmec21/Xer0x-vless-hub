'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { downloadFile } = require('./http');

const execFileAsync = promisify(execFile);
const RELEASE = 'https://github.com/XTLS/Xray-core/releases/latest/download/';

function assetName() {
  const plat = process.platform;
  const arch = process.arch;
  if (plat === 'win32') return arch === 'arm64' ? 'Xray-windows-arm64-v8a.zip' : 'Xray-windows-64.zip';
  if (plat === 'darwin') return arch === 'arm64' ? 'Xray-macos-arm64-v8a.zip' : 'Xray-macos-64.zip';
  return arch === 'arm64' ? 'Xray-linux-arm64-v8a.zip' : 'Xray-linux-64.zip';
}

async function extract(zipPath, destDir) {
  if (process.platform === 'linux') {
    await execFileAsync('unzip', ['-o', '-q', zipPath, '-d', destDir]);
  } else {
    await execFileAsync('tar', ['-xf', zipPath, '-C', destDir]);
  }
}

async function ensureXray(baseDir = path.join(process.cwd(), '.xray')) {
  const exeName = process.platform === 'win32' ? 'xray.exe' : 'xray';
  const exePath = path.join(baseDir, exeName);
  if (fs.existsSync(exePath)) return exePath;

  fs.mkdirSync(baseDir, { recursive: true });
  const url = RELEASE + assetName();
  const zipPath = path.join(baseDir, assetName());
  console.log(`[xray] downloading ${url}`);
  await downloadFile(url, zipPath);
  await extract(zipPath, baseDir);
  try {
    fs.unlinkSync(zipPath);
  } catch (e) {}
  if (!fs.existsSync(exePath)) throw new Error('xray binary not found after extraction');
  if (process.platform !== 'win32') fs.chmodSync(exePath, 0o755);
  console.log(`[xray] ready: ${exePath}`);
  return exePath;
}

module.exports = { ensureXray };
