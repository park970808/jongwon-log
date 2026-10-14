# 배포와 기존 문서 이전

이 브랜치는 공동 편집 **시험판**입니다. 웹 빌드와 Firestore 설정은 별개입니다. GitHub에 소스만 올려도 기존 Firebase 규칙/팀 권한이 자동 변경되지는 않습니다.

## 1. Firebase 프로젝트 확인

기존 앱의 공개 웹 설정을 `src/firebase-config.js`에 그대로 연결했습니다.

| 화면 팀 | Firebase project ID | 새 문서 경로 |
| --- | --- | --- |
| 3팀 | `hyundai-8966e` | `teams/team-3/documents/{문서ID}` |
| 2팀 | `jongwon-log-team-2` | `teams/team-2/documents/{문서ID}` |
| 장원급제 | `jangwon-287b2` | `teams/jangwon/documents/{문서ID}` |

사용할 프로젝트에서 Firebase Authentication의 익명 로그인을 활성화합니다. 웹 설정은 공개 식별자이며 관리자 비밀 키가 아닙니다. 서비스 계정 키는 사이트/저장소에 넣지 않습니다.

## 2. Firestore 규칙 병합

Firebase Console → 해당 프로젝트 → Firestore → Rules에서 현재 규칙을 먼저 보관합니다. `firestore.collaboration.rules`의 함수와 `teams/...` 경로를 기존 `match /databases/{database}/documents` 안에 병합합니다.

**파일 전체로 기존 규칙을 덮어쓰면 기존 일지 접근이 끊길 수 있습니다.** 반대로 기존 규칙이 `match /{document=**}`에서 모든 쓰기를 허용하면 새 권한 제한도 무력화됩니다. 기존 규칙을 실제 기존 컬렉션에 한정하고 새 `teams/{team}/documents` 경로는 제공된 규칙으로 보호해야 합니다. 현재 운영 규칙은 이번 작업에서 읽거나 수정하지 않았습니다.

새 구조:

```text
teams/{team}/collaborationMembers/{authUID}       role: "editor"
teams/{team}/documents/{docID}                  제목·주차·스키마·체크포인트 참조
  updates/{sha256}                              불변 변경 메타데이터
    chunks/{0..31}                             bytes 데이터, 청크당 128 KiB
  presence/{sessionID}                          표시명·커서·접속 시각
  checkpoints/{sha256}/chunks/{n}               서버가 만드는 복원본
```

`firestore.indexes.json`도 기존 인덱스 설정에 병합합니다. 청크 바이트/커서의 불필요한 인덱스를 제외하고 선택적 체크포인트 검색용 `documents.schema` collection-group 인덱스를 추가합니다.

## 3. 팀원 등록

1. 팀원이 사이트에서 팀·이름을 입력하고 **Firestore 문서 열기**를 누릅니다.
2. 권한 안내에 표시된 **사용자 UID**를 관리자에게 전달합니다.
3. 관리자가 Firebase Console의 Firestore 데이터 화면에서 `teams/{team}/collaborationMembers/{UID}` 문서를 만들고 문자열 `role`을 `editor`로 지정합니다.
4. 팀원이 문서 열기를 다시 누릅니다. 문서가 없다면 **새 공동 문서 만들기**로 시작합니다.

UID는 해당 브라우저 프로필에 저장됩니다. 다른 기기/시크릿 창/사이트 데이터 삭제 후에는 새 UID를 등록해야 합니다. URL을 아는 것만으로는 편집 권한이 생기지 않습니다. 첫 버전에는 영구 계정 로그인·초대 관리 화면이 없습니다.

## 4. GitHub Pages

```sh
npm ci
npm run build
```

`dist/` 전체를 정적 호스팅에 올립니다. 직접 배포한다면 `index.html`, `studio.html`, `assets/`, `fonts/`, `legacy/`, `template.hwpx`가 함께 있어야 합니다. `file://` 실행은 지원하지 않습니다.

