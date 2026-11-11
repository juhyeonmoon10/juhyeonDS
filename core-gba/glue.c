/*
 * juhyeonDS - WebAssembly glue for the mGBA core (Game Boy Advance, Game Boy, Game Boy Color).
 *
 * Exposes the same C interface as the melonDS glue (core/glue.cpp) so the JavaScript side can
 * drive either core with the same code.
 *
 * mGBA is Copyright (c) 2013-2024 Jeffrey Pfau and is used under the Mozilla Public License 2.0.
 * This file is licensed under the GNU General Public License v3 or later.
 */
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

#include <mgba/core/blip_buf.h>
#include <mgba/core/config.h>
#include <mgba/core/core.h>
#include <mgba/core/log.h>
#include <mgba-util/vfs.h>

#define MAX_W 256
#define MAX_H 224
#define AUDIO_MAX 8192

static struct mCore* g_core = NULL;
static struct VFile* g_saveVf = NULL;
static uint8_t* g_rom = NULL;

static color_t g_video[MAX_W * MAX_H];
static uint8_t g_fb[MAX_W * MAX_H * 4];
static int16_t g_audio[AUDIO_MAX * 2];
static unsigned g_width = 240;
static unsigned g_height = 160;

static double g_sampleRate = 48000.0;
static uint32_t g_saveDirty = 0;
static uint32_t g_saveHash = 0;
static size_t g_saveSize = 0;
static uint32_t g_frame = 0;
static uint8_t* g_saveCopy = NULL;

/* Quiet logger: mGBA is chatty about unimplemented registers. */
static void quietLog(struct mLogger* logger, int category, enum mLogLevel level, const char* format, va_list args) {
	(void) logger;
	(void) category;
	if (!(level & (mLOG_FATAL | mLOG_ERROR))) {
		return;
	}
	vprintf(format, args);
	printf("\n");
}
static struct mLogger g_logger = { .log = quietLog };

static void unload(void) {
	if (g_core) {
		mCoreConfigDeinit(&g_core->config);
		g_core->deinit(g_core); /* closes the ROM and save VFiles */
		g_core = NULL;
	}
	g_saveVf = NULL;
	free(g_rom);
	g_rom = NULL;
}

static uint32_t saveHash(size_t* sizeOut) {
	*sizeOut = 0;
	if (!g_saveVf) {
		return 0;
	}
	size_t size = (size_t) g_saveVf->size(g_saveVf);
	*sizeOut = size;
	if (!size) {
		return 0;
	}
	const uint8_t* data = g_saveVf->map(g_saveVf, size, MAP_READ);
	if (!data) {
		return 0;
	}
	uint32_t h = 2166136261u;
	for (size_t i = 0; i < size; ++i) {
		h = (h ^ data[i]) * 16777619u;
	}
	g_saveVf->unmap(g_saveVf, (void*) data, size);
	return h;
}

static void setupAudio(void) {
	g_core->setAudioBufferSize(g_core, 4096);
	blip_set_rates(g_core->getAudioChannel(g_core, 0), g_core->frequency(g_core), g_sampleRate);
	blip_set_rates(g_core->getAudioChannel(g_core, 1), g_core->frequency(g_core), g_sampleRate);
}

static void readDimensions(void) {
	g_core->desiredVideoDimensions(g_core, &g_width, &g_height);
	if (g_width > MAX_W) g_width = MAX_W;
	if (g_height > MAX_H) g_height = MAX_H;
}

EMSCRIPTEN_KEEPALIVE uint8_t* mds_alloc(uint32_t size) { return malloc(size); }
EMSCRIPTEN_KEEPALIVE void mds_free(uint8_t* ptr) { free(ptr); }

EMSCRIPTEN_KEEPALIVE void mds_config(double sampleRate, int language) {
	(void) language;
	if (sampleRate >= 8000.0 && sampleRate <= 192000.0) {
		g_sampleRate = sampleRate;
	}
}

/* The cartridge clock follows the host clock, so there is nothing to set. */
EMSCRIPTEN_KEEPALIVE void mds_set_datetime(int y, int mo, int d, int h, int mi, int s) {
	(void) y; (void) mo; (void) d; (void) h; (void) mi; (void) s;
}
EMSCRIPTEN_KEEPALIVE void mds_set_log_level(int level) { (void) level; }
EMSCRIPTEN_KEEPALIVE void mds_set_bios(const uint8_t* a, const uint8_t* b) { (void) a; (void) b; }
EMSCRIPTEN_KEEPALIVE uint32_t mds_fault_count(void) { return 0; }
EMSCRIPTEN_KEEPALIVE void mds_set_lid(int closed) { (void) closed; }
EMSCRIPTEN_KEEPALIVE int mds_stop_reason(void) { return -1; }

