# 공동 편집 검증

## 빠른 검사

```sh
npm ci
npm test
npm run build
```

단위 테스트는 실제 활동일지 HWPX의 구조/텍스트 왕복, 같은 셀의 동시 입력과 역순·중복 전송, 개인 실행 취소, 잘못된 파일·업데이트 거부, 전송 outbox와 재시도를 검사합니다.

## 실제 편집기 브라우저 검사

별도 터미널에서 `npm run dev -- --port 5173`을 실행한 뒤:

```sh
npx playwright install chromium
npm run test:e2e
```

macOS에서는 설치된 Google Chrome을 자동 사용합니다. 다른 실행 파일은 `CHROME_PATH`로 지정할 수 있습니다. 테스트는 새 브라우저 프로필과 새 체험 문서를 사용합니다. 실제 알한글 WASM 편집기 두 개에 글을 입력합니다. 화면 캡처는 `.test-output/`에 생성합니다.

## 실제 Firestore 프로토콜 및 규칙 검사

JDK 21 이상과 Node.js가 필요합니다. 운영 프로젝트가 아닌 `demo-jongwon` 에뮬레이터만 사용합니다.

```sh
npm --prefix functions ci
npx firebase emulators:start --only firestore,auth --project demo-jongwon --config firebase.emulator.json
```

다른 터미널에서 순서대로:

```sh
node tests/firestore-rules.emulator.js
node tests/checkpoint.emulator.js
node tests/production-rules.emulator.js
node scripts/firestore-browser-test.mjs
LARGE_TEST=1 node scripts/firestore-browser-test.mjs
```

브라우저 테스트에는 위의 개발 서버도 필요합니다. `?emulator=1` 연결은 개발 빌드에서만 활성화됩니다. 규칙 테스트는 에뮬레이터 데이터를 비우므로 다른 테스트와 동시에 실행하지 않습니다. 권한 거부 검사의 `PERMISSION_DENIED` 로그는 기대한 결과입니다.

검증 범위:

- 별도 브라우저 프로필의 두 사용자가 동일한 표 셀에 동시에 한글 입력.
- 오프라인 입력 후 재접속으로 다른 사용자에게 전달.
- 내 실행 취소가 다른 사용자의 글을 보존.
- 새로고침 후 서버의 변경 이력 복원.
- 글자 굵게 변경과 표 행 추가 전파.
- 합성 composition 이벤트로 한글 조합 중 원격 변경을 대기하고 병합.
- 원격 재렌더링을 인위적으로 지연시킨 동안 발생한 일반 입력·한글 조합 입력의 보관/반영.
- 익명 사용자 팀 권한, 불변 로그/청크, 접속자 소유권.
- 체크포인트 + 이후 전송된 수정만 읽어 전체 상태 복원, 원본 이력 유지.

합성 IME 검사는 실제 OS의 한글 입력기를 사람이 사용하는 검사와 다릅니다. 운영 전 macOS/Windows 한글 입력기, 모바일, 실제 장문, 사진·머리말·각주, 서로 겹치는 복잡한 표 병합/분할 충돌을 별도로 확인해야 합니다. 자세한 현재 제한은 README에 정리했습니다.

프로덕션 빌드의 하위 경로·WASM·폰트·HWPX 내려받기·모바일 시작 화면 검사는 `npm run build` 후 `node scripts/production-smoke.mjs`로 실행합니다. 임시 로컬 HTTP 서버는 검사 후 자동 종료됩니다.

## 2026-10-14 추가 검증

- `scripts/structural-browser-test.mjs`: 실제 WASM에서 행 추가/삭제와 동시 입력, 동일 위치 동시 행 추가, 빈 셀 병합과 동시 입력, 문단 나누기, 서로 다른 사진 삽입.
- 3팀 실제 Firestore: 독립 브라우저 두 사용자의 같은 셀 입력, 오프라인 재접속, 개인 실행 취소, 새로고침 복원. 검증 전용 문서만 사용합니다.
- 운영 규칙 에뮬레이터: 기존 일지 경로 유지, 초대 없는 가입 차단, 초대 원문/목록 접근 차단, 유효한 초대로 본인만 가입.
- 행 추가 시 셀 중복, 병합 시 빈 셀의 동료 입력 유실, 같은 병합의 문단 중복, 복구 시 전체 문서를 재전송하는 오류에 회귀 테스트를 추가했습니다.

실제 서버 검사에는 `LIVE_TEST_INVITE_FILE`로 로컬 JSON (`{"invite":"..."}`)을 지정합니다. 공개 배포 주소 검사는 `TEST_BASE_URL`로 지정합니다. 이 파일과 `.test-output/`는 Git에 올리지 않습니다. 브라우저 자동 키 입력에서는 OS composition 이벤트가 발생하지 않아 실제 한글 입력기 통과로 계산하지 않았습니다.

대용량 에뮬레이터 검사도 통과했습니다: 약 3 MB JPEG 두 장(총 4 MiB 초과 문서)을 저장하고 새로고침한 뒤 5,000자 입력을 다른 브라우저로 동기화했습니다. 큰 문서를 다시 열 때 저장된 전체 상태 대신 서버에 없는 변경만 보내도록 수정했습니다.

## 그림 버튼의 커서 위치 삽입

`node scripts/image-insertion-test.mjs`는 실제 그림 버튼과 파일 선택으로 검사합니다. 표 셀의 글자 사이에 커서를 놓고, 파일 선택 중 동료가 같은 문단을 편집한 뒤에도 원래 상대 위치에 사진이 삽입되는지 HWPX 구조로 확인합니다. 셀 너비에 맞춘 크기, 셀 높이 확장, 동료 화면 반영, 새로고침, 내려받기, 본문 삽입과 실행 취소도 검사합니다. 개발 서버 기본 주소는 5173이며 `TEST_BASE_URL`로 배포 주소를 지정할 수 있습니다. 검증은 별도 체험 문서를 사용합니다.
