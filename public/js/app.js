/*
 * juhyeonDS - user interface.
 * Licensed under the GNU General Public License v3 or later.
 */
import { LocalBackend } from './backend-local.js';
import { RemoteBackend, probeServer } from './backend-remote.js';
import { AudioPlayer } from './audio.js';
import { Input } from './input.js';
import * as storage from './storage.js';
import { Drive, preloadGIS } from './drive.js';

const $ = (id) => document.getElementById(id);
const config = window.MELONDS_CONFIG || {};
const settings = storage.loadSettings();

const SCREEN_BYTES = 256 * 192 * 4;
const ROM_EXT = /\.(nds|srl|dsi|ids)$/i;
const ZIP_EXT = /\.zip$/i;
const SAVE_EXT = /\.(sav|dsv|bak)$/i;
const STOP_REASONS = {
  2: '이 게임은 GBA 모드로 전환하려고 했지만, GBA 모드는 지원하지 않습니다.',
  3: '게임이 잘못된 메모리 영역을 실행해 멈췄습니다. ROM 파일이 손상되었거나 지원되지 않는 게임일 수 있습니다.',
  4: '게임이 전원을 껐습니다.',
};

const state = {
  rom: null, // { name, blob, id, title, code, source }
  save: null, // { name, data: Uint8Array, source: 'file' | 'drive' }
  autosave: null, // IndexedDB record for the selected ROM
  mode: 'local',
  serverInfo: null,
  backend: null,
  starting: false,
  playing: false,
  userPaused: false,
  menuPaused: false,
  hiddenPaused: false,
  lidClosed: false,
  saveLen: 0,
  lastSave: null,
  driveFiles: [],
  driveSyncTimer: null,
  driveSyncing: false,
  wakeLock: null,
};

const audio = new AudioPlayer();
const drive = new Drive(config.driveFolderName);

const topCanvas = $('screen-top');
const bottomCanvas = $('screen-bottom');
const topCtx = topCanvas.getContext('2d', { alpha: false });
const bottomCtx = bottomCanvas.getContext('2d', { alpha: false });
const topImage = topCtx.createImageData(256, 192);
const bottomImage = bottomCtx.createImageData(256, 192);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function toast(text, kind) {
  const el = document.createElement('div');
  el.className = 'toast' + (kind === 'error' ? ' error' : '');
  el.textContent = text;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'error' ? 6000 : 3200);
}

function busy(text, fraction) {
  $('busy').hidden = false;
  if (text) $('busy-text').textContent = text;
  const bar = $('busy-bar');
  bar.parentElement.style.visibility = fraction == null ? 'hidden' : 'visible';
  if (fraction != null) bar.style.width = Math.round(fraction * 100) + '%';
}

function busyOff() {
  $('busy').hidden = true;
}

/** Modal message. With {confirm:true} resolves to true/false, otherwise to true when dismissed. */
function message(title, body, opts) {
  opts = opts || {};
  const dlg = $('dlg-message');
  $('msg-title').textContent = title;
  $('msg-body').textContent = body;
  $('msg-cancel').hidden = !opts.confirm;
  $('msg-ok').textContent = opts.okText || '확인';
  $('msg-ok').classList.toggle('danger', !!opts.danger);
  return new Promise((resolve) => {
    let result = !opts.confirm;
    const ok = () => {
      result = true;
      dlg.close();
    };
    const cancel = () => {
      result = false;
      dlg.close();
    };
    const closed = () => {
      $('msg-ok').removeEventListener('click', ok);
      $('msg-cancel').removeEventListener('click', cancel);
      dlg.removeEventListener('close', closed);
      resolve(result);
    };
    $('msg-ok').addEventListener('click', ok);
    $('msg-cancel').addEventListener('click', cancel);
    dlg.addEventListener('close', closed);
    if (dlg.open) dlg.close();
    dlg.showModal();
  });
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1) + ' MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB';
  return bytes + ' B';
}

