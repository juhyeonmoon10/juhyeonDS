# juhyeonDS

웹 브라우저에서 실행하는 DS · GBA 에뮬레이터입니다. DS는 [melonDS](https://melonds.kuribo64.net/) 1.1, GBA와 GB/GBC는 [mGBA](https://mgba.io/) 0.10.5 코어를 WebAssembly로 빌드해 사용합니다.

- 지원 기종: Nintendo DS(.nds), Game Boy Advance(.gba), Game Boy / Color(.gb, .gbc) — 파일 확장자로 자동 구분
- ROM 파일 올리기, 세이브 파일(.sav) 올리기 — 세이브가 없으면 새 세이브를 만들어 시작
- 배속 2·3·4배(화면의 ×1 버튼 또는 Space/Tab), 앱으로 설치(PWA), 오프라인 실행
- 세이브 데이터 다운로드, 브라우저 자동 보관
- Google Drive 연동: ROM·세이브를 올려 두고 어느 기기에서든 불러오기, 게임 중 세이브를 Drive에 저장
- 실행 위치 선택: **이 기기에서 실행**(브라우저가 에뮬레이션) / **서버에서 실행**(서버가 에뮬레이션, 화면·소리만 전송)
- PC(키보드·게임패드), 휴대폰·태블릿(터치 가상 패드), 크롬북 지원

BIOS·펌웨어 파일은 필요 없습니다(melonDS 내장 FreeBIOS와 생성 펌웨어 사용). 단, 암호화된 ROM 덤프는 BIOS 파일을 등록해야 실행됩니다(5장 참고).

---

## 1. 실행하기

[Node.js](https://nodejs.org) 18 이상이 필요합니다. 별도 설치(`npm install`)는 필요 없습니다.

### 내 컴퓨터에서만 쓰기

| 운영체제 | 실행 |
| --- | --- |
| Windows | `start-local.bat` 더블클릭 |
| macOS / Linux / 크롬북(Linux) | `./start-local.sh` |

브라우저가 `http://localhost:8080` 으로 열립니다. `index.html`을 직접 더블클릭해서 여는 방식은 동작하지 않습니다.

Node.js가 없으면 Python으로 대신 실행됩니다(이때는 “서버에서 실행” 모드를 쓸 수 없습니다).

### 서버로 호스팅하기 (다른 기기에서 접속)

| 운영체제 | 실행 |
| --- | --- |
| Windows | `start-server.bat` |
| macOS / Linux | `./start-server.sh` |

실행하면 `http://192.168.x.x:8080` 같은 접속 주소가 표시됩니다. 같은 네트워크의 휴대폰·크롬북에서 그 주소로 접속하세요.

옵션:

```
start-server --password 1234      서버 에뮬레이션에 비밀번호 걸기
             --port 8080          포트 변경
             --max-sessions 4     동시에 서버에서 돌릴 수 있는 게임 수
             --no-emulation       정적 파일만 제공(서버 에뮬레이션 끄기)
             --cert c.pem --key k.pem   HTTPS로 제공
```

환경 변수 `PORT`, `HOST`, `PASSWORD`, `MAX_SESSIONS`, `TLS_CERT`, `TLS_KEY`도 같은 역할을 합니다.

### 다른 네트워크에서 서버 쓰기 (모바일 데이터, 다른 와이파이)

| 운영체제 | 실행 |
| --- | --- |
| Windows | `start-server-anywhere.bat` |
| macOS / Linux | `./start-server-anywhere.sh` |

Cloudflare의 무료 터널을 써서 PC의 서버에 `https://….trycloudflare.com` 형태의 공개 주소를 붙입니다. 공유기 설정이나 계정이 필요 없습니다. 처음 실행할 때 터널 프로그램 `cloudflared`(Cloudflare 공식 배포판, 약 55MB)를 `tools/` 폴더에 내려받습니다.

실행하면 주소가 두 개 표시됩니다.

- **어디서나 접속**: `https://….trycloudflare.com` — 이 주소로 바로 접속하면 됩니다.
- **Google Drive까지 쓰려면**: `https://juhyeonmoon10.github.io/juhyeonDS/public/?server=https://….trycloudflare.com` — GitHub Pages 사이트가 열리면서 서버가 자동으로 연결됩니다. 홈 화면의 “서버 주소” 칸에 터널 주소를 직접 넣어도 같습니다.

알아둘 점:

- 터널 주소는 서버를 켤 때마다 바뀝니다.
- 주소를 아는 사람은 누구나 접속해 PC의 CPU를 쓸 수 있습니다. `--password 1234`로 비밀번호를 걸 수 있습니다.
- 게임 파일을 인터넷으로 올려야 하므로 큰 ROM은 시작이 오래 걸리고, 화면 전송량이 큰 3D 게임은 모바일 데이터를 많이 씁니다. 설정에서 30fps 전송을 고르면 줄어듭니다.
- PC가 켜져 있고 검은 창이 떠 있는 동안에만 동작합니다.

### 인터넷에 올리기

- **정적 호스팅** (GitHub Pages, Netlify, Cloudflare Pages 등): `public/` 폴더 안의 파일만 올리면 됩니다. “이 기기에서 실행” 모드와 Google Drive가 동작합니다.
- **Node 호스팅** (Render, Railway, Fly.io, 개인 서버 등): 폴더 전체를 올리고 `npm start -- --public` 으로 실행합니다. 두 모드 모두 동작합니다. 대부분의 호스팅은 `PORT` 환경 변수를 자동으로 넘겨 줍니다.
- 페이지는 정적 호스팅에, 에뮬레이션 서버는 다른 곳에 두려면 `public/config.js`의 `serverUrl`에 서버 주소를 적습니다.

> **주의**: `http://192.168.x.x` 처럼 https가 아닌 주소에서는 브라우저 보안 정책 때문에 Google 로그인을 쓸 수 없습니다. Google Drive는 `https://` 주소 또는 `http://localhost` 에서만 동작합니다.

---

## 2. 사용법

1. **ROM 파일 올리기**로 `.nds`, `.gba`, `.gb`, `.gbc` 파일을 고릅니다(이 파일이 든 `.zip`도 가능, 끌어다 놓기도 가능).
2. 이어서 할 세이브가 있으면 **세이브 파일 올리기**로 `.sav`를 고릅니다. 없으면 건너뜁니다.
3. 실행 위치를 고르고 **게임 시작**을 누릅니다.

게임 중에는 오른쪽 위 **☰** 버튼(또는 `Esc`)으로 메뉴를 엽니다: 일시정지, 세이브 데이터 다운로드, Drive에 저장, 전체 화면, 덮개 닫기, 리셋, 설정, 종료.

### 세이브가 저장되는 방식

- 게임 안에서 저장하면 그 즉시 브라우저 저장소(IndexedDB)에 자동으로 보관됩니다. 다음에 같은 ROM을 고르면 “자동 저장된 세이브 이어하기”가 나타납니다.
- **세이브 데이터 다운로드**는 `게임이름.sav` 파일로 내려받습니다. melonDS·DeSmuME 등 다른 에뮬레이터와 같은 원본(raw) 형식입니다.
- 브라우저 데이터를 지우면 자동 보관된 세이브도 지워집니다. 중요한 세이브는 다운로드하거나 Drive에 저장해 두세요.
- 상태 저장(세이브 스테이트)은 지원하지 않습니다. 게임 자체의 저장 기능을 사용합니다.

### 조작

| DS | 키보드 | 게임패드(표준 배치) |
| --- | --- | --- |
| 십자 버튼 | 방향키 | 십자 버튼 / 왼쪽 스틱 |
| A / B | X / Z | 오른쪽 / 아래쪽 버튼 |
| X / Y | S / A | 위쪽 / 왼쪽 버튼 |
| L / R | Q / W | L1 / R1 |
| START / SELECT | Enter / Shift | Start / Select |
| 터치스크린 | 아래 화면을 마우스로 클릭·드래그 | — |
| 배속 | Space 또는 Tab을 누르는 동안 3배속 | 화면의 ×1 버튼을 누를 때마다 ×2 → ×3 → ×4 → ×1 |

터치 기기에서는 가상 패드가 자동으로 표시됩니다(설정에서 끄거나 항상 켤 수 있습니다).

---

### 앱으로 설치하기 (크롬북, PC, 휴대폰)

`https://` 주소(GitHub Pages 등)나 `localhost`에서 열면 앱으로 설치할 수 있습니다.

- **크롬북 · PC의 Chrome/Edge**: 홈 화면 오른쪽 위의 **⬇ 앱으로 설치** 버튼을 누르거나, 주소창 오른쪽의 설치 아이콘을 누릅니다. 설치하면 런처(앱 목록)에 juhyeonDS가 생기고 주소창 없는 독립 창으로 열립니다.
- **Android Chrome**: 메뉴(⋮) → “앱 설치” 또는 “홈 화면에 추가”.
- **iPhone Safari**: 공유 버튼 → “홈 화면에 추가”.

한 번 연 뒤에는 인터넷이 없어도 “이 기기에서 실행”으로 게임을 할 수 있습니다. 설치한 앱에서는 파일 관리자에서 `.nds`/`.gba` 파일을 juhyeonDS로 바로 열 수도 있습니다(Chrome 계열).

## 3. Google Drive 연동 설정

Google 정책상 Drive API를 쓰려면 사이트 운영자가 **OAuth 클라이언트 ID**를 직접 발급해야 합니다(무료, 5분 정도).

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 만듭니다.
2. “API 및 서비스 → 라이브러리”에서 **Google Drive API**를 사용 설정합니다.
3. “OAuth 동의 화면”(Google 인증 플랫폼)을 **외부**로 구성하고, **테스트 사용자**에 사용할 Google 계정을 추가합니다.
   (게시 상태가 “테스트”인 동안은 등록한 테스트 사용자만 로그인할 수 있습니다.)
4. “사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID → 웹 애플리케이션”을 선택하고,
   **승인된 자바스크립트 원본**에 사이트 주소를 넣습니다. 예: `http://localhost:8080`, `https://내도메인`
5. 발급된 클라이언트 ID(`…apps.googleusercontent.com`)를 다음 중 한 곳에 넣습니다.
   - `public/config.js`의 `googleClientId` — 모든 방문자에게 적용
   - 또는 사이트에서 “Google Drive → 연결”을 누르면 나오는 입력 창 — 그 브라우저에만 저장

동작 방식:

- 가장 좁은 권한인 `drive.file`만 요청합니다. 이 앱은 **자신이 올린 파일만** 볼 수 있고, Drive의 다른 파일은 읽지 못합니다.
- 파일은 Drive의 “juhyeonDS” 폴더에 저장됩니다(`config.js`에서 이름 변경 가능).
- Drive 웹사이트에서 직접 넣은 파일은 목록에 나타나지 않습니다. 사이트의 **ROM을 Drive에 올리기 / 세이브를 Drive에 올리기** 버튼으로 올려 주세요.
- ROM을 고르면 Drive에서 같은 이름의 세이브(`게임이름.sav`)를 찾아 자동으로 선택합니다. 단, 이 브라우저의 자동 저장이 더 최신이면 그쪽을 씁니다.
- 설정에서 “게임이 저장될 때마다 Drive에도 자동 저장”을 켤 수 있습니다. Google 로그인은 1시간마다 만료되므로, 만료 후에는 메뉴의 “세이브를 Drive에 저장”을 한 번 눌러 다시 로그인해야 합니다.

---

## 4. 두 가지 실행 위치

| | 이 기기에서 실행 | 서버에서 실행 |
| --- | --- | --- |
| 에뮬레이션 | 브라우저(WebAssembly) | 서버의 Node.js(같은 WebAssembly 코어) |
| ROM | 기기 밖으로 나가지 않음 | 서버로 전송되고, 다시 보내지 않도록 서버에 보관됨 |
| 필요한 것 | 어느 정도 성능의 기기 | 실행 중인 서버, 안정적인 네트워크 |
| 적합한 경우 | 일반적인 PC·휴대폰 | 성능이 낮은 기기(구형 크롬북 등) |

서버 모드의 화면은 무손실 방식(바뀐 부분만 zlib 압축)으로 전송합니다. 화면 변화가 적은 2D 게임은 수십~수백 KB/s 수준이지만, 화면 전체가 계속 바뀌는 3D 게임은 초당 수 MB까지 늘어날 수 있어 **같은 네트워크(LAN)** 에서 쓰는 것을 권장합니다. 느린 회선에서는 설정에서 30fps 전송을 고르세요. 소리는 약 190KB/s를 사용합니다.

서버는 한 번 받은 게임 파일을 `rom-cache` 폴더에 보관합니다. 같은 게임을 다시 시작하면 파일을 보내지 않고 바로 시작합니다(파일 내용의 SHA-256으로 같은 게임인지 확인). 세이브는 보관하지 않습니다. 한도는 기본 8GB이고 넘으면 오래 안 쓴 것부터 지웁니다. `--rom-cache-mb 2048`로 한도를 바꾸거나 `--no-rom-cache`로 끌 수 있고, `rom-cache` 폴더를 지우면 전부 삭제됩니다.

서버는 세션마다 CPU 코어 하나를 거의 다 사용합니다. `--max-sessions`로 동시 실행 수를 제한하고, 인터넷에 공개할 때는 `--password`를 설정하세요.

---

## 5. 게임이 흰 화면에서 멈출 때

- **암호화된 ROM 덤프**: ROM 덤프에는 복호화된 것과 암호화된 것이 있습니다. 암호화된 덤프는 DS 본체의 BIOS에 들어 있는 키가 있어야 풀 수 있는데, 내장 FreeBIOS에는 그 키가 없습니다. 이런 ROM을 고르면 홈 화면에 경고가 나오고 시작되지 않습니다. 복호화된 덤프를 쓰거나, 설정의 **DS BIOS 파일**에 본인 DS에서 추출한 `bios9.bin`(4KB)과 `bios7.bin`(16KB)을 등록하면 실행됩니다. BIOS 파일은 그 브라우저에만 저장되며, 서버 모드에서는 세션 동안 서버로 전송됩니다.
- **게임이 멈춘 경우**: 게임이 잘못된 명령을 실행하면 “게임이 실행 중 멈췄습니다” 안내가 나옵니다. 로딩이 아니라 멈춘 상태입니다. BIOS 파일을 등록하면 해결되는 경우가 있습니다.
- **기기가 느린 경우**: 60fps가 나오지 않으면 화면 왼쪽 위에 “느림 · NNfps”가 표시됩니다. 게임 자체가 그 비율만큼 느리게 진행되므로 로딩도 길어집니다. 이때는 “서버에서 실행”이 도움이 됩니다.

## 6. 알아둘 점 (제한 사항)

- DS는 DS 모드만 지원합니다(DSi 전용 소프트웨어 불가). GBA는 내장 BIOS(HLE)로 동작합니다. JIT 없이 인터프리터 + 소프트웨어 렌더러로 동작하므로 속도는 기기 성능에 좌우됩니다.
- Wi-Fi·로컬 통신, 마이크, GBA 슬롯, 치트, 세이브 스테이트는 지원하지 않습니다.
- 가장 큰 ROM(256~512MB)은 메모리가 적은 휴대폰 브라우저에서 불러오지 못할 수 있습니다.
- iPhone의 Safari는 전체 화면 API를 지원하지 않습니다. “홈 화면에 추가”로 열면 주소창 없이 쓸 수 있습니다.
- 본인이 소유한 게임에서 직접 추출한 ROM만 사용하세요.

---

## 7. 폴더 구성

```
public/            웹사이트 (정적 호스팅 시 이 폴더만 올리면 됨)
  index.html, css/, js/
  config.js        Google 클라이언트 ID, 서버 주소 설정
  core/            빌드된 melonDS 코어 (melonds.js, melonds.wasm)
server/            Node 서버 (정적 호스팅 + 서버 에뮬레이션)
core/              melonDS(DS) 코어 빌드 소스 (glue.cpp, CMakeLists.txt, build.sh)
core-gba/          mGBA(GBA·GB) 코어 빌드 소스 (glue.c, CMakeLists.txt, build.sh)
start-local.*      내 컴퓨터에서 실행
start-server.*     같은 네트워크의 다른 기기에 호스팅
start-server-anywhere.*  다른 네트워크에서도 접속 (Cloudflare 터널)
```

## 8. 코어 다시 빌드하기

빌드된 파일이 `public/core/`에 들어 있으므로 보통은 필요 없습니다. 직접 빌드하려면 git, cmake, [Emscripten SDK](https://emscripten.org/docs/getting_started/downloads.html)를 준비하고:

```bash
source /path/to/emsdk/emsdk_env.sh
bash core/build.sh        # melonDS 1.1 소스를 받아 public/core/ 에 빌드
bash core-gba/build.sh    # mGBA 0.10.5 소스를 받아 public/core/ 에 빌드
```

## 9. 라이선스

이 프로그램은 melonDS(Copyright 2016-2025 melonDS team)를 기반으로 하며 **GNU GPL v3 (또는 이후 버전)** 으로 배포됩니다. 전문은 `LICENSE`에 있습니다.
배포본에 포함된 `public/core/melonds.wasm`은 수정하지 않은 melonDS 1.1 소스(https://github.com/melonDS-emu/melonDS, 태그 `1.1`)와 `core/glue.cpp`로 빌드한 것입니다. 이 프로그램을 다른 사람에게 배포하거나 사이트로 공개할 때는 GPLv3에 따라 소스 코드(이 폴더 전체)를 함께 제공해야 합니다.

`public/core/mgba.wasm`은 수정하지 않은 mGBA 0.10.5 소스(https://github.com/mgba-emu/mgba, 태그 `0.10.5`, Copyright (c) 2013-2024 Jeffrey Pfau)와 `core-gba/glue.c`로 빌드한 것이며, mGBA는 Mozilla Public License 2.0으로 배포됩니다(전문: `core-gba/MGBA-LICENSE.txt`).

포함된 서드파티: mGBA, melonDS와 그 내장 라이브러리(teakra, FatFs, tiny-AES-c, xxHash, blip-buf 등 — 각 라이선스는 melonDS 소스 참고), [fflate](https://github.com/101arrowz/fflate) (MIT), [ws](https://github.com/websockets/ws) (MIT).

Nintendo와 관련이 없는 비공식 프로그램입니다. Nintendo DS는 Nintendo의 상표입니다.
