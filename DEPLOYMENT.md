# 배포와 기존 문서 이전

3팀 공동 편집은 `hyundai-8966e`의 실제 Firestore에 연결합니다. 2026-10-14 운영 규칙과 팀 초대를 적용했습니다. 웹 빌드와 Firestore 설정은 별개입니다. 초대 코드는 저장소에 포함하지 않습니다.

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

**파일 전체로 기존 규칙을 덮어쓰면 기존 일지 접근이 끊길 수 있습니다.** 반대로 기존 규칙이 `match /{document=**}`에서 모든 쓰기를 허용하면 새 권한 제한도 무력화됩니다. 기존 규칙을 실제 기존 컬렉션에 한정하고 새 `teams/{team}/documents` 경로는 제공된 규칙으로 보호해야 합니다. `firestore.production.rules`는 기존 3팀 일지 경로 접근을 유지하면서 `documents`, `collaborationMembers`, `collaborationInvites`만 별도 보호하도록 병합한 운영 규칙입니다. 이 파일을 `firebase.production.json`으로 3팀 프로젝트에 배포했습니다.

2팀(`jongwon-log-team-2`)은 `firestore.team2.rules`를 씁니다. 기존 2팀 일지 경로(`teams/team-2/...`, 로그인한 사용자 허용)는 그대로 두고 `documents`, `collaborationMembers`, `collaborationInvites`만 위와 같은 규칙으로 보호합니다. 콘솔 → Firestore → 규칙에 붙여 넣어 게시하고, Authentication에서 익명 로그인을 켭니다. 초대는 `teams/team-2/collaborationInvites/{초대 코드의 SHA-256}` 문서에 `enabled: true`(boolean)를 넣어 만듭니다. 장원급제 프로젝트는 관리자 연결이 없어 새 화면에서 선택을 막았습니다.

새 구조:

```text
teams/{team}/collaborationMembers/{authUID}       role: "editor"
teams/{team}/documents/{docID}                  제목·주차·스키마·체크포인트 참조
  updates/{sha256}                              불변 변경 기록 (256 KiB 이하는 data 필드에 바로 저장)
    chunks/{0..31}                             큰 변경만: bytes 데이터, 청크당 128 KiB
  presence/{sessionID}                          표시명·커서·접속 시각
  checkpoints/{sha256}/chunks/{n}               압축본 (팀원 브라우저 또는 선택적 서버 함수가 만듦)
```

`firestore.indexes.json`도 기존 인덱스 설정에 병합합니다. 청크 바이트/커서의 불필요한 인덱스를 제외하고 선택적 체크포인트 검색용 `documents.schema` collection-group 인덱스를 추가합니다.

## 3. 초대 링크로 팀원 등록

1. 관리자가 전달한 **초대 링크**를 엽니다.
2. 이름·주차·문서 ID를 입력하고 **Firestore 문서 열기**를 누릅니다.
3. 처음 접속한 브라우저는 초대 코드의 SHA-256 해시로 가입합니다. Firestore 규칙이 활성 초대를 확인한 뒤 본인 UID의 editor 권한만 생성합니다.
4. 문서가 없다면 **새 공동 문서 만들기**를 누릅니다. 빈 양식 또는 가져온 HWPX로 시작합니다.
5. 초대 링크로 연 문서의 **링크 복사**에는 초대 코드가 포함됩니다. 팀원에게만 전달합니다. 새 기기/시크릿 창/사이트 데이터 삭제 후에는 원래 초대 링크를 다시 엽니다.

초대 코드 원문은 URL fragment에만 들어가며 서버에는 해시만 저장합니다. 초대 문서는 클라이언트가 읽을 수 없습니다. 초대 링크를 가진 사람은 가입할 수 있으므로 공개 저장소에 올리지 않습니다. 관리자만 `teams/team-3/collaborationInvites/{SHA256}`의 `enabled`를 변경합니다. 초대를 비활성화해도 이미 가입한 멤버 권한은 남으며, 멤버 문서를 별도로 제거해야 합니다. 영구 계정 로그인·초대 관리 화면은 아직 없습니다.

## 4. GitHub Pages

```sh
npm ci
npm run build
```

`dist/` 전체를 정적 호스팅에 올립니다. 직접 배포한다면 `index.html`, `studio.html`, `assets/`, `fonts/`, `legacy/`, `template.hwpx`가 함께 있어야 합니다. `file://` 실행은 지원하지 않습니다.

저장소에 수동 실행용 `.github/workflows/pages.yml`을 포함했습니다.

1. GitHub 저장소 Settings → Pages → Source를 **GitHub Actions**로 설정합니다.
2. 사용하려는 브랜치에 워크플로가 반영된 뒤 Actions → **Deploy collaboration trial** → Run workflow를 실행합니다.
3. 이 작업은 선택한 커밋의 빌드를 현재 Pages 주소에 배포합니다. 기존 운영 화면은 `/legacy/index.html`에서 열립니다. 배포 결과는 Actions 실행 기록에서 확인합니다.

