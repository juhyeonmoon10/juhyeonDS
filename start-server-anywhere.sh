#!/usr/bin/env bash
# juhyeonDS - 다른 네트워크(모바일 데이터, 다른 와이파이)에서도 접속할 수 있게 호스팅
# Cloudflare 무료 터널을 사용합니다. 처음 실행할 때 cloudflared(약 55MB)를 tools 폴더에 내려받습니다.
# 옵션 예:  ./start-server-anywhere.sh --password 1234 --max-sessions 2
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "서버 모드에는 Node.js(https://nodejs.org)가 필요합니다."
  exit 1
fi
exec node server/server.js --public --tunnel --port 8080 "$@"
