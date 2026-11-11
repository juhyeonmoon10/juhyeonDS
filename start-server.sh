#!/usr/bin/env bash
# juhyeonDS - 다른 기기(휴대폰, 크롬북)에서 접속할 수 있도록 호스팅
# 옵션 예:  ./start-server.sh --password 1234 --port 8080 --max-sessions 4
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "서버 모드에는 Node.js(https://nodejs.org)가 필요합니다."
  exit 1
fi
exec node server/server.js --public --port 8080 "$@"
