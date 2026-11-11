/*
 * juhyeonDS - tells the web page which servers are switched on.
 *
 * A static page (GitHub Pages) has no way to know a server's tunnel address, which changes on
 * every start. While running, the server posts its address to a public bulletin board
 * (an ntfy topic named in public/config.js) every few minutes; the page reads the board and
 * lists the servers that answer. Only the address, a display name and whether a password is
 * needed are posted - never games or saves.
 * Licensed under the GNU General Public License v3 or later.
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const INTERVAL_MS = 10 * 60 * 1000;

/** Reads serverDirectory / serverDirectoryHost from public/config.js. */
function readDirectoryConfig() {
  try {
    const text = fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8');
    const pick = (key) => {
      const m = text.match(new RegExp('^\\s*' + key + '\\s*:\\s*"([^"]*)"', 'm'));
      return m ? m[1].trim() : '';
    };
    return { topic: process.env.JUHYEONDS_DIRECTORY || pick('serverDirectory'), host: pick('serverDirectoryHost') || 'https://ntfy.sh' };
  } catch (err) {
    return { topic: '', host: 'https://ntfy.sh' };
  }
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, 'utf8');
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'text/plain', 'Content-Length': data.length }, timeout: 10000 }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error('HTTP ' + res.statusCode));
    });
    req.on('timeout', () => req.destroy(new Error('시간 초과')));
    req.on('error', reject);
    req.end(data);
  });
}

/**
 * Starts announcing. Resolves to true once the first announcement went through.
 * @param {{url: string, name: string, passwordRequired: boolean}} server
 */
function startAnnouncing(server) {
  const { topic, host } = readDirectoryConfig();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(topic)) return Promise.resolve(false);
  const target = host.replace(/\/+$/, '') + '/' + topic;
  const send = (extra) => post(target, JSON.stringify(Object.assign({ v: 1, u: server.url, n: String(server.name || '').slice(0, 40), p: server.passwordRequired ? 1 : 0 }, extra)));
  const timer = setInterval(() => send().catch(() => {}), INTERVAL_MS);
  timer.unref();
  // Best effort: take the server off the list straight away on Ctrl+C.
  let leaving = false;
  process.on('SIGINT', () => {
    if (leaving) return;
    leaving = true;
    const done = () => process.exit(0);
    send({ off: 1 }).then(done, done);
    setTimeout(done, 3000).unref();
  });
  return send().then(() => true);
}

module.exports = { startAnnouncing, readDirectoryConfig };
