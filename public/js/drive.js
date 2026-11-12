/*
 * juhyeonDS - Google Drive integration (Google Identity Services + Drive REST API v3).
 *
 * Uses the narrow "drive.file" scope: the app can only see files it created itself,
 * all kept in one folder. Nothing else in the user's Drive is readable.
 * Licensed under the GNU General Public License v3 or later.
 */

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FILE_FIELDS = 'id,name,size,modifiedTime';
// The sign-in is remembered here so that reloading the page does not ask again. Google only hands
// a web page a one-hour key (no permanent one without a server), so what is kept is that key, when
// it runs out, and which account to renew it for. Renewal needs no typing, only a click somewhere.
const STORE_KEY = 'juhyeonds.drive';
const RENEW_BEFORE_MS = 10 * 60 * 1000;

let gisPromise = null;
function loadGIS() {
  if (window.google && window.google.accounts && window.google.accounts.oauth2) return Promise.resolve();
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      gisPromise = null;
      reject(new Error('Google 로그인 스크립트를 불러오지 못했습니다. 네트워크나 광고 차단 설정을 확인하세요.'));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
}

export class DriveError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export class Drive {
  constructor(folderName) {
    this.folderName = folderName || 'juhyeonDS';
    this.clientId = '';
    this.tokenClient = null;
    this.token = '';
    this.expiresAt = 0;
    this.folderId = '';
    this.linked = false; // the user connected Drive and has not disconnected since
    this.hint = ''; // account e-mail, so that renewing never shows the account chooser
    this.renewing = null;
  }

  persist() {
    try {
      if (!this.linked) localStorage.removeItem(STORE_KEY);
      else {
        localStorage.setItem(
          STORE_KEY,
          JSON.stringify({ clientId: this.clientId, token: this.token, expiresAt: this.expiresAt, folderId: this.folderId, hint: this.hint })
        );
      }
    } catch (err) {
      /* storage unavailable: the sign-in just lasts until the page is closed */
    }
  }