function formatDate(value) {
  const d = new Date(value);
  if (isNaN(d)) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function baseName(name) {
  return name.replace(/\.[^.\\/]+$/, '');
}

function saveFileName() {
  return state.rom ? baseName(state.rom.name) + '.sav' : 'save.sav';
}

function downloadBytes(data, name) {
  const url = URL.createObjectURL(new Blob([data], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function anyDialogOpen() {
  return !!document.querySelector('dialog[open]');
}

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------
async function setRom(name, blob, source) {
  if (ZIP_EXT.test(name)) {
    busy('압축 푸는 중…', null);
    try {
      const entries = window.fflate.unzipSync(new Uint8Array(await blob.arrayBuffer()), {
        filter: (file) => ROM_EXT.test(file.name),
      });
      const inner = Object.keys(entries)[0];
      if (!inner) throw new Error('압축 파일 안에 .nds 파일이 없습니다.');
      name = inner.split('/').pop();
      blob = new Blob([entries[inner]]);
    } finally {
      busyOff();
    }
  }
  if (blob.size < 0x200) throw new Error('ROM 파일이 너무 작습니다. 올바른 .nds 파일인지 확인하세요.');

  const head = new Uint8Array(await blob.slice(0, 0x200).arrayBuffer());
  const ascii = (bytes) =>
    Array.from(bytes)
      .filter((b) => b >= 0x20 && b < 0x7f)
      .map((b) => String.fromCharCode(b))
      .join('')
      .trim();
  const title = ascii(head.subarray(0, 12));
  const code = ascii(head.subarray(12, 16));
  const crc = head[0x15e] | (head[0x15f] << 8);
  const id = `${code || 'NONE'}-${title || 'UNTITLED'}-${crc.toString(16).padStart(4, '0')}`;

  state.rom = { name, blob, id, title, code, source };
  try {
    state.autosave = (await storage.getSave(id)) || null;
  } catch (err) {
    state.autosave = null;
  }
  renderHome();
  autoPickDriveSave().catch(() => {});
}

function setSave(name, data, source) {
  if (!data.length) throw new Error('세이브 파일이 비어 있습니다.');
  state.save = { name, data, source };
  renderHome();
}

function clearSave() {
  state.save = null;
  renderHome();
}

async function handleFiles(files) {
  for (const file of files) {
    try {
      if (SAVE_EXT.test(file.name)) {
        setSave(file.name, new Uint8Array(await file.arrayBuffer()), 'file');
      } else if (ROM_EXT.test(file.name) || ZIP_EXT.test(file.name)) {
        await setRom(file.name, file, 'file');
      } else {
        toast(`“${file.name}”은(는) 지원하지 않는 파일입니다 (.nds / .sav)`, 'error');
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }
}

function renderHome() {
  const romName = $('rom-name');
  if (state.rom) {
    romName.textContent = state.rom.name;
    romName.classList.remove('empty');
    romName.nextElementSibling.textContent =
      [state.rom.title, state.rom.code, formatSize(state.rom.blob.size), state.rom.source === 'drive' ? 'Google Drive' : '']
        .filter(Boolean)
        .join(' · ');
  } else {
    romName.textContent = '선택된 ROM 없음';
    romName.classList.add('empty');
    romName.nextElementSibling.textContent = '.nds 파일 (또는 .nds가 들어 있는 .zip)';
  }

  const saveName = $('save-name');
  const useAutosave = !state.save && !!state.autosave;
  if (state.save) {
    saveName.textContent = state.save.name;
    saveName.classList.remove('empty');
    $('save-hint').textContent =
      formatSize(state.save.data.length) + (state.save.source === 'drive' ? ' · Google Drive' : '') + ' · 이 세이브로 시작합니다';
  } else {
    saveName.textContent = '선택 안 함';
    saveName.classList.add('empty');
    $('save-hint').textContent = '.sav 파일 · 없으면 새 세이브를 만들어 시작합니다';
  }
  $('btn-save-clear').hidden = !state.save;
  $('autosave-row').hidden = !useAutosave;
  if (useAutosave) $('autosave-date').textContent = `(${formatDate(state.autosave.updated)})`;

  $('btn-start').disabled = !state.rom || state.starting;
  $('btn-start').textContent = state.rom ? '게임 시작' : 'ROM을 먼저 올려 주세요';
  renderDriveLists();
}

async function renderLocalSaves() {
  const list = $('local-save-list');
  let rows = [];
  try {
    rows = await storage.listSaves();
  } catch (err) {
    rows = [];
  }
  list.textContent = '';
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '아직 저장된 세이브가 없습니다. 게임 안에서 저장하면 여기에 자동으로 보관됩니다.';
    list.appendChild(li);
    return;
  }
  for (const row of rows) {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'fl-main';
    const name = document.createElement('span');
    name.className = 'fl-name';
    name.textContent = row.name || row.id;
    const meta = document.createElement('span');
    meta.className = 'fl-meta';
    meta.textContent = `${row.title || ''} · ${formatSize(row.data.length)} · ${formatDate(row.updated)}`;
    main.append(name, meta);

    const dl = document.createElement('button');
    dl.className = 'btn small';
    dl.textContent = '다운로드';
    dl.addEventListener('click', () => downloadBytes(row.data, row.name || row.id + '.sav'));

    const del = document.createElement('button');
    del.className = 'btn ghost small danger';
    del.textContent = '삭제';
    del.addEventListener('click', async () => {
      const ok = await message('세이브 삭제', `“${row.name || row.id}” 자동 저장 세이브를 이 브라우저에서 삭제할까요? 되돌릴 수 없습니다.`, {
        confirm: true,
        okText: '삭제',
        danger: true,
      });
      if (!ok) return;
      await storage.deleteSave(row.id);
      if (state.rom && state.rom.id === row.id) state.autosave = null;
      renderHome();
      renderLocalSaves();
    });
    li.append(main, dl, del);
    list.appendChild(li);
  }
}

// ---------------------------------------------------------------------------
// Execution mode (this device / server)
// ---------------------------------------------------------------------------
function setMode(mode) {
  if (mode === 'server' && !(state.serverInfo && state.serverInfo.emulation)) mode = 'local';
  state.mode = mode;
  settings.mode = mode;
  storage.saveSettings(settings);
  for (const [id, value] of [['mode-local', 'local'], ['mode-server', 'server']]) {
    $(id).classList.toggle('on', mode === value);
    $(id).setAttribute('aria-checked', String(mode === value));
  }
  $('server-password-row').hidden = !(mode === 'server' && state.serverInfo && state.serverInfo.passwordRequired);
}

async function initServerMode() {
  const info = await probeServer();
  state.serverInfo = info;
  const button = $('mode-server');
  const desc = $('mode-server-desc');
  if (info && info.emulation) {
    button.disabled = false;
    desc.textContent = '서버가 에뮬레이션하고 화면만 받아옵니다. 성능이 낮은 기기에 유리하며, ROM이 서버로 전송됩니다.';
    if (settings.mode === 'server') setMode('server');
  } else {
    button.disabled = true;
    desc.textContent = info
      ? '이 서버는 에뮬레이션 기능이 꺼져 있습니다.'
      : '에뮬레이션 서버를 찾지 못했습니다. start-server로 실행한 주소에서 사용할 수 있습니다.';
    setMode('local');
  }
}

// ---------------------------------------------------------------------------
// Running a game
// ---------------------------------------------------------------------------
function drawFrame(frame) {
  topImage.data.set(frame.subarray(0, SCREEN_BYTES));
  bottomImage.data.set(frame.subarray(SCREEN_BYTES, SCREEN_BYTES * 2));
  topCtx.putImageData(topImage, 0, 0);
  bottomCtx.putImageData(bottomImage, 0, 0);
}

function persistSave(data) {
  if (!state.rom || !data || !data.length) return Promise.resolve();
  state.lastSave = data;
  return storage
    .putSave(state.rom.id, saveFileName(), state.rom.title, data)
    .then(() => {
      $('menu-save-state').textContent = `마지막 자동 저장: ${formatDate(Date.now())} (이 브라우저)`;
    })
    .catch((err) => {
      toast('세이브를 브라우저에 보관하지 못했습니다: ' + err.message, 'error');
    });
}

function onGameSaved(data) {
  persistSave(data);
  flashHud('저장됨');
  if (settings.driveAutoSync && drive.tokenClient) {
    clearTimeout(state.driveSyncTimer);
    state.driveSyncTimer = setTimeout(() => uploadSaveToDrive(true), 4000);
  }
}

let hudFlash = '';
let hudFlashTimer = null;
let hudStats = '';
function flashHud(text) {
  hudFlash = text;
  clearTimeout(hudFlashTimer);
  hudFlashTimer = setTimeout(() => {
    hudFlash = '';
    renderHud();
  }, 1800);
  renderHud();
}
function renderHud() {
  const parts = [];
  if (settings.showFps && hudStats) parts.push(hudStats);
  if (hudFlash) parts.push(hudFlash);
  $('hud-text').textContent = parts.join(' · ');
  $('hud').style.display = parts.length ? '' : 'none';
}

async function startGame() {
  if (!state.rom || state.playing || state.starting) return;
  state.starting = true;
  renderHome();
  busy('준비 중…', null);

  const mode = state.mode;
  const backend = mode === 'server' ? new RemoteBackend($('server-password').value) : new LocalBackend();
  try {
    await audio.init(mode === 'server' ? 0.12 : 0.07);
    audio.setVolume(settings.volume / 100);

    let save = null;
    if (state.save) save = state.save.data;
    else if (state.autosave && $('chk-autosave').checked) save = state.autosave.data;

    backend.onFrame = drawFrame;
    backend.onAudio = (pcm) => audio.push(pcm);
    backend.onSave = onGameSaved;
    backend.onStats = (s) => {
      hudStats =
        `${s.fps.toFixed(0)}fps` +
        (mode === 'server' ? ` · 서버${s.ping != null ? ' ' + Math.round(s.ping) + 'ms' : ''}` : ` · ${Math.round(s.load * 100)}%`);
      renderHud();
    };
    backend.onError = (text) => {
      endGame(false).then(() => message('게임이 중단되었습니다', text + ' 마지막으로 저장된 세이브는 이 브라우저에 보관되어 있습니다.'));
    };
    backend.onStopped = (reason) => {
      message('게임이 멈췄습니다', STOP_REASONS[reason] || '에뮬레이터가 실행을 멈췄습니다.');
    };

    const now = new Date();
    const info = await backend.start({
      rom: state.rom.blob,
      save,
      sampleRate: audio.sampleRate,
      language: Number(settings.language),
      datetime: [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()],
      streamDivider: Number(settings.streamDivider),
      onProgress: busy,
    });

    state.backend = backend;
    state.saveLen = info.saveLen;
    state.lastSave = save ? save.slice() : null;
    enterPlayer();

    if (save && info.saveLen && save.length !== info.saveLen) {
      toast(`세이브 파일 크기(${formatSize(save.length)})가 이 게임의 세이브 크기(${formatSize(info.saveLen)})와 달라 맞춰서 불러왔습니다.`);
    }
  } catch (err) {
    backend.stop();
    await message('게임을 시작할 수 없습니다', err.message || String(err));
  } finally {
    state.starting = false;
    busyOff();
    renderHome();
  }
}

function enterPlayer() {
  state.playing = true;
  state.userPaused = false;
  state.menuPaused = false;
  state.hiddenPaused = false;
  state.lidClosed = false;
  hudStats = '';
  $('home').hidden = true;
  $('player').hidden = false;
  $('paused-badge').hidden = true;
  $('m-lid').textContent = '덮개 닫기';
  $('menu-title').textContent = state.rom.title || state.rom.name;
  $('menu-save-state').textContent = state.saveLen
    ? '게임 안에서 저장하면 이 브라우저에 자동으로 보관됩니다.'
    : '이 게임은 카트리지 세이브를 사용하지 않습니다.';
  document.body.classList.add('playing');
  applySettings();
  input.start();
  requestWakeLock();
  storage.requestPersistence();
  window.scrollTo(0, 0);
}

/** Leaves the player. With flush=true, pulls the latest save from the emulator first. */
async function endGame(flush) {
  if (!state.playing) return;
  const backend = state.backend;
  state.playing = false;
  input.stop();
  clearTimeout(state.driveSyncTimer);
  if (flush && backend) {
    try {
      const data = await backend.getSave();
      if (data.length) await persistSave(data);
    } catch (err) {
      /* the last automatic save is still in storage */
    }
  }
  if (backend) backend.stop();
  state.backend = null;
  audio.suspend();
  releaseWakeLock();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  for (const dlg of document.querySelectorAll('dialog[open]')) dlg.close();
  $('player').hidden = true;
  $('home').hidden = false;
  document.body.classList.remove('playing');
  topCtx.fillRect(0, 0, 256, 192);
  bottomCtx.fillRect(0, 0, 256, 192);
  if (state.rom) {
    try {
      state.autosave = (await storage.getSave(state.rom.id)) || null;
    } catch (err) {
      /* keep previous */
    }
  }
  renderHome();
  renderLocalSaves();
}

function updatePause() {
  if (!state.playing || !state.backend) return;
  const paused = state.userPaused || state.menuPaused || state.hiddenPaused;
  if (paused) {
    state.backend.pause();
    audio.suspend();
  } else {
    state.backend.resume();
    audio.resume();
  }
  $('paused-badge').hidden = !state.userPaused || state.menuPaused;
}

async function currentSaveData() {
  let data = new Uint8Array(0);
  if (state.backend) data = await state.backend.getSave();
  if (!data.length && state.lastSave) data = state.lastSave;
  return data;
}

async function downloadSave() {
  const data = await currentSaveData();
  if (!data.length) {
    toast('이 게임에는 내려받을 세이브 데이터가 없습니다.');
    return;
  }
  persistSave(data);
  downloadBytes(data, saveFileName());
  toast(`${saveFileName()} 다운로드를 시작했습니다.`);
}

async function requestWakeLock() {
  try {
    if (navigator.wakeLock) state.wakeLock = await navigator.wakeLock.request('screen');
  } catch (err) {
    state.wakeLock = null;
  }
}
function releaseWakeLock() {
  if (state.wakeLock) state.wakeLock.release().catch(() => {});
  state.wakeLock = null;
}

// ---------------------------------------------------------------------------
// Layout and settings
// ---------------------------------------------------------------------------
function vpadVisible() {
  if (settings.vpad === 'on') return true;
  if (settings.vpad === 'off') return false;
  return window.matchMedia('(pointer: coarse)').matches;
}

function layoutScreens() {
  if ($('player').hidden) return;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const pad = vpadVisible();
  const portrait = H >= W;
  const unit = Math.min(W, H) / 100;

  // Space kept clear for the on-screen pad: below the screens in portrait, beside them in landscape.
  let availW = W;
  let availH = H;
  if (pad && portrait) availH = H - Math.min(62 * unit, 320);
  if (pad && !portrait) availW = W - 2 * Math.min(50 * unit, 200);

  // Prefer a layout that keeps the screens clear of the pad; only when that would shrink the
  // picture below native size do we let the pad overlap instead.
  const pick = (aw, ah) => {
    const sv = Math.min(aw / 256, ah / 384);
    const sh = Math.min(aw / 512, ah / 192);
    let m = settings.layout;
    if (m !== 'vertical' && m !== 'horizontal') m = sh > sv * 1.02 ? 'horizontal' : 'vertical';
    return { mode: m, scale: m === 'horizontal' ? sh : sv };
  };
  let chosen = pick(availW, availH);
  if (chosen.scale < 1) chosen = pick(W, H);
  const mode = chosen.mode;
  const scale = chosen.scale;

  const cw = Math.max(1, Math.floor(256 * scale));
  const ch = Math.max(1, Math.floor(192 * scale));
  for (const canvas of [topCanvas, bottomCanvas]) {
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
  }
  const totalW = mode === 'horizontal' ? cw * 2 : cw;
  const totalH = mode === 'horizontal' ? ch : ch * 2;
  const screens = $('screens');
  screens.className = mode + (settings.filter === 'smooth' ? ' smooth' : '');
  screens.style.left = Math.max(0, Math.round((W - totalW) / 2)) + 'px';
  screens.style.top = pad && portrait ? '0px' : Math.max(0, Math.round((H - totalH) / 2)) + 'px';
}

function applySettings() {
  $('vpad').hidden = !vpadVisible();
  audio.setVolume(settings.volume / 100);
  layoutScreens();
  renderHud();
}

function openSettings() {
  $('s-vpad').value = settings.vpad;
  $('s-layout').value = settings.layout;
  $('s-filter').value = settings.filter;
  $('s-volume').value = settings.volume;
  $('s-lang').value = String(settings.language);
  $('s-streamfps').value = String(settings.streamDivider);
  $('s-showfps').checked = !!settings.showFps;
  $('s-driveauto').checked = !!settings.driveAutoSync;
  $('dlg-settings').showModal();
}

function bindSettings() {
  const bind = (id, key, read) => {
    $(id).addEventListener('change', () => {
      settings[key] = read($(id));
      storage.saveSettings(settings);
      applySettings();
      if (key === 'streamDivider' && state.backend) state.backend.setStreamDivider(settings.streamDivider);
      if (key === 'language' && state.playing) toast('게임 언어는 다음에 게임을 시작할 때 적용됩니다.');
      if (key === 'driveAutoSync' && settings.driveAutoSync && !drive.tokenClient) {
        toast('Drive 자동 저장은 Google Drive를 연결한 뒤에 동작합니다.');
      }
    });
  };
  bind('s-vpad', 'vpad', (el) => el.value);
  bind('s-layout', 'layout', (el) => el.value);
  bind('s-filter', 'filter', (el) => el.value);
  bind('s-lang', 'language', (el) => Number(el.value));
  bind('s-streamfps', 'streamDivider', (el) => Number(el.value));
  bind('s-showfps', 'showFps', (el) => el.checked);
  bind('s-driveauto', 'driveAutoSync', (el) => el.checked);
  $('s-volume').addEventListener('input', () => {
    settings.volume = Number($('s-volume').value);
    storage.saveSettings(settings);
    audio.setVolume(settings.volume / 100);
  });
  $('s-close').addEventListener('click', () => $('dlg-settings').close());
}

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------
function googleClientId() {
  return (config.googleClientId || settings.googleClientId || '').trim();
}

function renderDriveStatus() {
  const on = drive.connected || (!!drive.tokenClient && !!drive.token);
  $('drive-status').textContent = on ? '연결됨' : '연결 안 됨';
  $('drive-status').classList.toggle('ok', on);
  $('btn-drive-connect').hidden = on;
  $('btn-drive-disconnect').hidden = !on;
  $('drive-body').hidden = !on;
  $('drive-intro').hidden = on;
  $('drive-folder-name').textContent = drive.folderName;
}

function renderDriveLists() {
  const build = (listEl, files, emptyText, onPick, selectedName) => {
    listEl.textContent = '';
    if (!files.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = emptyText;
      listEl.appendChild(li);
      return;
    }
    for (const file of files) {
      const li = document.createElement('li');
      if (selectedName && selectedName === file.name) li.classList.add('sel');
      const main = document.createElement('div');
      main.className = 'fl-main';
      const name = document.createElement('span');
      name.className = 'fl-name';
      name.textContent = file.name;
      const meta = document.createElement('span');
      meta.className = 'fl-meta';
      meta.textContent = `${formatSize(file.size)} · ${formatDate(file.modifiedTime)}`;
      main.append(name, meta);

      const pick = document.createElement('button');
      pick.className = 'btn small';
      pick.textContent = '불러오기';
      pick.addEventListener('click', () => onPick(file));

      const del = document.createElement('button');
      del.className = 'btn ghost small danger';
      del.textContent = '삭제';
      del.setAttribute('aria-label', file.name + ' 삭제');
      del.addEventListener('click', () => deleteDriveFile(file));
      li.append(main, pick, del);
      listEl.appendChild(li);
    }
  };
  const roms = state.driveFiles.filter((f) => ROM_EXT.test(f.name) || ZIP_EXT.test(f.name));
  const saves = state.driveFiles.filter((f) => SAVE_EXT.test(f.name));
  build($('drive-roms'), roms, 'Drive에 올린 ROM이 없습니다.', pickDriveRom, state.rom && state.rom.source === 'drive' ? state.rom.name : '');
  build($('drive-saves'), saves, 'Drive에 올린 세이브가 없습니다.', pickDriveSave, state.save && state.save.source === 'drive' ? state.save.name : '');
}

async function refreshDrive() {
  state.driveFiles = await drive.list();
  renderDriveStatus();
  renderDriveLists();
}

function openDriveSetup() {
  $('drive-origin').textContent = location.origin;
  const insecure = location.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const warning = $('drive-origin-warning');
  warning.hidden = !insecure;
  if (insecure) {
    warning.textContent =
      'Google 로그인은 https:// 주소나 localhost에서만 동작합니다. 지금 주소(' + location.origin + ')에서는 연결할 수 없습니다.';
  }
  $('drive-client-id').value = settings.googleClientId || '';
  $('dlg-drive-setup').showModal();
}

async function connectDrive() {
  const clientId = googleClientId();
  if (!clientId) {
    openDriveSetup();
    return;
  }
  try {
    await drive.connect(clientId);
    renderDriveStatus();
    busy('Drive 목록을 불러오는 중…', null);
    await refreshDrive();
    toast('Google Drive에 연결했습니다.');
    autoPickDriveSave().catch(() => {});
  } catch (err) {
    toast(err.message, 'error');
    renderDriveStatus();
  } finally {
    busyOff();
  }
}

function findDriveFile(name) {
  const lower = name.toLowerCase();
  return state.driveFiles.find((f) => f.name.toLowerCase() === lower) || null;
}

async function pickDriveRom(file) {
  try {
    busy(`Drive에서 “${file.name}” 내려받는 중…`, 0);
    const bytes = await drive.download(file, (f) => busy(null, f));
    await setRom(file.name, new Blob([bytes]), 'drive');
    toast(`“${file.name}”을(를) 불러왔습니다.`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    busyOff();
  }
}

async function pickDriveSave(file) {
  try {
    busy(`Drive에서 “${file.name}” 내려받는 중…`, 0);
    const bytes = await drive.download(file, (f) => busy(null, f));
    setSave(file.name, bytes, 'drive');
    toast(`세이브 “${file.name}”을(를) 불러왔습니다.`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    busyOff();
  }
}

/** When a ROM is chosen and Drive holds a save with the matching name, select it automatically. */
async function autoPickDriveSave() {
  if (!state.rom || state.save || !drive.connected) return;
  const match = findDriveFile(saveFileName());
  if (!match) return;
  const driveTime = Date.parse(match.modifiedTime) || 0;
  if (state.autosave && state.autosave.updated > driveTime + 60000) {
    toast('Drive의 세이브보다 이 브라우저의 자동 저장이 더 최신이라, 자동 저장을 사용합니다.');
    return;
  }
  const rom = state.rom;
  const bytes = await drive.download(match);
  if (state.rom !== rom || state.save) return;
  setSave(match.name, bytes, 'drive');
  toast(`Drive에서 세이브 “${match.name}”을(를) 찾아 선택했습니다.`);
}

async function uploadFileToDrive(file, kind) {
  try {
    const existing = findDriveFile(file.name);
    if (existing) {
      const ok = await message('Drive에 같은 이름의 파일이 있습니다', `“${file.name}”을(를) 새 파일로 덮어쓸까요?`, {
        confirm: true,
        okText: '덮어쓰기',
      });
      if (!ok) return;
    }
    busy(`“${file.name}”을(를) Drive에 올리는 중…`, 0);
    await drive.upload(file.name, file, { existingId: existing && existing.id, onProgress: (f) => busy(null, f) });
    await refreshDrive();
    if (kind === 'rom') await setRom(file.name, file, 'drive');
    else setSave(file.name, new Uint8Array(await file.arrayBuffer()), 'drive');
    toast(`“${file.name}”을(를) Drive에 올렸습니다.`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    busyOff();
  }
}

async function deleteDriveFile(file) {
  const ok = await message('Drive에서 삭제', `“${file.name}”을(를) Google Drive에서 삭제할까요? (Drive 휴지통이 아니라 바로 삭제됩니다.)`, {
    confirm: true,
    okText: '삭제',
    danger: true,
  });
  if (!ok) return;
  try {
    busy('삭제 중…', null);
    await drive.remove(file.id);
    await refreshDrive();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    busyOff();
  }
}

/** Sends the running game's save to Drive, replacing the previous copy with the same name. */
async function uploadSaveToDrive(silent) {
  if (state.driveSyncing) return;
  if (!drive.tokenClient) {
    if (!silent) toast('먼저 처음 화면에서 Google Drive를 연결해 주세요.', 'error');
    return;
  }
  if (silent && !drive.connected) {
    // Renewing an expired sign-in needs a click, so background sync waits for the next manual save.
    flashHud('Drive 로그인 만료 - 메뉴에서 다시 저장하세요');
    return;
  }
  state.driveSyncing = true;
  try {
    const data = await currentSaveData();
    if (!data.length) {
      if (!silent) toast('올릴 세이브 데이터가 없습니다.');
      return;
    }
    if (!silent) busy('세이브를 Drive에 저장하는 중…', null);
    if (!state.driveFiles.length) state.driveFiles = await drive.list();
    const name = saveFileName();
    const existing = findDriveFile(name);
    const saved = await drive.upload(name, new Blob([data]), { existingId: existing && existing.id });
    state.driveFiles = state.driveFiles.filter((f) => f.id !== saved.id);
    state.driveFiles.unshift(saved);
    if (silent) flashHud('Drive에 저장됨');
    else toast(`Drive에 “${name}”을(를) 저장했습니다.`);
  } catch (err) {
    if (silent) flashHud('Drive 저장 실패');
    else toast(err.message, 'error');
  } finally {
    state.driveSyncing = false;
    if (!silent) busyOff();
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
const input = new Input({
  bottomCanvas,
  vpad: $('vpad'),
  onChange: (keys, touching, x, y) => {
    if (state.backend) state.backend.setInput(keys, touching, x, y);
  },
  isBlocked: () => !state.playing || anyDialogOpen(),
});

function openMenu() {
  if (!state.playing || $('dlg-menu').open) return;
  state.menuPaused = true;
  updatePause();
  $('m-pause').hidden = state.userPaused;
  $('m-fullscreen').hidden = !document.documentElement.requestFullscreen;
  $('m-fullscreen').textContent = document.fullscreenElement ? '전체 화면 끝내기' : '전체 화면';
  $('m-save-drive').disabled = !drive.tokenClient;
  $('m-save-drive').title = drive.tokenClient ? '' : '처음 화면에서 Google Drive를 연결하면 사용할 수 있습니다';
  $('dlg-menu').showModal();
}

function bindUI() {
  $('btn-rom').addEventListener('click', () => $('file-rom').click());
  $('btn-save').addEventListener('click', () => $('file-save').click());
  $('btn-save-clear').addEventListener('click', clearSave);
  for (const id of ['file-rom', 'file-save']) {
    $(id).addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (id === 'file-save' && files[0] && !SAVE_EXT.test(files[0].name)) {
        // Any file picked through the save button is treated as a save, whatever its extension.
        try {
          setSave(files[0].name, new Uint8Array(await files[0].arrayBuffer()), 'file');
        } catch (err) {
          toast(err.message, 'error');
        }
        return;
      }
      if (id === 'file-rom' && files[0] && !ROM_EXT.test(files[0].name) && !ZIP_EXT.test(files[0].name)) {
        try {
          await setRom(files[0].name, files[0], 'file');
        } catch (err) {
          toast(err.message, 'error');
        }
        return;
      }
      handleFiles(files);
    });
  }
  $('btn-start').addEventListener('click', startGame);
  $('btn-settings-home').addEventListener('click', openSettings);
  $('mode-local').addEventListener('click', () => setMode('local'));
  $('mode-server').addEventListener('click', () => setMode('server'));

  // Drive
  $('btn-drive-connect').addEventListener('click', connectDrive);
  $('btn-drive-disconnect').addEventListener('click', () => {
    drive.disconnect();
    drive.tokenClient = null;
    state.driveFiles = [];
    renderDriveStatus();
    renderDriveLists();
  });
  $('btn-drive-refresh').addEventListener('click', async () => {
    try {
      busy('Drive 목록을 불러오는 중…', null);
      await refreshDrive();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      busyOff();
    }
  });
  $('btn-drive-upload-rom').addEventListener('click', () => $('file-drive-rom').click());
  $('btn-drive-upload-save').addEventListener('click', () => $('file-drive-save').click());
  $('file-drive-rom').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) uploadFileToDrive(file, 'rom');
  });
  $('file-drive-save').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (file) uploadFileToDrive(file, 'save');
  });
  $('drive-setup-cancel').addEventListener('click', () => $('dlg-drive-setup').close());
  $('drive-setup-ok').addEventListener('click', () => {
    const value = $('drive-client-id').value.trim();
    if (!/\.apps\.googleusercontent\.com$/.test(value)) {
      toast('클라이언트 ID는 “….apps.googleusercontent.com” 형식이어야 합니다.', 'error');
      return;
    }
    settings.googleClientId = value;
    storage.saveSettings(settings);
    $('dlg-drive-setup').close();
    connectDrive();
  });

  // Player
  $('btn-menu').addEventListener('click', openMenu);
  $('dlg-menu').addEventListener('close', () => {
    state.menuPaused = false;
    updatePause();
  });
  $('m-resume').addEventListener('click', () => {
    state.userPaused = false;
    $('dlg-menu').close();
  });
  $('m-pause').addEventListener('click', () => {
    state.userPaused = true;
    $('dlg-menu').close();
  });
  $('paused-badge').addEventListener('click', () => {
    state.userPaused = false;
    updatePause();
  });
  $('m-save-download').addEventListener('click', downloadSave);
  $('m-save-drive').addEventListener('click', () => uploadSaveToDrive(false));
  $('m-fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => toast('전체 화면으로 전환할 수 없습니다.', 'error'));
    $('dlg-menu').close();
  });
  $('m-lid').addEventListener('click', () => {
    state.lidClosed = !state.lidClosed;
    if (state.backend) state.backend.setLid(state.lidClosed);
    $('m-lid').textContent = state.lidClosed ? '덮개 열기' : '덮개 닫기';
    $('dlg-menu').close();
    toast(state.lidClosed ? '덮개를 닫았습니다. 메뉴에서 다시 열 수 있습니다.' : '덮개를 열었습니다.');
  });
  $('m-settings').addEventListener('click', openSettings);
  $('m-reset').addEventListener('click', async () => {
    const ok = await message('게임 리셋', '게임을 처음부터 다시 시작할까요? 게임 안에서 저장하지 않은 진행 상황은 사라집니다.', {
      confirm: true,
      okText: '리셋',
    });
    if (!ok) return;
    if (state.backend) state.backend.reset();
    state.userPaused = false;
    if ($('dlg-menu').open) $('dlg-menu').close();
  });
  $('m-exit').addEventListener('click', async () => {
    const ok = await message('게임 종료', '게임을 끝내고 처음 화면으로 돌아갈까요? 게임 안에서 저장하지 않은 진행 상황은 사라집니다.', {
      confirm: true,
      okText: '종료',
    });
    if (ok) endGame(true);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.playing && !anyDialogOpen()) {
      e.preventDefault();
      openMenu();
    }
  });

  window.addEventListener('resize', layoutScreens);
  window.addEventListener('orientationchange', () => setTimeout(layoutScreens, 250));
  if (window.matchMedia) {
    const mq = window.matchMedia('(pointer: coarse)');
    if (mq.addEventListener) mq.addEventListener('change', applySettings);
  }

  document.addEventListener('visibilitychange', () => {
    if (!state.playing) return;
    state.hiddenPaused = document.hidden;
    updatePause();
    if (!document.hidden) requestWakeLock();
  });

  // Mobile browsers start audio suspended until a touch lands; nudge it on every interaction.
  for (const type of ['pointerdown', 'keydown']) {
    window.addEventListener(
      type,
      () => {
        if (state.playing && !(state.userPaused || state.menuPaused || state.hiddenPaused)) audio.resume();
      },
      { passive: true }
    );
  }

  // Drag and drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (state.playing || !e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    dragDepth++;
    $('drop-hint').hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if (!state.playing) e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('drop-hint').hidden = true;
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('drop-hint').hidden = true;
    if (state.playing || !e.dataTransfer) return;
    handleFiles(Array.from(e.dataTransfer.files || []));
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.playing) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

if (location.protocol === 'file:') {
  message(
    '실행 스크립트로 열어 주세요',
    '이 페이지는 파일을 직접 더블클릭해서 열면 동작하지 않습니다. 폴더의 start-local (Windows는 start-local.bat)을 실행한 뒤 표시되는 http://localhost 주소로 접속하세요.'
  );
}

bindUI();
bindSettings();
renderHome();
renderDriveStatus();
renderLocalSaves();
renderHud();
initServerMode();
if (googleClientId()) preloadGIS();

// Hook for automated tests.
window.__melon = { state, settings, audio, drive };
