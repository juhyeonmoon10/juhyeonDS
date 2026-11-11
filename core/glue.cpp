/*
    juhyeonDS - WebAssembly glue for the melonDS core.

    This file is part of a program built on melonDS (Copyright 2016-2025 melonDS team).
    It is free software: you can redistribute it and/or modify it under the terms of the
    GNU General Public License as published by the Free Software Foundation, either
    version 3 of the License, or (at your option) any later version.
*/

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <emscripten.h>

#include "Args.h"
#include "NDS.h"
#include "NDSCart.h"
#include "Platform.h"
#include "SPI_Firmware.h"
#include "SPU.h"
#include "GPU.h"
#include "GPU3D_Soft.h"

using namespace melonDS;

namespace
{
constexpr int kScreenW = 256;
constexpr int kScreenH = 192;
constexpr int kAudioMax = 8192; // stereo frames per emulated frame, generous

std::unique_ptr<NDS> g_nds;
u8 g_fb[kScreenW * kScreenH * 2 * 4]; // RGBA, top screen then bottom screen
s16 g_audio[kAudioMax * 2];

double g_sampleRate = 48000.0;
int g_language = 1; // English
int g_dt[6] = {2026, 1, 1, 12, 0, 0};

u32 g_saveDirty = 0;
bool g_stopped = false;
int g_stopReason = 0;
int g_logLevel = 2; // warnings and errors only
}

// ---------------------------------------------------------------------------
// Platform layer
// ---------------------------------------------------------------------------
namespace melonDS::Platform
{

void SignalStop(StopReason reason, void* userdata)
{
    g_stopped = true;
    g_stopReason = (int)reason;
}

std::string GetLocalFilePath(const std::string& filename) { return filename; }

static const char* ModeString(FileMode mode, bool exists)
{
    if (mode & FileMode::Append) return "ab";
    if (!(mode & FileMode::Write)) return "rb";
    if (mode & FileMode::Preserve)
    {
        if (exists) return "rb+";
        return (mode & FileMode::NoCreate) ? nullptr : "wb+";
    }
    return (mode & FileMode::Read) ? "wb+" : "wb";
}

bool FileExists(const std::string& name)
{
    FILE* f = fopen(name.c_str(), "rb");
    if (!f) return false;
    fclose(f);
    return true;
}
bool LocalFileExists(const std::string& name) { return FileExists(name); }

FileHandle* OpenFile(const std::string& path, FileMode mode)
{
    const char* m = ModeString(mode, FileExists(path));
    if (!m) return nullptr;
    return reinterpret_cast<FileHandle*>(fopen(path.c_str(), m));
}
FileHandle* OpenLocalFile(const std::string& path, FileMode mode) { return OpenFile(path, mode); }

bool CheckFileWritable(const std::string& filepath)
{
    FILE* f = fopen(filepath.c_str(), "ab");
    if (!f) return false;
    fclose(f);
    return true;
}
bool CheckLocalFileWritable(const std::string& filepath) { return CheckFileWritable(filepath); }

bool CloseFile(FileHandle* file) { return fclose(reinterpret_cast<FILE*>(file)) == 0; }
bool IsEndOfFile(FileHandle* file) { return feof(reinterpret_cast<FILE*>(file)) != 0; }
bool FileReadLine(char* str, int count, FileHandle* file) { return fgets(str, count, reinterpret_cast<FILE*>(file)) != nullptr; }
u64 FilePosition(FileHandle* file) { return (u64)ftell(reinterpret_cast<FILE*>(file)); }

bool FileSeek(FileHandle* file, s64 offset, FileSeekOrigin origin)
{
    int whence = SEEK_SET;
    if (origin == FileSeekOrigin::Current) whence = SEEK_CUR;
    else if (origin == FileSeekOrigin::End) whence = SEEK_END;
    return fseek(reinterpret_cast<FILE*>(file), (long)offset, whence) == 0;
}
void FileRewind(FileHandle* file) { rewind(reinterpret_cast<FILE*>(file)); }
u64 FileRead(void* data, u64 size, u64 count, FileHandle* file) { return fread(data, size, count, reinterpret_cast<FILE*>(file)); }
bool FileFlush(FileHandle* file) { return fflush(reinterpret_cast<FILE*>(file)) == 0; }
u64 FileWrite(const void* data, u64 size, u64 count, FileHandle* file) { return fwrite(data, size, count, reinterpret_cast<FILE*>(file)); }

u64 FileWriteFormatted(FileHandle* file, const char* fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    int ret = vfprintf(reinterpret_cast<FILE*>(file), fmt, args);
    va_end(args);
    return ret < 0 ? 0 : (u64)ret;
}

u64 FileLength(FileHandle* file)
{
    FILE* f = reinterpret_cast<FILE*>(file);
    long pos = ftell(f);
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, pos, SEEK_SET);
    return len < 0 ? 0 : (u64)len;
}

