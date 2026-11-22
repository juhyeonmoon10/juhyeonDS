/* juhyeonDS - packet exchange with a native libslirp process per DS session. GPL-3.0-or-later. */
'use strict';

const { spawn } = require('node:child_process');
const MAX_FRAME = 2048;
const MAX_PENDING = 64 * 1024;

function wifiProfile(value) {
  if (!value || typeof value.mac !== 'string' || !/^[0-9a-f]{12}$/.test(value.mac)) return null;
  const mac = Buffer.from(value.mac, 'hex');
  if ((mac[0] & 3) !== 2) return null; // locally administered unicast MAC
  const settings = value.settings || '';
  if (typeof settings !== 'string' || (settings && !/^[A-Za-z0-9+/]{1024}$/.test(settings))) return null;
  return { mac, settings: settings ? Buffer.from(settings, 'base64') : null };
}

function startWifi(executable, onFrame, onError) {
  const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  let pending = Buffer.alloc(0);
  let started = false;
  let closed = false;
  let resolveReady, rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const timeout = setTimeout(() => stop(new Error('DS Wi-Fi 시작 시간이 초과되었습니다.')), 5000);

  function stop(error) {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    child.kill();
    if (!started) rejectReady(error || new Error('DS Wi-Fi가 종료되었습니다.'));
    else if (error) onError(error);
  }

  child.on('error', stop);
  child.on('exit', () => stop(new Error('DS Wi-Fi 프로세스가 종료되었습니다.')));
  child.stdin.on('error', stop);
  child.stdout.on('error', stop);
  child.stdout.on('data', (chunk) => {
    if (closed) return;
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;
    while (pending.length - offset >= 2) {
      const length = pending.readUInt16BE(offset);
      if (!started && length === 0) {
        started = true;
        clearTimeout(timeout);
        resolveReady();
      } else {
        if (!started || length < 14 || length > MAX_FRAME) {
          stop(new Error('DS Wi-Fi 패킷 형식이 올바르지 않습니다.'));
          return;
        }
        if (pending.length - offset < length + 2) break;
        onFrame(Uint8Array.from(pending.subarray(offset + 2, offset + 2 + length)));
      }
      offset += length + 2;
    }
    pending = pending.subarray(offset);
  });

  return {
    ready,
    stop,
    send(bytes) {
      if (closed || !started || bytes.length < 14 || bytes.length > MAX_FRAME ||
          child.stdin.writableLength > MAX_PENDING) return;
      const packet = Buffer.allocUnsafe(bytes.length + 2);
      packet.writeUInt16BE(bytes.length, 0);
      packet.set(bytes, 2);
      child.stdin.write(packet);
    },
  };
}

module.exports = { startWifi, wifiProfile };
