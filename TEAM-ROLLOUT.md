# 팀별 Firebase 프로젝트

하나의 GitHub Pages 코드가 접속 주소에 따라 **서로 다른 Firebase 프로젝트**를 선택합니다.

| 접속 주소 | Firebase 프로젝트 | Firestore 경로 |
| --- | --- | --- |
| `https://park970808.github.io/jongwon-log/` | `jangwon-287b2` | `teams/jangwon/…` |
| `https://park970808.github.io/jongwon-log/?team=team-2` | `jongwon-log-team-2` | `teams/team-2/…` |

기존 프로젝트의 자료와 보안 규칙은 그대로 둡니다. 새 프로젝트의 웹 앱은 등록되어 있습니다. Firebase 콘솔에서 **`jongwon-log-team-2`를 선택했는지 확인한 뒤** 다음을 완료하세요.

1. Cloud Firestore의 `(default)` 데이터베이스가 `nam5`에 생성되었는지 확인합니다. 생성 중이라면 완료될 때까지 기다립니다.
2. Authentication → 로그인 방법에서 **익명** 제공업체를 사용 설정합니다. 팀원에게 별도 로그인 화면은 보이지 않습니다.
3. Firestore → 규칙에서 `team-2.firestore.rules`의 내용을 새 프로젝트에만 게시합니다. `jangwon-287b2`의 규칙은 건드리지 않습니다.
4. 두 링크로 읽기·쓰기를 테스트한 다음 GitHub Pages의 기본 브랜치를 배포합니다.

프로젝트 분리는 실수로 자료가 섞이는 일을 막아줍니다. **링크를 비공개로 전달하는 것은 접근 권한 관리가 아닙니다.** 웹 앱의 Firebase 설정은 브라우저에 공개되므로 현재의 익명 인증 규칙 아래에서는 링크나 설정을 알아낸 제3자도 접근할 수 있습니다. 민감한 내용을 저장한다면 실제 사용자 인증과 팀별 권한 규칙으로 전환해야 합니다.

배포 전에는 두 주소에서 각각 자리 선택, 같은 주차의 읽기/쓰기, 사진, 지난 주 가져오기, HWPX 내보내기를 확인하세요. 팀 이름은 새 프로젝트에서 `2팀`으로 표시됩니다. 실제 이름이 정해지면 `team-routing.mjs`의 표시 이름을 바꾸면 됩니다.