void Log(LogLevel level, const char* fmt, ...)
{
    if ((int)level < g_logLevel) return;
    va_list args;
    va_start(args, fmt);
    vprintf(fmt, args);
    va_end(args);
}

// The build is single-threaded: the software renderer runs inline.
struct Thread {};
Thread* Thread_Create(std::function<void()> func) { return nullptr; }
void Thread_Free(Thread* thread) {}
void Thread_Wait(Thread* thread) {}

struct Semaphore { int count = 0; };
Semaphore* Semaphore_Create() { return new Semaphore; }
void Semaphore_Free(Semaphore* sema) { delete sema; }
void Semaphore_Reset(Semaphore* sema) { sema->count = 0; }
void Semaphore_Wait(Semaphore* sema) { if (sema->count > 0) sema->count--; }
bool Semaphore_TryWait(Semaphore* sema, int timeout_ms)
{
    if (sema->count > 0) { sema->count--; return true; }
    return false;
}
void Semaphore_Post(Semaphore* sema, int count) { sema->count += count; }

struct Mutex {};
Mutex* Mutex_Create() { return new Mutex; }
void Mutex_Free(Mutex* mutex) { delete mutex; }
void Mutex_Lock(Mutex* mutex) {}
void Mutex_Unlock(Mutex* mutex) {}
bool Mutex_TryLock(Mutex* mutex) { return true; }

void Sleep(u64 usecs) {}
u64 GetMSCount() { return (u64)emscripten_get_now(); }
u64 GetUSCount() { return (u64)(emscripten_get_now() * 1000.0); }

void WriteNDSSave(const u8* savedata, u32 savelen, u32 writeoffset, u32 writelen, void* userdata)
{
    g_saveDirty++;
}
void WriteGBASave(const u8* savedata, u32 savelen, u32 writeoffset, u32 writelen, void* userdata) {}
void WriteFirmware(const Firmware& firmware, u32 writeoffset, u32 writelen, void* userdata) {}
void WriteDateTime(int year, int month, int day, int hour, int minute, int second, void* userdata) {}

void MP_Begin(void* userdata) {}
void MP_End(void* userdata) {}
int MP_SendPacket(u8* data, int len, u64 timestamp, void* userdata) { return 0; }
int MP_RecvPacket(u8* data, u64* timestamp, void* userdata) { return 0; }
int MP_SendCmd(u8* data, int len, u64 timestamp, void* userdata) { return 0; }
int MP_SendReply(u8* data, int len, u64 timestamp, u16 aid, void* userdata) { return 0; }
int MP_SendAck(u8* data, int len, u64 timestamp, void* userdata) { return 0; }
int MP_RecvHostPacket(u8* data, u64* timestamp, void* userdata) { return 0; }
u16 MP_RecvReplies(u8* data, u64 timestamp, u16 aidmask, void* userdata) { return 0; }