  initClient(clientId) {
    if (this.tokenClient && this.clientId === clientId) return;
    this.clientId = clientId;
    this.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: () => {},
    });
  }

  /** Picks up the sign-in remembered from an earlier visit. Resolves to true when there is one. */
  async restore(clientId) {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORE_KEY));
    } catch (err) {
      /* nothing usable */
    }
    if (!saved || saved.clientId !== clientId) return false;
    this.clientId = clientId;
    this.token = saved.token || '';
    this.expiresAt = Number(saved.expiresAt) || 0;
    this.folderId = saved.folderId || '';
    this.hint = saved.hint || '';
    this.linked = true;
    this.ready = loadGIS().then(() => this.initClient(clientId));
    this.ready.catch(() => {});
    return true;
  }

  /** True when the one-hour key has run out or is about to. */
  get needsRenewal() {
    return this.linked && Date.now() > this.expiresAt - RENEW_BEFORE_MS;
  }

  /**
   * Gets a fresh key without a consent screen. Must be called from a click or key press:
   * Google opens a small window that closes by itself.
   */
  renew() {
    if (this.renewing) return this.renewing;
    this.renewing = (async () => {
      if (this.ready) await this.ready;
      if (!this.tokenClient) throw new DriveError('Google Drive에 연결되어 있지 않습니다.', 401);
      await this.requestToken('');
    })();
    const done = () => {
      this.renewing = null;
    };
    this.renewing.then(done, done);
    return this.renewing;
  }

  /** Remembers which account this is (best effort). */
  async learnAccount() {
    if (this.hint) return;
    try {
      const res = await this.request(`${API}/about?fields=user(emailAddress)`);
      this.hint = ((await res.json()).user || {}).emailAddress || '';
      this.persist();
    } catch (err) {
      /* renewing still works, it may just show the account chooser */
    }
  }

  get connected() {
    return !!this.token && Date.now() < this.expiresAt;
  }

  /** Opens Google's consent popup. Call from a click handler. */
  async connect(clientId) {
    await loadGIS();
    if (!this.tokenClient || this.clientId !== clientId) {
      this.tokenClient = null;
      this.initClient(clientId);
      this.folderId = '';
    }
    await this.requestToken(this.token ? '' : undefined);
    this.learnAccount();
  }

  requestToken(prompt) {
    return new Promise((resolve, reject) => {
      this.tokenClient.callback = (response) => {
        if (response.error) {
          reject(new DriveError('Google 인증 실패: ' + (response.error_description || response.error)));
          return;
        }
        if (!window.google.accounts.oauth2.hasGrantedAllScopes(response, SCOPE)) {
          reject(new DriveError('Drive 접근 권한이 허용되지 않았습니다. 다시 연결하면서 권한에 동의해 주세요.'));
          return;
        }
        this.token = response.access_token;
        this.expiresAt = Date.now() + (Number(response.expires_in) - 60) * 1000;
        this.linked = true;
        this.persist();
        resolve();
      };
      this.tokenClient.error_callback = (err) => {
        const type = err && err.type;
        if (type === 'popup_closed') reject(new DriveError('로그인 창이 닫혔습니다.'));
        else if (type === 'popup_failed_to_open') reject(new DriveError('로그인 창을 열 수 없습니다. 팝업 차단을 해제해 주세요.'));
        else reject(new DriveError('Google 인증에 실패했습니다.'));
      };
      const options = {};
      if (prompt !== undefined) options.prompt = prompt;
      if (prompt === '' && this.hint) options.login_hint = this.hint;
      this.tokenClient.requestAccessToken(options);
    });
  }

  disconnect() {
    if (this.token && window.google && window.google.accounts) {
      try {
        window.google.accounts.oauth2.revoke(this.token, () => {});
      } catch (err) {
        /* ignored */
      }
    }
    this.token = '';
    this.expiresAt = 0;
    this.folderId = '';
    this.linked = false;
    this.hint = '';
    this.persist();
  }

  async ensureToken() {
    if (this.connected) return;
    if (this.ready) await this.ready;
    if (!this.tokenClient) throw new DriveError('Google Drive에 연결되어 있지 않습니다.', 401);
    // The one-hour access token ran out. Ask again without a consent screen.
    await this.requestToken('');
  }

  async request(url, init) {
    await this.ensureToken();
    const doFetch = () =>
      fetch(url, Object.assign({}, init, { headers: Object.assign({}, init && init.headers, { Authorization: 'Bearer ' + this.token }) }));
    let res = await doFetch();
    if (res.status === 401) {
      this.expiresAt = 0;
      await this.ensureToken();
      res = await doFetch();
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = (body.error && body.error.message) || '';
      } catch (err) {
        /* no JSON body */
      }
      throw new DriveError('Drive 요청 실패 (' + res.status + ')' + (detail ? ': ' + detail : ''), res.status);
    }
    return res;
  }

  async ensureFolder() {
    if (this.folderId) return this.folderId;
    const q = `name = '${this.folderName.replace(/['\\]/g, '\\$&')}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
    const res = await this.request(`${API}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
    const found = (await res.json()).files || [];
    if (found.length) {
      this.folderId = found[0].id;
      this.persist();
      return this.folderId;
    }
    const created = await this.request(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.folderName, mimeType: FOLDER_MIME }),
    });
    this.folderId = (await created.json()).id;
    this.persist();
    return this.folderId;
  }

  /** @returns {Promise<Array<{id, name, size:number, modifiedTime:string}>>} */
  async list() {
    const folder = await this.ensureFolder();
    const q = `'${folder}' in parents and trashed = false`;
    const files = [];
    let pageToken = '';
    do {
      const url =
        `${API}/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(${FILE_FIELDS})` +
        `&orderBy=modifiedTime desc&pageSize=200&spaces=drive` +
        (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
      const body = await (await this.request(url)).json();
      for (const f of body.files || []) files.push({ id: f.id, name: f.name, size: Number(f.size || 0), modifiedTime: f.modifiedTime });
      pageToken = body.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  /** Downloads a file's bytes, reporting progress as a 0..1 fraction. */
  async download(file, onProgress) {
    const res = await this.request(`${API}/files/${encodeURIComponent(file.id)}?alt=media`);
    const total = file.size || Number(res.headers.get('Content-Length')) || 0;
    if (!res.body || !res.body.getReader) return new Uint8Array(await res.arrayBuffer());

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (onProgress && total) onProgress(Math.min(1, received / total));
    }
    const out = new Uint8Array(received);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }

  /**
   * Uploads (or replaces, when existingId is given) a file in the app folder.
   * @param {string} name
   * @param {Blob} blob
   * @param {{existingId?: string, onProgress?: (fraction:number)=>void}} [opts]
   */
  async upload(name, blob, opts) {
    opts = opts || {};
    const folder = await this.ensureFolder();
    const metadata = opts.existingId ? { name } : { name, parents: [folder] };
    const url = opts.existingId
      ? `${UPLOAD_API}/files/${encodeURIComponent(opts.existingId)}?uploadType=resumable&fields=${FILE_FIELDS}`
      : `${UPLOAD_API}/files?uploadType=resumable&fields=${FILE_FIELDS}`;

    const init = await this.request(url, {
      method: opts.existingId ? 'PATCH' : 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'application/octet-stream',
        'X-Upload-Content-Length': String(blob.size),
      },
      body: JSON.stringify(metadata),
    });
    const session = init.headers.get('Location');
    if (!session) throw new DriveError('Drive 업로드 세션을 시작하지 못했습니다.');

    const file = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', session);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => {
        if (opts.onProgress && e.lengthComputable) opts.onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch (err) {
            reject(new DriveError('Drive 응답을 해석하지 못했습니다.'));
          }
        } else {
          reject(new DriveError('Drive 업로드 실패 (' + xhr.status + ')', xhr.status));
        }
      };
      xhr.onerror = () => reject(new DriveError('네트워크 오류로 업로드하지 못했습니다.'));
      xhr.send(blob);
    });
    return { id: file.id, name: file.name, size: Number(file.size || blob.size), modifiedTime: file.modifiedTime };
  }

  async remove(id) {
    await this.request(`${API}/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

/** Loads Google's sign-in script ahead of time so the popup opens straight from the click. */
export function preloadGIS() {
  loadGIS().catch(() => {});
}
