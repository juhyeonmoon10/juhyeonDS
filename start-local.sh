#!/usr/bin/env bash
# melonDS Web - 이 컴퓨터에서만 실행 (http://localhost:8080)
cd "$(dirname "$0")" || exit 1
if command -v node >/dev/null 2>&1; then
  exec node server/server.js --port 8080 --open "$@"
elif command -v python3 >/dev/null 2>&1; then
  echo "Node.js가 없어 Python으로 실행합니다 (브라우저 모드만 가능, 서버 에뮬레이션 없음)."
  echo "http://localhost:8080 으로 접속하세요."
  exec python3 -m http.server 8080 --bind 127.0.0.1 --directory public
else
  echo "Node.js(https://nodejs.org)를 설치한 뒤 다시 실행하세요."
  exit 1
fi