int Net_SendPacket(u8* data, int len, void* userdata) { return 0; }
int Net_RecvPacket(u8* data, void* userdata) { return 0; }

void Camera_Start(int num, void* userdata) {}
void Camera_Stop(int num, void* userdata) {}
void Camera_CaptureFrame(int num, u32* frame, int width, int height, bool yuv, void* userdata) {}

void Mic_Start(void* userdata) {}
void Mic_Stop(void* userdata) {}
int Mic_ReadInput(s16* data, int maxlength, void* userdata) { return 0; }

struct AACDecoder {};
AACDecoder* AAC_Init() { return nullptr; }
void AAC_DeInit(AACDecoder* dec) {}
bool AAC_Configure(AACDecoder* dec, int frequency, int channels) { return false; }
bool AAC_DecodeFrame(AACDecoder* dec, const void* input, int inputlen, void* output, int outputlen) { return false; }

bool Addon_KeyDown(KeyType type, void* userdata) { return false; }
void Addon_RumbleStart(u32 len, void* userdata) {}
void Addon_RumbleStop(void* userdata) {}
float Addon_MotionQuery(MotionQueryType type, void* userdata) { return 0.0f; }

DynamicLibrary* DynamicLibrary_Load(const char* lib) { return nullptr; }
void DynamicLibrary_Unload(DynamicLibrary* lib) {}
void* DynamicLibrary_LoadFunction(DynamicLibrary* lib, const char* name) { return nullptr; }

}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------
namespace
{
void ApplyDateTime()
{
    if (g_nds)
        g_nds->RTC.SetDateTime(g_dt[0], g_dt[1], g_dt[2], g_dt[3], g_dt[4], g_dt[5]);
}

void ConvertFramebuffer()
{
    if (!g_nds) return;
    const int front = g_nds->GPU.FrontBuffer;
    for (int screen = 0; screen < 2; screen++)
    {
        const u32* src = g_nds->GPU.Framebuffer[front][screen].get();
        u32* dst = reinterpret_cast<u32*>(g_fb + screen * kScreenW * kScreenH * 4);
        if (!src) continue;
        for (int i = 0; i < kScreenW * kScreenH; i++)
        {
            // core pixel: 0xAARRGGBB (little endian bytes B,G,R,A) -> canvas bytes R,G,B,A
            const u32 c = src[i];
            dst[i] = 0xFF000000u | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
        }
    }
}

void Boot()
{
    g_nds->Reset();
    ApplyDateTime();
    if (g_nds->NeedsDirectBoot())
        g_nds->SetupDirectBoot("game.nds");
    g_nds->Start();
    g_stopped = false;
    g_stopReason = 0;
}
}

