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
node scripts/firestore-browser-test.mjs
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

합성 IME 검사는 실제 OS의 한글 입력기를 사람이 사용하는 검사와 다릅니다. 운영 전 macOS/Windows 한글 입력기, 모바일, 실제 장문, 사진·머리말·각주, 표 병합/삭제와 동시 입력을 별도로 확인해야 합니다. 자세한 현재 제한은 README에 정리했습니다.

프로덕션 빌드의 하위 경로·WASM·폰트·HWPX 내려받기·모바일 시작 화면 검사는 `npm run build` 후 `node scripts/production-smoke.mjs`로 실행합니다. 임시 로컬 HTTP 서버는 검사 후 자동 종료됩니다.