저장소에 수동 실행용 `.github/workflows/pages.yml`을 포함했습니다.

1. GitHub 저장소 Settings → Pages → Source를 **GitHub Actions**로 설정합니다.
2. 사용하려는 브랜치에 워크플로가 반영된 뒤 Actions → **Deploy collaboration trial** → Run workflow를 실행합니다.
3. 이 작업은 선택한 커밋의 빌드를 현재 Pages 주소에 배포합니다. 기존 운영 화면은 `/legacy/index.html`에서 열립니다. 본 브랜치 작성 중에는 실제 Pages 배포를 실행하지 않았습니다.

공식 설명: [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## 5. 기존 문서 이전

기존 화면에서 해당 주차를 열고 **한글 파일 내보내기**를 실행합니다. 새 화면에서 비어 있는 문서 ID를 선택하고, **가져올 HWPX**에 이 파일을 지정하여 새 공동 문서를 만듭니다. 새 파일의 글·표·사진·페이지를 확인한 후 팀원에게 새 링크를 공유합니다.

기존 Firestore 데이터와 새 공동 문서는 별도입니다. 이전 이후의 옛 화면 수정이 새 문서로 자동 반영되지는 않습니다. 기존 문서 전체 일괄 이전은 아직 구현하지 않았습니다.

## 6. 체크포인트 함수 — 선택 배포

초기 시험은 함수 없이도 동작합니다. 변경 기록이 누적되면 `functions/`의 일일 체크포인트를 사용할 수 있습니다. 함수 배포는 해당 Firebase 프로젝트의 결제·권한 설정이 필요합니다.

```sh
npm --prefix functions ci
```

기존 Firebase 설정에 functions 소스 `functions`와 코드베이스 `jongwon-collaboration`을 추가한 다음 선택한 프로젝트에 **이 코드베이스만** 배포합니다. 기존 프로젝트의 함수 설정을 교체하지 않습니다. 예시 조각:

```json
{
  "functions": [{"source":"functions","codebase":"jongwon-collaboration","runtime":"nodejs22"}]
}
```

```sh
npx firebase deploy --only functions:jongwon-collaboration --project YOUR_PROJECT_ID --config YOUR_MERGED_CONFIG.json
```

한 문서에 업데이트가 100개 이상이면 체크포인트를 만듭니다. 서버 읽기 시각을 경계로 잡아 늦게 전송된 오프라인 수정도 새 클라이언트가 읽습니다. 기존 업데이트 로그는 삭제하지 않습니다. 아주 큰 로그의 페이지별 처리·정리 정책과 Storage 체크포인트는 후속 작업입니다. 현재 함수는 로그가 커지면 시간 제한에 걸릴 수 있으며 실패해도 기존 복원 경로를 유지합니다.

## 용량과 운영

Firestore 한 문서의 최대 크기는 1 MiB이므로 변경 바이트를 128 KiB 청크로 나눕니다. 앱은 압축 묶음 4 MiB 상한을 적용합니다. 이는 HWPX 파일 크기와 정확히 같지 않습니다. 큰 사진을 줄여야 할 수 있습니다. [Firestore 제한](https://firebase.google.com/docs/firestore/quotas).

문자 변경은 짧게 모아 전송하고, 커서는 움직일 때 최대 초당 한 번/정지 상태 약 15초에 한 번 보냅니다. 실제 읽기·쓰기량은 동시 사용자·문서 크기에 따라 달라집니다. 운영 전 Firebase Usage에서 사용량을 확인합니다.

오류 상태에서는 **복구 데이터 받기**로 Yjs 복구본과 현재 화면 HWPX를 보관합니다. HWPX는 새 문서로 다시 가져올 수 있습니다. Yjs 복구본은 개발자가 내용 비교·복원에 사용할 수 있으나 자동 복구 UI는 아직 없습니다.
