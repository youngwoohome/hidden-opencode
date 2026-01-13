# PDF 기반 요구사항 → 코드 레벨 체크리스트(Inspect Production)

이 문서는 두 PDF에서 언급된 “프로덕션급 Inspect” 요구사항을 **OpenCode(이 레포)** 관점의 **코드 레벨 체크리스트**로 번역한 것입니다.

- 소스(추출 텍스트):
  - `specs/pdf/사내 AI 코딩 에이전트 구축 가이드 (Ramp “Inspect” 서비스 구현).txt`
  - `specs/pdf/백그라운드 코딩 에이전트(Inspect 유사 시스템) 구현 계획.txt`

---

## 1) 샌드박스/실행환경(격리 + 빠른 부팅)

- [ ] **Sandbox provider 추상화 도입**: Local(worktree) vs Remote(Modal/Firecracker/기타) 분리
  - **목표**: “세션=격리된 VM/컨테이너 1개” 모델을 코드 구조로 표현
  - **예상 touchpoint**: `packages/opencode/src/worktree/*`, `packages/opencode/src/project/*`, `packages/opencode/src/session/*`
- [ ] **이미지/캐시 전략**(주기적 빌드 + warm start/pool)
  - **목표**: 세션 시작 지연 최소화(“모델 응답 시간 + 알파”)
  - **infra 작업**(레포 밖): 이미지 레지스트리/주기적 빌드/풀 운영
- [ ] **스냅샷/복원**(세션 중단 후 재개)
  - **목표**: 후속 프롬프트 시 환경을 재구축하지 않고 이어서 작업
  - **infra 작업**(레포 밖): FS snapshot 지원 플랫폼 필요
- [x] **동기화 중 write 차단(읽기는 허용)**  *(PDF에서 명시적으로 권장)*
  - **구현**: `packages/opencode/src/plugin/sync-gating.ts`
  - **설정**: `OPENCODE_SYNC_GATING=true`, 락 파일 `.opencode/sync.pending`
  - **로그**: `sync_wait` 이벤트(`packages/opencode/src/session/event-log.ts`)
  - **원격 샌드박스 부팅 시나리오(가이드)**: `.opencode/sync.pending`를 sync 시작 전에 만들고, sync 완료 후 삭제

---

## 2) 세션/오케스트레이션(멀티플레이어 + 큐잉 + 스트리밍)

- [ ] **세션 상태 모델**: “코드 수정 중/테스트 중/PR 생성 중/완료” 같은 상태 머신(외부 노출용)
  - **목표**: Slack/Web UI에서 “지금 뭐 하는지”를 안정적으로 표시
- [ ] **프롬프트 큐(Queue) 기본 동작**: 작업 중 추가 메시지 → 큐잉 후 순차 처리
  - **목표**: 동시 입력/중단/재개 시 일관성
- [ ] **멀티플레이어 attribution**: “누가 요청했는지”를 이벤트/결과물(PR 본문 등)에 남김
  - **목표**: 감사/책임/협업(비개발자 참여) 지원
- [ ] **세션 spawn/join 운영 모델**: 병렬 세션 수 제한, 상태 조회, 결과 합류(fan-in) 전략
  - **현재**: spawn/join 자체 기능은 존재(테스트도 있음)
  - **부분 구현(로컬 격리 강화)**: child spawn 시 전용 git worktree를 생성하여 디렉토리를 분리 가능
    - 플래그: `OPENCODE_EXPERIMENTAL_SPAWN_WORKTREE=true`
    - API 입력: `useWorktree` (옵션)
  - **남은 것**: “언제 spawn할지” 정책 + 제한/쿼터 + UX

---

## 3) 권한/보안(최소권한 + 감사 + 네트워크 egress)

- [x] **permission asked/replied 감사 로그**(세션 이벤트로 저장)
  - **구현**: `packages/opencode/src/session/event-log.ts`
- [x] **네트워크 egress 게이트(호스트 단위 permission)** *(PDF의 allowlist 방향성에 부합)*
  - **구현(웹 요청)**: `packages/opencode/src/tool/webfetch.ts`에서 `network` permission 추가
  - **구현(터미널)**: `packages/opencode/src/tool/bash.ts`에서(옵션) `curl/wget/ssh/scp/rsync/nc/telnet` host 추출 후 `network` permission 추가
    - 플래그: `OPENCODE_EXPERIMENTAL_NETWORK_GATING=true`
    - host 추출: `packages/opencode/src/tool/network-safety.ts`
