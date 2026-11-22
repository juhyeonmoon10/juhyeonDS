/*
 * juhyeonDS - ZIP extraction outside the UI thread.
 * Licensed under the GNU General Public License v3 or later.
 */
importScripts('systems.js', 'vendor/fflate.js');

self.onmessage = async ({ data: archive }) => {
  try {
    let selected;
    const entries = self.fflate.unzipSync(new Uint8Array(await archive.arrayBuffer()), {
      filter(file) {
        if (selected) return false;
        const system = self.EmuSystems.forFileName(file.name);
        if (!system) return false;
        if (file.originalSize > system.maxRomBytes) {
          throw new Error(`ZIP 안의 “${file.name}”이(가) ${system.label} ROM 크기 제한을 초과합니다.`);
        }
        if (file.originalSize < 0x200 || file.size > archive.size ||
            (file.compression === 0 && file.size !== file.originalSize)) {
          throw new Error('ZIP 안의 ROM 크기가 올바르지 않습니다.');
        }
        selected = file;
        return true;
      },
    });
    if (!selected) throw new Error('압축 파일 안에 게임 파일(.nds, .gba, .gb, .gbc)이 없습니다.');
    const bytes = entries[selected.name];
    if (bytes.length !== selected.originalSize) throw new Error('압축을 푼 ROM 크기가 올바르지 않습니다.');
    self.postMessage({ name: selected.name.split('/').pop(), blob: new Blob([bytes]) });
  } catch (err) {
    self.postMessage({ error: err.message || String(err) });
  }
};