extern "C"
{

EMSCRIPTEN_KEEPALIVE u8* mds_alloc(u32 size) { return new (std::nothrow) u8[size]; }
EMSCRIPTEN_KEEPALIVE void mds_free(u8* ptr) { delete[] ptr; }

// Settings that take effect at the next mds_load.
EMSCRIPTEN_KEEPALIVE void mds_config(double sampleRate, int language)
{
    if (sampleRate >= 8000.0 && sampleRate <= 192000.0) g_sampleRate = sampleRate;
    if (language >= 0 && language <= 5) g_language = language;
}

EMSCRIPTEN_KEEPALIVE void mds_set_datetime(int year, int month, int day, int hour, int minute, int second)
{
    g_dt[0] = year; g_dt[1] = month; g_dt[2] = day;
    g_dt[3] = hour; g_dt[4] = minute; g_dt[5] = second;
}

EMSCRIPTEN_KEEPALIVE void mds_set_log_level(int level) { g_logLevel = level; }

// Takes ownership of `rom` (allocated with mds_alloc). `save` may be null and is copied.
// Returns 0 on success, a negative value on failure.
EMSCRIPTEN_KEEPALIVE int mds_load(u8* rom, u32 romlen, const u8* save, u32 savelen)
{
    g_nds.reset();
    g_saveDirty = 0;
    memset(g_fb, 0, sizeof(g_fb));

    std::unique_ptr<u8[]> romdata(rom);
    if (!rom || romlen < 0x200) return -1;

    // Reject files whose header points outside the file before the core touches them.
    {
        auto rd32 = [&](u32 off) { u32 v; memcpy(&v, rom + off, 4); return v; };
        const u64 arm9off = rd32(0x20), arm9size = rd32(0x2C);
        const u64 arm7off = rd32(0x30), arm7size = rd32(0x3C);
        if (arm9size == 0 || arm9off + arm9size > romlen || arm7off + arm7size > romlen)
            return -3;
    }

    auto cart = NDSCart::ParseROM(std::move(romdata), romlen, nullptr, std::nullopt);
    if (!cart) return -2;
    if (save && savelen > 0)
        cart->SetSaveMemory(save, savelen);

    NDSArgs args;
    args.JIT = std::nullopt;
    args.OutputSampleRate = g_sampleRate;
    args.Interpolation = AudioInterpolation::Linear;
    {
        auto& user = args.Firmware.GetEffectiveUserData();
        user.Settings &= ~Firmware::Language::Reserved;
        user.Settings |= static_cast<Firmware::Language>(g_language);
        args.Firmware.UpdateChecksums();
    }

    g_nds = std::make_unique<NDS>(std::move(args), nullptr);
    NDS::Current = g_nds.get();
    g_nds->SetNDSCart(std::move(cart));
    Boot();
    return 0;
}

EMSCRIPTEN_KEEPALIVE void mds_reset()
{
    if (!g_nds) return;
    Boot();
}

EMSCRIPTEN_KEEPALIVE void mds_unload()
{
    if (g_nds) g_nds->Stop();
    g_nds.reset();
}

// keys: bit set = pressed. Bits: A,B,Select,Start,Right,Left,Up,Down,R,L,X,Y
// Returns the number of stereo audio frames written to mds_audio(), or -1 if stopped.
EMSCRIPTEN_KEEPALIVE int mds_run_frame(u32 keys, int touching, int tx, int ty)
{
    if (!g_nds) return -1;
    if (g_stopped) return -1;

    g_nds->SetKeyMask(~keys & 0xFFF);
    if (touching)
    {
        if (tx < 0) tx = 0; if (tx > 255) tx = 255;
        if (ty < 0) ty = 0; if (ty > 191) ty = 191;
        g_nds->TouchScreen((u16)tx, (u16)ty);
    }
    else
    {
        g_nds->ReleaseScreen();
    }

    g_nds->RunFrame();
    ConvertFramebuffer();

    int avail = g_nds->SPU.GetOutputSize();
    if (avail > kAudioMax) avail = kAudioMax;
    if (avail <= 0) return 0;
    return g_nds->SPU.ReadOutput(g_audio, avail);
}

EMSCRIPTEN_KEEPALIVE u8* mds_framebuffer() { return g_fb; }
EMSCRIPTEN_KEEPALIVE s16* mds_audio() { return g_audio; }

EMSCRIPTEN_KEEPALIVE u8* mds_save_ptr() { return g_nds ? g_nds->GetNDSSave() : nullptr; }
EMSCRIPTEN_KEEPALIVE u32 mds_save_len() { return g_nds ? g_nds->GetNDSSaveLength() : 0; }

// Number of save writes since the last call.
EMSCRIPTEN_KEEPALIVE u32 mds_save_dirty()
{
    u32 n = g_saveDirty;
    g_saveDirty = 0;
    return n;
}

EMSCRIPTEN_KEEPALIVE void mds_set_lid(int closed)
{
    if (g_nds) g_nds->SetLidClosed(closed != 0);
}

EMSCRIPTEN_KEEPALIVE int mds_stop_reason() { return g_stopped ? g_stopReason : -1; }

}