공식 설명: [GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## 5. 기존 문서 이전

기존 화면에서 해당 주차를 열고 **한글 파일 내보내기**를 실행합니다. 새 화면에서 비어 있는 문서 ID를 선택하고, **가져올 HWPX**에 이 파일을 지정하여 새 공동 문서를 만듭니다. 새 파일의 글·표·사진·페이지를 확인한 후 팀원에게 새 링크를 공유합니다.

기존 Firestore 데이터와 새 공동 문서는 별도입니다. 이전 이후의 옛 화면 수정이 새 문서로 자동 반영되지는 않습니다. 기존 문서 전체 일괄 이전은 아직 구현하지 않았습니다.

## 6. Spark(무료) 요금제 대응 — 규칙·인덱스 배포

이번 변경은 작은 변경을 기록 1장에 담고(`chunks: 0` + `data`), 브라우저가 체크포인트를 만들 수 있도록 규칙을 확장했습니다. **배포 순서와 무관하게 동작합니다.** 새 규칙이 아직 없으면 브라우저가 이를 감지해 예전 청크 형식으로 저장하고, 체크포인트만 만들지 않습니다.

```sh
# 3팀 운영 프로젝트: 기존 일지 경로를 보존한 운영 규칙
npx firebase deploy --only firestore:rules --project hyundai-8966e --config firebase.production.json
# 권장: 인라인 바이트 필드를 색인에서 제외(저장 용량 절약). 없어도 쓰기는 실패하지 않습니다.
npx firebase deploy --only firestore:indexes --project hyundai-8966e --config firebase.emulator.json
```

규칙 변경 요약:

- `updates/{id}`: `chunks == 0`이면 `data`(1 B~256 KiB 바이트) 필수, `chunks 1~32`이면 `data` 금지. 그 외 검증은 동일.
- `checkpoints/{sha256}` 및 `chunks/{n}`: 편집 권한자가 본인 명의로만 생성, 이후 수정·삭제 불가. `coveredUntil`은 현재 시각 이전.
- 문서 루트: `checkpointId`/`checkpointCutoff`만 변경 가능. 시점은 앞으로만 이동하며, 해당 체크포인트의 `coveredUntil`과 같아야 합니다. 원본 기록은 누구도 삭제할 수 없습니다.

체크포인트는 전체 기록(또는 기존 체크포인트+이후 기록)을 서버에서 직접 받은 브라우저만, 온라인일 때, 5분 이전까지의 서버 확인 내용으로 만듭니다. 이 기기에서 아직 보내지 않은 입력은 포함하지 않습니다. 편집 권한자는 이미 문서 내용을 바꿀 수 있으므로 신뢰 범위는 이전과 같습니다. 읽는 쪽은 체크포인트가 없거나, 포인터와 `coveredUntil`이 다르거나, 해시가 맞지 않으면 전체 기록을 읽습니다.

### 배포 후 전환

- 배포 직후 열려 있던 탭은 **모두 새로고침**하도록 안내합니다. 이전 버전 탭이 접속자 목록에 보이는 동안은 새 버전도 예전(청크) 형식으로 저장하므로 서로 읽을 수 있습니다.
- 다만 접속 신호를 오래 보내지 않은 이전 버전 탭(휴대폰 백그라운드 등)이나 GitHub Pages 캐시로 몇 분간 이전 `index.html`을 받은 탭은 새 형식 기록을 읽지 못해 오류를 표시할 수 있습니다. 내용은 서버에 있으며 새로고침하면 해결됩니다.

### 체크포인트 복구

- 잘못된 체크포인트가 의심되면 편집 권한이 있는 팀원이 문서 주소에 `&fullload=1`을 붙여 엽니다. 체크포인트와 이 기기의 동기화 위치를 쓰지 않고 전체 기록을 읽은 뒤, 새 체크포인트로 교체하면 "전체 기록으로 압축본을 새로 만들었습니다" 안내가 뜹니다. 그 뒤로는 평소 주소를 씁니다. 교체할 새 기록이 아직 없으면 다음 입력 뒤에 다시 시도합니다.
- 관리자는 콘솔에서 문서의 `checkpointId`/`checkpointCutoff` 필드를 지워도 됩니다. 새 기기가 전체 기록을 다시 읽습니다. 원본 기록은 삭제되지 않으므로 어느 경우에도 내용은 잃지 않습니다.

## 7. 체크포인트 함수 — 선택 배포 (Blaze 요금제)

초기 시험은 함수 없이도 동작합니다. Spark에서는 6장의 브라우저 체크포인트를 사용합니다. 변경 기록이 누적되면 `functions/`의 일일 체크포인트를 사용할 수 있습니다. 함수 배포는 해당 Firebase 프로젝트의 결제·권한 설정이 필요합니다.

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

Firestore 한 문서의 최대 크기는 1 MiB이므로 256 KiB를 넘는 변경은 128 KiB 청크로 나눕니다. 앱은 압축 묶음 4 MiB 상한을 적용합니다. 이는 HWPX 파일 크기와 정확히 같지 않습니다. 큰 사진을 줄여야 할 수 있습니다. [Firestore 제한](https://firebase.google.com/docs/firestore/quotas).

문자 변경과 커서 전송 간격은 README의 "Firestore 무료(Spark) 한도"에 정리했습니다. 실제 읽기·쓰기량은 동시 사용자·문서 크기에 따라 달라집니다. 운영 중 Firebase Console의 사용량을 확인합니다.

오류 상태에서는 **복구 데이터 받기**로 Yjs 복구본과 현재 화면 HWPX를 보관합니다. HWPX는 새 문서로 다시 가져올 수 있습니다. Yjs 복구본은 개발자가 내용 비교·복원에 사용할 수 있으나 자동 복구 UI는 아직 없습니다.