- [ ] **쿼터/동시성 제한**(PDF에서도 안전장치로 권장)
  - **예시**: “세션당 spawn 제한”, “사용자당 동시 세션 제한”, “툴 실행 rate limit”
  - **부분 구현(스폰 폭주 방지)**: parent session 당 child spawn 개수 상한
    - env: `OPENCODE_EXPERIMENTAL_SPAWN_MAX_CHILDREN=<N>`
  - **부분 구현(동시 세션 제한)**: “현재 실행 중인 prompt loop” 기준 동시 실행 상한
    - project 단위: `OPENCODE_SESSION_CONCURRENCY_MAX=<N>`
    - user 단위: `OPENCODE_USER_SESSION_CONCURRENCY_MAX=<N>`
      - user 식별: 세션 생성 시 헤더 `x-opencode-user` (또는 `x-opencode-username`)로 `Session.createdBy`에 저장
- [ ] **2인 승인(Optional)**: PR/배포 등 위험 액션에 대해 추가 승인 플로우
  - **상태**: 아직 미구현(권한 시스템/클라이언트 UX와 함께 설계 필요)

---

## 4) PR/CI 연동(루프를 닫기)

- [x] **PR 생성 실행 모드(안전장치 포함)**: git add/commit/push + gh pr create / 기존 PR 재사용
  - **구현**: `packages/opencode/src/cli/cmd/pr-create.ts`
- [x] **CI 상태 관측(--watch)**: GitHub statusCheckRollup 폴링 + 실패 체크 요약 출력
  - **구현**: `packages/opencode/src/cli/cmd/pr-create.ts`
- [ ] **CI 실패 → 자동 수정 루프 정책**(옵션)
  - **목표**: “CI 실패 로그/체크 링크를 근거로 수정→재시도”를 세션 정책으로 내장
- [ ] **웹훅 기반 상태 반영**(외부 시스템)
  - **목표**: PR merge/close, 새로운 커밋/체크 결과를 세션에 반영

---

## 5) 검증(Closed-loop) + 프론트엔드 브라우저 기반 검증

- [ ] **헤드리스 브라우저(Playwright/Puppeteer) 기반 검증**
  - **목표**: UI 스크린샷/DOM 비교 결과를 PR/Slack에 첨부
  - **현재**: 최소 수준의 HTML(DOM) 스냅샷은 존재하나(서버 API+테스트), 브라우저 기반까지는 미도입
- [ ] **모니터링 툴 연동**(Sentry/Datadog/LaunchDarkly 등)
  - **목표**: “테스트만”이 아니라 운영 지표까지 포함한 검증

---

## 6) 인터페이스(Slack/Web/Extension)

- [ ] **Slack Bot**: 세션 시작/상태/승인 요청/PR 링크까지 Block Kit으로
- [ ] **Web UI**: 세션 리스트/로그/아티팩트/승인 플로우 + 임베디드 에디터(code-server 등)
- [ ] **Chrome Extension**: DOM 선택 → 파일 매핑 → 수정 요청 → 결과 확인

---

## 부록: Modal 샌드박스 PoC(현재 레포에 추가된 CLI/추상화)

- **추상화/Provider**
  - `packages/opencode/src/sandbox/types.ts`
  - `packages/opencode/src/sandbox/modal.ts` (+ `packages/opencode/src/sandbox/modal-helper/opencode_modal_sandbox.py`)
  - `packages/opencode/src/sandbox/fake.ts`

- **CLI**
  - `opencode sandbox create` / `stop` / `snapshot` / `restore`
  - 원격 서버 접속은 `opencode run --attach <url>` 사용

- **필수/권장 환경변수(Modal)**
  - `OPENCODE_MODAL_IMAGE`: Modal에서 사용할 이미지(내부에 `opencode`, `git`, `bun` 등이 포함되어야 함)
  - `OPENCODE_SANDBOX_PROVIDER=modal`
  - (선택) `OPENCODE_SANDBOX_TTL_SECONDS`, `OPENCODE_SANDBOX_IDLE_SECONDS`, `OPENCODE_SANDBOX_CPU`, `OPENCODE_SANDBOX_MEMORY_MB`, `OPENCODE_SANDBOX_DISK_GB`
  - (선택) `OPENCODE_SANDBOX_URL`: provider가 URL을 직접 계산/노출하지 못하는 경우 임시로 주입 가능(개발용)


