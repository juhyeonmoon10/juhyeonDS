/*
 * juhyeonDS - game files already sent to this server, kept on disk so that the same game
 * does not have to be uploaded again. Files are stored under their SHA-256, which the server
 * computes itself from the bytes it received. Only game files are kept; saves never are.
 * Licensed under the GNU General Public License v3 or later.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HASH_PATTERN = /^[0-9a-f]{64}$/;

class RomCache {
  /** @param dir folder to keep files in; @param maxBytes total size limit (0 disables the cache) */
  constructor(dir, maxBytes) {
    this.dir = dir;
    this.maxBytes = maxBytes;
    this.enabled = maxBytes > 0;
    if (this.enabled) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        this.enabled = false;
      }
    }
  }

  fileFor(hash) {
    return path.join(this.dir, hash + '.rom');
  }

  /** @returns true when a file with this hash and size is stored. */
  has(hash, size) {
    if (!this.enabled || !HASH_PATTERN.test(String(hash))) return false;
    try {
      return fs.statSync(this.fileFor(hash)).size === size;
    } catch (err) {
      return false;
    }
  }

  /** Reads a stored file and marks it as recently used. Resolves to an ArrayBuffer. */
  async read(hash) {
    const file = this.fileFor(hash);
    const data = await fs.promises.readFile(file);
    const now = new Date();
    fs.promises.utimes(file, now, now).catch(() => {});
    // Copy into a standalone ArrayBuffer so it can be transferred to the worker.
    const out = new Uint8Array(data.length);
    out.set(data);
    return out.buffer;
  }

  /** Stores the bytes under their own SHA-256 and trims the cache to its size limit. */
  async store(arrayBuffer) {
    if (!this.enabled) return '';
    const bytes = Buffer.from(arrayBuffer);
    if (bytes.length > this.maxBytes) return '';
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = this.fileFor(hash);
    try {
      if (!this.has(hash, bytes.length)) {
        const tmp = file + '.part';
        await fs.promises.writeFile(tmp, bytes);
        await fs.promises.rename(tmp, file);
      }
      await this.trim(file);
    } catch (err) {
      return '';
    }
    return hash;
  }

  /** Deletes the least recently used files until the total is within the limit. */
  async trim(keep) {
    const names = (await fs.promises.readdir(this.dir)).filter((n) => n.endsWith('.rom'));
    const entries = [];
    let total = 0;
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const stat = await fs.promises.stat(file);
        entries.push({ file, size: stat.size, used: stat.mtimeMs });
        total += stat.size;
      } catch (err) {
        /* removed meanwhile */
      }
    }
    entries.sort((a, b) => a.used - b.used);
    for (const entry of entries) {
      if (total <= this.maxBytes) break;
      if (entry.file === keep) continue;
      await fs.promises.unlink(entry.file).catch(() => {});
      total -= entry.size;
    }
  }

  summary() {
    if (!this.enabled) return { files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith('.rom')) continue;
        files++;
        bytes += fs.statSync(path.join(this.dir, name)).size;
      }
    } catch (err) {
      /* unreadable: report empty */
    }
    return { files, bytes };
  }
}

module.exports = { RomCache, HASH_PATTERN };