/* Takes ownership of `rom` (from mds_alloc). `save` may be null and is copied. 0 on success. */
EMSCRIPTEN_KEEPALIVE int mds_load(uint8_t* rom, uint32_t romlen, const uint8_t* save, uint32_t savelen) {
	unload();
	mLogSetDefaultLogger(&g_logger);
	g_saveDirty = 0;
	g_frame = 0;
	memset(g_fb, 0, sizeof(g_fb));

	if (!rom || romlen < 0x150) {
		free(rom);
		return -1;
	}
	g_rom = rom;

	struct VFile* romVf = VFileFromMemory(rom, romlen);
	if (!romVf) {
		unload();
		return -2;
	}
	enum mPlatform platform = mCoreIsCompatible(romVf);
	if (platform == mPLATFORM_NONE) {
		romVf->close(romVf);
		unload();
		return -3;
	}
	g_core = mCoreCreate(platform);
	if (!g_core || !g_core->init(g_core)) {
		romVf->close(romVf);
		g_core = NULL;
		unload();
		return -2;
	}

	mCoreInitConfig(g_core, NULL);
	struct mCoreOptions opts = {
		.useBios = true,
		.volume = 0x100,
		.sampleRate = (unsigned) g_sampleRate,
	};
	mCoreConfigLoadDefaults(&g_core->config, &opts);
	mCoreLoadConfig(g_core);

	readDimensions();
	g_core->setVideoBuffer(g_core, g_video, MAX_W);
	setupAudio();

	if (!g_core->loadROM(g_core, romVf)) {
		romVf->close(romVf);
		unload();
		return -3;
	}

	g_saveVf = VFileMemChunk(save, save ? savelen : 0);
	if (g_saveVf) {
		g_core->loadSave(g_core, g_saveVf);
	}

	g_core->reset(g_core);
	readDimensions();
	setupAudio();
	g_saveHash = saveHash(&g_saveSize);
	return 0;
}

EMSCRIPTEN_KEEPALIVE void mds_reset(void) {
	if (g_core) {
		g_core->reset(g_core);
		setupAudio();
	}
}

EMSCRIPTEN_KEEPALIVE void mds_unload(void) { unload(); }

/* keys: bit set = pressed. Bits: A,B,Select,Start,Right,Left,Up,Down,R,L (same order as the DS). */
EMSCRIPTEN_KEEPALIVE int mds_run_frame(uint32_t keys, int touching, int tx, int ty) {
	(void) touching; (void) tx; (void) ty;
	if (!g_core) {
		return -1;
	}
	g_core->setKeys(g_core, keys & 0x3FF);
	g_core->runFrame(g_core);

	/* mGBA pixels are 0x00BBGGRR, i.e. bytes R,G,B,X: only the alpha byte needs setting. */
	uint32_t* dst = (uint32_t*) g_fb;
	for (unsigned y = 0; y < g_height; ++y) {
		const color_t* src = &g_video[y * MAX_W];
		for (unsigned x = 0; x < g_width; ++x) {
			*dst++ = src[x] | 0xFF000000u;
		}
	}

	/* Save memory is written in place; notice changes by hashing it twice a second. */
	if ((++g_frame % 30) == 0) {
		size_t size;
		uint32_t h = saveHash(&size);
		if (h != g_saveHash || size != g_saveSize) {
			g_saveHash = h;
			g_saveSize = size;
			if (size) {
				g_saveDirty++;
			}
		}
	}

	struct blip_t* left = g_core->getAudioChannel(g_core, 0);
	struct blip_t* right = g_core->getAudioChannel(g_core, 1);
	int avail = blip_samples_avail(left);
	if (avail > AUDIO_MAX) avail = AUDIO_MAX;
	if (avail <= 0) {
		return 0;
	}
	blip_read_samples(left, g_audio, avail, 1);
	blip_read_samples(right, g_audio + 1, avail, 1);
	return avail;
}

EMSCRIPTEN_KEEPALIVE uint8_t* mds_framebuffer(void) { return g_fb; }
EMSCRIPTEN_KEEPALIVE int16_t* mds_audio(void) { return g_audio; }
EMSCRIPTEN_KEEPALIVE int mds_screen_width(void) { return (int) g_width; }
EMSCRIPTEN_KEEPALIVE int mds_screen_height(void) { return (int) g_height; }

EMSCRIPTEN_KEEPALIVE uint32_t mds_save_len(void) {
	return g_saveVf ? (uint32_t) g_saveVf->size(g_saveVf) : 0;
}

/* Returns a copy that stays valid until the next call. */
EMSCRIPTEN_KEEPALIVE uint8_t* mds_save_ptr(void) {
	free(g_saveCopy);
	g_saveCopy = NULL;
	uint32_t size = mds_save_len();
	if (!size) {
		return NULL;
	}
	const uint8_t* data = g_saveVf->map(g_saveVf, size, MAP_READ);
	if (!data) {
		return NULL;
	}
	g_saveCopy = malloc(size);
	if (g_saveCopy) {
		memcpy(g_saveCopy, data, size);
	}
	g_saveVf->unmap(g_saveVf, (void*) data, size);
	return g_saveCopy;
}

EMSCRIPTEN_KEEPALIVE uint32_t mds_save_dirty(void) {
	uint32_t n = g_saveDirty;
	g_saveDirty = 0;
	return n;
}
