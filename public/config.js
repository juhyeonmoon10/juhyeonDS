// juhyeonDS 설정 파일입니다. 값을 바꾼 뒤 페이지를 새로고침하세요.
window.MELONDS_CONFIG = {
  // Google Drive 연동에 쓰는 OAuth 클라이언트 ID.
  // 비워 두면 "Google Drive 연결"을 누를 때 입력 창이 나타나고, 입력값은 그 브라우저에만 저장됩니다.
  // 이 ID는 공개되어도 되는 값입니다(비밀번호가 아님). 등록된 주소에서만 동작합니다:
  //   https://juhyeonmoon10.github.io , http://localhost:8080
  googleClientId: "239426119277-m6mhqsm23b1jqpmpuefisdr0osu0jehm.apps.googleusercontent.com",

  // Drive에 만들어지는 폴더 이름.
  driveFolderName: "juhyeonDS",

  // 서버 에뮬레이션 모드에서 접속할 서버 주소.
  // 비워 두면 이 페이지를 제공한 서버(같은 주소)를 사용합니다.
  // 정적 호스팅(GitHub Pages 등)에 페이지만 올리고 에뮬레이션 서버를 따로 둘 때 지정하세요.
  // 예: "https://ds.example.com"
  serverUrl: "",

  // 켜져 있는 서버 목록에 쓰는 게시판 이름(ntfy.sh 토픽).
  // start-server-anywhere로 켠 서버가 자기 주소를 여기에 올리고, 이 페이지는 그것을 읽어
  // "켜져 있는 서버" 목록을 보여 줍니다. 비워 두면 목록 기능이 꺼집니다.
  serverDirectory: "juhyeonds-b030b4f88320",
};
