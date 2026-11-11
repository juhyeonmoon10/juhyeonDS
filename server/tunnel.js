/*
 * juhyeonDS - optional public tunnel, so the server can be reached from other networks.
 *
 * Uses Cloudflare's free "quick tunnel" (no account needed): the cloudflared program makes an
 * outbound connection to Cloudflare and hands back a public https://….trycloudflare.com address
 * that forwards to this server. Nothing has to be opened on the router or firewall.
 * Licensed under the GNU General Public License v3 or later.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const TOOLS_DIR = path.join(__dirname, '..', 'tools');
const RELEASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const ASSETS = {
  'win32-x64': 'cloudflared-windows-amd64.exe',
  'win32-ia32': 'cloudflared-windows-386.exe',
  'linux-x64': 'cloudflared-linux-amd64',
  'linux-arm64': 'cloudflared-linux-arm64',
};

function localBinary() {
  return path.join(TOOLS_DIR, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

/** Returns the path of a usable cloudflared, or '' when none is installed. */
function findBinary() {
  if (fs.existsSync(localBinary())) return localBinary();
  const probe = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  return probe.error ? '' : 'cloudflared';
}

function download(url, dest, onProgress, redirects) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'juhyeonds' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if ((redirects || 0) > 5) return reject(new Error('너무 많은 리디렉션'));
          return resolve(download(new URL(res.headers.location, url).href, dest, onProgress, (redirects || 0) + 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('다운로드 실패 (HTTP ' + res.statusCode + ')'));
        }
        const total = Number(res.headers['content-length']) || 0;
        let received = 0;
        const tmp = dest + '.part';
        const file = fs.createWriteStream(tmp);
        res.on('data', (chunk) => {
          received += chunk.length;
          if (total) onProgress(received / total);
        });
        res.pipe(file);
        file.on('finish', () =>
          file.close(() => {
            fs.renameSync(tmp, dest);
            resolve();
          })
        );
        file.on('error', reject);
      })
      .on('error', reject);
  });
}

async function ensureBinary(log) {
  const existing = findBinary();
  if (existing) return existing;

  const asset = ASSETS[process.platform + '-' + process.arch];
  if (!asset) {
    throw new Error(
      '이 운영체제용 cloudflared를 자동으로 받을 수 없습니다. https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 에서 설치한 뒤 다시 실행하세요. (macOS: brew install cloudflared)'
    );
  }
  fs.mkdirSync(TOOLS_DIR, { recursive: true });
  const dest = localBinary();
  log(`  터널 프로그램(cloudflared, Cloudflare 공식 배포판, 약 55MB)을 내려받습니다…`);
  log(`  출처: ${RELEASE}${asset}`);
  let shown = -1;
  await download(RELEASE + asset, dest, (f) => {
    const pct = Math.floor(f * 10) * 10;
    if (pct !== shown) {
      shown = pct;
      log(`    ${pct}%`);
    }
  });
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  return dest;
}

/**
 * Starts a quick tunnel to http://localhost:<port>.
 * @returns {Promise<{url: string, stop: () => void}>}
 */
async function startTunnel(port, log) {
  const bin = await ensureBinary(log);
  log('  외부 접속 주소를 만드는 중… (10~20초)');
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let tail = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('외부 접속 주소를 받지 못했습니다 (시간 초과). 인터넷 연결이나 방화벽을 확인하세요.\n' + tail.slice(-400)));
    }, 60000);
    const onData = (data) => {
      const text = data.toString();
      tail = (tail + text).slice(-2000);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: match[0], stop: () => child.kill() });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('cloudflared를 실행하지 못했습니다: ' + err.message));
    });
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('cloudflared가 종료되었습니다 (코드 ' + code + ').\n' + tail.slice(-400)));
      } else {
        log('  [경고] 외부 접속 터널이 끊어졌습니다. 서버를 다시 실행하면 새 주소가 만들어집니다.');
      }
    });
    process.on('exit', () => child.kill());
  });
}

module.exports = { startTunnel };
