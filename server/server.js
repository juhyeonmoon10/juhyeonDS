#!/usr/bin/env node
/*
 * juhyeonDS - static file host + optional server-side emulation (streaming).
 *
 *   node server/server.js [--port 8080] [--host 127.0.0.1] [--public] [--password SECRET] [--open]
 *                         [--max-sessions 4] [--no-emulation] [--cert cert.pem --key key.pem]
 *                         [--tunnel]   make the server reachable from other networks
 *
 * Environment variables PORT, HOST, PASSWORD, MAX_SESSIONS, TLS_CERT, TLS_KEY work too.
 * Licensed under the GNU General Public License v3 or later.
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Worker } = require('worker_threads');

let WebSocketServer = null;
try {
  ({ WebSocketServer } = require('ws'));
} catch (err) {
  console.warn('[경고] "ws" 모듈을 찾을 수 없어 서버 에뮬레이션 모드를 끕니다. (npm install 을 실행하세요)');
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = parseInt(args.port || process.env.PORT || '8080', 10);
const HOST = args.host || process.env.HOST || (args.public ? '0.0.0.0' : '127.0.0.1');
const PASSWORD = String(args.password || process.env.PASSWORD || '');
const MAX_SESSIONS = parseInt(args['max-sessions'] || process.env.MAX_SESSIONS || '4', 10);
const EMULATION = !args['no-emulation'] && !!WebSocketServer;
const TLS_CERT = args.cert || process.env.TLS_CERT || '';
const TLS_KEY = args.key || process.env.TLS_KEY || '';
const MAX_ROM_BYTES = 512 * 1024 * 1024;
const MAX_SAVE_BYTES = 16 * 1024 * 1024;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (err) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

function handleRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }
  if (req.url.split('?')[0] === '/api/info') {
    sendJSON(res, 200, {
      name: 'juhyeonds',
      emulation: EMULATION,
      passwordRequired: EMULATION && PASSWORD !== '',
      sessions: sessions.size,
      maxSessions: MAX_SESSIONS,
    });
    return;
  }
  serveStatic(req, res);
}

// ---------------------------------------------------------------------------
// Emulation sessions (WebSocket at /emu)
// ---------------------------------------------------------------------------
const MSG_ROM_CHUNK = 0x01;
const MSG_SAVE_CHUNK = 0x02;
const MSG_BIOS9 = 0x03;
const MSG_BIOS7 = 0x04;
const MSG_INPUT = 0x10;
const MSG_VIDEO = 0x20;
const HIGH_WATER = 2 * 1024 * 1024; // pause video when this much is queued for a slow client
const LOW_WATER = 256 * 1024;

const sessions = new Set();

function passwordMatches(given) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

class Session {
  constructor(ws, remote) {
    this.ws = ws;
    this.remote = remote;
    this.worker = null;
    this.expect = null; // { romSize, saveSize, ... } once 'start' arrives
    this.romChunks = [];
    this.romBytes = 0;
    this.saveChunks = [];
    this.saveBytes = 0;
    this.bios9 = null;
    this.bios7 = null;
    this.videoPaused = false;
    this.awaitingKeyframe = false;
    this.closed = false;

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) this.onBinary(data);
        else this.onText(data.toString('utf8'));
      } catch (err) {
        this.fail(String(err.message || err));
      }
    });
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  fail(message) {
    this.send({ t: 'error', message });
    try {
      this.ws.close(1011, 'error');
    } catch (err) {
      /* already closed */
    }
    this.dispose();
  }

  onText(text) {
    const msg = JSON.parse(text);
    switch (msg.t) {
      case 'start': {
        if (this.expect) throw new Error('세션이 이미 시작되었습니다');
        const romSize = Number(msg.romSize) | 0;
        const saveSize = Number(msg.saveSize) | 0;
        if (romSize < 0x200 || romSize > MAX_ROM_BYTES) throw new Error('ROM 크기가 올바르지 않습니다');
        if (saveSize < 0 || saveSize > MAX_SAVE_BYTES) throw new Error('세이브 크기가 올바르지 않습니다');
        this.expect = {
          romSize,
          saveSize,
          sampleRate: Math.min(96000, Math.max(8000, Number(msg.sampleRate) || 48000)),
          language: Math.min(5, Math.max(0, Number(msg.language) | 0)),
          datetime: Array.isArray(msg.datetime) ? msg.datetime.slice(0, 6).map((n) => Number(n) | 0) : null,
          fpsDivider: msg.fpsDivider === 2 ? 2 : 1,
          bios: !!msg.bios,
        };
        this.send({ t: 'upload' });
        break;
      }
      case 'go':
        this.launch();
        break;
      case 'pause':
      case 'resume':
      case 'reset':
      case 'getsave':
      case 'keyframe':
        if (this.worker) this.worker.postMessage({ t: msg.t });
        break;
      case 'lid':
        if (this.worker) this.worker.postMessage({ t: 'lid', closed: !!msg.closed });
        break;
      case 'fps':
        if (this.worker) this.worker.postMessage({ t: 'fps', divider: msg.divider === 2 ? 2 : 1 });
        break;
      case 'ping':
        this.send({ t: 'pong', id: msg.id });
        break;
    }
  }

  onBinary(buf) {
    if (buf.length < 1) return;
    const type = buf[0];
    if (type === MSG_INPUT) {
      if (this.worker && buf.length >= 6) {
        this.worker.postMessage({
          t: 'input',
          keys: buf[1] | (buf[2] << 8),
          touching: buf[3],
          x: buf[4],
          y: buf[5],
        });
      }
      return;
    }
    if (!this.expect || this.worker) return;
    if (type === MSG_ROM_CHUNK) {
      this.romBytes += buf.length - 1;
      if (this.romBytes > this.expect.romSize) throw new Error('ROM 데이터가 예고된 크기보다 큽니다');
      this.romChunks.push(buf.subarray(1));
    } else if (type === MSG_SAVE_CHUNK) {
      this.saveBytes += buf.length - 1;
      if (this.saveBytes > this.expect.saveSize) throw new Error('세이브 데이터가 예고된 크기보다 큽니다');
      this.saveChunks.push(buf.subarray(1));
    } else if (type === MSG_BIOS9 && this.expect.bios && buf.length === 0x1001) {
      this.bios9 = Uint8Array.from(buf.subarray(1)).buffer;
    } else if (type === MSG_BIOS7 && this.expect.bios && buf.length === 0x4001) {
      this.bios7 = Uint8Array.from(buf.subarray(1)).buffer;
    }
  }

  launch() {
    if (!this.expect) throw new Error('start 메시지가 먼저 필요합니다');
    if (this.worker) return;
    if (this.romBytes !== this.expect.romSize) throw new Error('ROM 업로드가 완료되지 않았습니다');
    if (this.saveBytes !== this.expect.saveSize) throw new Error('세이브 업로드가 완료되지 않았습니다');
    if (this.expect.bios && !(this.bios9 && this.bios7)) throw new Error('BIOS 업로드가 완료되지 않았습니다');

    const toArrayBuffer = (chunks, total) => {
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out.buffer;
    };
    const rom = toArrayBuffer(this.romChunks, this.romBytes);
    const save = this.saveBytes ? toArrayBuffer(this.saveChunks, this.saveBytes) : null;
    this.romChunks = [];
    this.saveChunks = [];

    this.worker = new Worker(path.join(__dirname, 'session-worker.js'));
    this.worker.on('message', (m) => this.onWorkerMessage(m));
    this.worker.on('error', (err) => this.fail('에뮬레이터 오류: ' + (err.message || err)));
    this.worker.on('exit', () => {
      this.worker = null;
    });
    this.worker.postMessage(
      {
        t: 'load',
        rom,
        save,
        sampleRate: this.expect.sampleRate,
        language: this.expect.language,
        datetime: this.expect.datetime,
        fpsDivider: this.expect.fpsDivider,
        bios9: this.bios9,
        bios7: this.bios7,
      },
      save ? [rom, save] : [rom]
    );
  }

  onWorkerMessage(m) {
    if (this.closed || this.ws.readyState !== 1) return;
    if (m.t === 'json') {
      this.send(m.data);
      return;
    }
    if (m.t !== 'bin') return;

    // Flow control: when the client can't keep up, stop producing video until the queue
    // drains, then restart from a keyframe. Audio and saves are always delivered.
    const queued = this.ws.bufferedAmount;
    if (!this.videoPaused && queued > HIGH_WATER) {
      this.videoPaused = true;
      this.worker.postMessage({ t: 'videoPaused', value: true });
    } else if (this.videoPaused && queued < LOW_WATER) {
      this.videoPaused = false;
      this.worker.postMessage({ t: 'videoPaused', value: false });
    }
    if (m.kind === MSG_VIDEO) {
      const isKeyframe = (new Uint8Array(m.data, 1, 1)[0] & 1) === 1;
      if (this.videoPaused || (this.awaitingKeyframe && !isKeyframe)) {
        // A dropped frame breaks the delta chain: skip everything until the next keyframe.
        if (!this.awaitingKeyframe) this.worker.postMessage({ t: 'keyframe' });
        this.awaitingKeyframe = true;
        return;
      }
      this.awaitingKeyframe = false;
    }
    this.ws.send(Buffer.from(m.data), { binary: true });
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    sessions.delete(this);
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.romChunks = [];
    this.saveChunks = [];
    log(`세션 종료 (${this.remote}) - 현재 ${sessions.size}개`);
  }
}

