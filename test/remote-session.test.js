'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { createServer } = require('node:net');
const path = require('node:path');
const { test } = require('node:test');
const { inflateRawSync } = require('node:zlib');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const HOST = '127.0.0.1';
const PROTOCOL = 'juhyeonds-v2';

async function freePort() {
  const probe = createServer().listen(0, HOST);
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function connect(t, port, protocols) {
  const socket = new WebSocket(`ws://${HOST}:${port}/emu?key=test-password`, protocols);
  const signal = new EventEmitter();
  const messages = [];
  socket.on('message', (data, binary) => {
    messages.push(binary ? data : JSON.parse(data));
    signal.emit('message');
  });
  t.after(() => socket.terminate());
  return {
    socket,
    send: (message) => socket.send(JSON.stringify(message)),
    async next(match) {
      const timeout = AbortSignal.timeout(5000);
      for (;;) {
        const index = messages.findIndex(match);
        if (index >= 0) return messages.splice(index, 1)[0];
        await once(signal, 'message', { signal: timeout });
      }
    },
  };
}

function smallGbaRom() {
  const rom = Buffer.alloc(32 * 1024);
  rom.writeUInt32LE(0xeafffffe, 0); // ARM branch to itself, with no game data
  rom.write('SMOKE', 0xa0, 'ascii');
  rom[0xb2] = 0x96;
  let checksum = 0x19;
  for (let offset = 0xa0; offset < 0xbd; offset++) checksum += rom[offset];
  rom[0xbd] = -checksum & 255;
  return rom;
}

test('a dropped connection resumes the upload and the running game in the same slot', { timeout: 20_000 }, async (t) => {
  const port = await freePort();
  const server = spawn(process.execPath, [
    'server/server.js', '--host', HOST, '--port', String(port), '--no-rom-cache',
    '--password', 'test-password', '--max-sessions', '1',
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => server.kill());
  const base = `http://${HOST}:${port}`;
  const info = () => fetch(base + '/api/info').then((response) => response.json());
  let ready;
  for (let attempt = 0; !ready && attempt < 50; attempt++) {
    ready = await info().catch(() => null);
    if (!ready) await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready?.emulation);
  assert.equal(ready.wifi, false);

  const rom = smallGbaRom();
  const save = Buffer.alloc(32 * 1024, 0xff);
  const first = connect(t, port, PROTOCOL);
  const { token } = await first.next((message) => message.t === 'session');
  assert.match(token, /^[0-9a-f]{64}$/);
  first.send({ t: 'start', system: 'gba', romSize: rom.length, saveSize: save.length });
  await first.next((message) => message.t === 'upload');
  first.socket.send(Buffer.concat([Buffer.from([1]), rom.subarray(0, 4096)]));
  first.socket.send(Buffer.concat([Buffer.from([2]), save.subarray(0, 1024)]));
  first.send({ t: 'ping', id: 'upload-confirmed' });
  await first.next((message) => message.id === 'upload-confirmed');
  first.socket.terminate();

  const second = connect(t, port, [PROTOCOL, token]);
  const upload = await second.next((message) => message.t === 'upload');
  assert.equal(upload.romBytes, 4096);
  assert.equal(upload.saveBytes, 1024);
  second.socket.send(Buffer.concat([Buffer.from([1]), rom.subarray(4096)]));
  second.socket.send(Buffer.concat([Buffer.from([2]), save.subarray(1024)]));
  second.send({ t: 'go' });
  const loaded = await second.next((message) => message.t === 'loaded');
  assert.equal(loaded.width, 240);
  const keyframe = (message) => Buffer.isBuffer(message) && message[0] === 0x20 && message[1] === 1;
  await second.next(keyframe);
  second.socket.terminate();

  const third = connect(t, port, [PROTOCOL, token]);
  assert.deepEqual(await third.next((message) => message.t === 'loaded'), loaded);
  assert.equal(inflateRawSync((await third.next(keyframe)).subarray(2)).length, 240 * 160 * 4);
  third.send({ t: 'getsave', id: 41 });
  third.send({ t: 'getsave', id: 42 });
  const requestedSave = (id) => (message) =>
    Buffer.isBuffer(message) && message.length >= 6 && message[0] === 0x22 &&
    message[1] === 3 && message.readUInt32BE(2) === id;
  await third.next(requestedSave(41));
  await third.next(requestedSave(42));
  assert.equal((await info()).sessions, 1);
  const closed = once(third.socket, 'close');
  third.send({ t: 'quit' });
  await closed;
  assert.equal((await info()).sessions, 0);

  const expired = connect(t, port, [PROTOCOL, token]);
  assert.equal((await expired.next((message) => message.t === 'error')).code, 'expired');
});