function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const useTLS = TLS_CERT && TLS_KEY;
const server = useTLS
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handleRequest)
  : http.createServer(handleRequest);

if (EMULATION) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (err) {
      socket.destroy();
      return;
    }
    if (url.pathname !== '/emu') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const remote = req.socket.remoteAddress || '?';
      if (PASSWORD !== '' && !passwordMatches(url.searchParams.get('key'))) {
        ws.send(JSON.stringify({ t: 'error', code: 'auth', message: '비밀번호가 올바르지 않습니다' }));
        ws.close(1008, 'auth');
        return;
      }
      if (sessions.size >= MAX_SESSIONS) {
        ws.send(JSON.stringify({ t: 'error', code: 'full', message: '서버가 가득 찼습니다. 잠시 후 다시 시도하세요.' }));
        ws.close(1013, 'full');
        return;
      }
      const session = new Session(ws, remote);
      sessions.add(session);
      log(`세션 시작 (${remote}) - 현재 ${sessions.size}개`);
    });
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`포트 ${PORT} 가 이미 사용 중입니다. --port 로 다른 포트를 지정하세요.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const scheme = useTLS ? 'https' : 'http';
  console.log('');
  console.log('  juhyeonDS 실행 중');
  console.log('  ------------------------------------------');
  console.log(`  이 컴퓨터에서:   ${scheme}://localhost:${PORT}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal) console.log(`  같은 네트워크:   ${scheme}://${ni.address}:${PORT}`);
      }
    }
  } else {
    console.log('  (다른 기기에서 접속하려면 --public 옵션으로 실행하세요)');
  }
  console.log(`  서버 에뮬레이션: ${EMULATION ? `켜짐 (동시 ${MAX_SESSIONS}세션${PASSWORD ? ', 비밀번호 사용' : ''})` : '꺼짐'}`);
  console.log('  종료하려면 Ctrl+C');
  console.log('');

  if (args.tunnel) {
    require('./tunnel')
      .startTunnel(PORT, (line) => console.log(line))
      .then((tunnel) => {
        let site = '';
        try {
          site = require('../package.json').homepage || '';
        } catch (err) {
          /* optional */
        }
        console.log('');
        console.log('  ★ 다른 네트워크에서 접속할 수 있습니다');
        console.log('  ------------------------------------------');
        console.log(`  어디서나 접속:   ${tunnel.url}`);
        if (site) {
          console.log('  Google Drive까지 쓰려면 아래 주소로 접속하세요 (서버가 자동으로 연결됩니다):');
          console.log(`    ${site}?server=${tunnel.url}`);
        }
        console.log('  이 주소는 서버를 켤 때마다 바뀝니다. 주소를 아는 사람은 누구나 접속할 수 있으니');
        console.log('  필요하면 --password 옵션으로 비밀번호를 거세요.');
        console.log('');
      })
      .catch((err) => {
        console.error('');
        console.error('  [오류] 외부 접속을 켜지 못했습니다: ' + err.message);
        console.error('  같은 네트워크에서는 위 주소로 계속 사용할 수 있습니다.');
        console.error('');
      });
  }

  if (args.open) {
    const url = `${scheme}://localhost:${PORT}`;
    const { exec } = require('child_process');
    const command =
      process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(command, () => {});
  }
});
