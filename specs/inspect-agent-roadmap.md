# Inspect-유사 “백그라운드 코딩 에이전트” 개발 로드맵 (Chunk 기반)

이 문서는 “Inspect 유사 시스템”을 **한 번에 구현하지 않고**, 기능을 **작은 Chunk(브랜치)** 로 나눠서
`dev` 브랜치에 단계적으로 머지하기 위한 실행 가능한 계획서입니다.

> 이 레포의 기본 브랜치는 `dev` 입니다. (`AGENTS.md`)

---

## 운영 규칙 (브랜치/머지/기록)

- **브랜치 생성 규칙**
  - 각 Chunk는 독립 브랜치에서 작업합니다.
  - 네이밍: `feat/inspect-XXX-<slug>` (예: `feat/inspect-010-roadmap`)
  - 시작 커맨드:

```bash
git checkout dev
git pull
git checkout -b feat/inspect-010-roadmap
```

- **머지 규칙**
  - 각 Chunk는 “완료 조건(Definition of Done)”을 만족하면 머지합니다.
  - 머지 전 최소 확인:
    - `bun test` 또는 Chunk에 해당하는 최소 테스트/스모크 커맨드 1개
    - 타입체크(해당 패키지 기준) 1개

- **진행상황 기록 규칙**
  - 이 문서의 체크박스는 **머지 후**에만 체크합니다.
  - 각 Chunk는 머지 시점에 “릴리즈 노트(변경점/테스트 방법/리스크)”를 하단에 3~10줄로 남깁니다.

---

## 레포 컨텍스트(중요)

- **opencode 개발/테스트 가이드**: `packages/opencode/AGENTS.md`
  - Install: `bun install`
  - Run(예시): `bun run --conditions=browser ./src/index.ts`
  - Typecheck: `bun run typecheck`
  - Test: `bun test`
- **프로젝트/세션 API 스펙**: `specs/project.md`
  - 목표: 단일 OpenCode 인스턴스가 멀티 프로젝트/워크트리에서 세션을 구동

---

## Chunk 목록 (권장 순서)

아래 순서는 “리스크 낮은 뼈대 → 폐루프(closed-loop) → 인터페이스 확장” 흐름입니다.

### Chunk 010 — 로드맵/브랜치 전략 문서화 (이 문서)
- **브랜치**: `feat/inspect-010-roadmap`
- **목표**: Chunk 기반 개발을 위한 단일 소스 오브 트루스(SSoT) 문서 마련
- **완료 조건(DoD)**
  - [ ] `specs/inspect-agent-roadmap.md` 추가
  - [ ] Chunk/브랜치/테스트/머지 규칙 명시
- **테스트/검증**
  - 문서-only (코드 변경 없음)

### Chunk 020 — “최소 기능 세션 러너” 스모크 (MVP 루프)
- **브랜치**: `feat/inspect-020-session-smoke`
- **목표**: “세션 생성 → 메시지 → 툴 실행 → 결과 저장” 최소 E2E를 1번 성공
- **범위**
  - 기존 `specs/project.md` 흐름을 기준으로, 실제로 동작하는 스모크 경로 1개를 만든다
  - (가능하면) 테스트 1개로 자동화
- **스모크/테스트 커맨드(권장)**

```bash
cd packages/opencode
bun test test/server/session-smoke.test.ts
```

- **검증 포인트**
  - `/session`으로 세션 생성
  - `/session/:sessionID/shell`로 `bash` 툴 실행(LLM 없이) 및 결과 저장
  - `/session/:sessionID/message`로 메시지/파트가 실제로 조회됨
- **완료 조건(DoD)**
  - [ ] 스모크 시나리오 문서화(어떤 커맨드로 무엇을 확인하는지)
  - [ ] 최소 자동 테스트 또는 반복 가능한 스모크 커맨드 제공

### Chunk 030 — 로컬 샌드박스(워크트리/격리 디렉토리) 기반 실행
- **브랜치**: `feat/inspect-030-local-sandbox`
- **목표**: 세션마다 격리된 작업 디렉토리(예: git worktree 또는 copy-on-write 유사)를 사용
- **스모크/테스트 커맨드(권장)**

```bash
cd packages/opencode
bun test test/server/worktree.test.ts
```

- **검증 포인트**
  - `/experimental/worktree`로 worktree 생성 후, 즉시 list에 sandbox로 나타남
  - `/experimental/worktree`(DELETE)로 worktree 제거 후, list에서 사라짐
- **완료 조건(DoD)**
  - [ ] 세션 시작 시 작업 디렉토리 준비/정리 로직
  - [ ] 의존성 설치/캐시 전략(최소 1개) 문서화
  - [ ] 위험한 명령 실행 방지(최소 블랙리스트/승인 훅)

### Chunk 040 — Closed-loop 검증(테스트/타입체크) + 실패 처리
- **브랜치**: `feat/inspect-040-closed-loop`
- **목표**: 변경 후 자동 검증(타입체크/테스트) 실행 + 실패 시 최소 1회 재시도/롤백 전략
- **스모크/테스트 커맨드(권장)**

```bash
cd packages/opencode
bun test test/session/closed-loop.test.ts
```

- **사용 방법(실험 기능)**
  - 기본적으로 `OPENCODE_EXPERIMENTAL_CLOSED_LOOP=true`일 때, 에이전트가 step에서 파일 변경을 만들면
    자동으로 `bun run typecheck` → `bun test`를 실행합니다.
  - 커맨드 오버라이드:
    - `OPENCODE_EXPERIMENTAL_CLOSED_LOOP_COMMANDS`에 줄바꿈(`\n`)으로 커맨드를 나열
- **완료 조건(DoD)**
  - [ ] 검증 단계 정의(예: typecheck → unit tests)
  - [ ] 실패 시 처리(중단/재시도/리버트) 최소 1개 구현
  - [ ] 결과가 세션 로그/스토리지에 남음

### Chunk 050 — 관측/기록(구조화 로그) + 재현 단서
- **브랜치**: `feat/inspect-050-observability`
- **목표**: “무엇을 했는지”를 나중에 재현 가능한 수준으로 저장
- **완료 조건(DoD)**
  - [ ] 툴 호출/명령 실행/결과/실패 사유를 구조화 데이터로 저장
  - [ ] 세션 단위로 조회 가능(최소 1 경로)

### Chunk 060 — 프론트엔드 검증(옵션: 헤드리스) 최소 1 케이스
- **브랜치**: `feat/inspect-060-ui-verify`
- **목표**: headless 브라우저로 스냅샷(스크린샷 또는 DOM 스냅샷) 1개를 수집/비교
- **스모크/테스트 커맨드(권장)**

```bash
cd packages/opencode
bun test test/server/ui-snapshot.test.ts
```

- **검증 포인트**
  - `POST /session/:sessionID/ui/snapshot`로 HTML(DOM) 스냅샷 저장
  - `POST /session/:sessionID/ui/snapshot/compare`로 diff 요약(changed/additions/deletions/diff) 확인
- **완료 조건(DoD)**
  - [ ] 스냅샷 생성 커맨드/툴 1개
  - [ ] 비교 로직(단순 diff여도 OK) 1개

### Chunk 070 — 멀티 세션/하위 에이전트 스폰(parentID)
- **브랜치**: `feat/inspect-070-spawn`
- **목표**: 큰 작업을 하위 세션으로 분해하고, 결과를 부모 세션에 합류하는 규칙 수립
- **완료 조건(DoD)**
  - [ ] `parentID` 기반 자식 세션 생성/종료
  - [ ] 자식 결과 요약/합류(최소 1 전략)

### Chunk 080 — 협업 인터페이스(최소): 세션 제어 UX 정리
- **브랜치**: `feat/inspect-080-interface`
- **목표**: “누가/어떻게” 세션을 제어하는지 최소 인터페이스 하나를 확정(현 레포 구조에 맞춤)
- **완료 조건(DoD)**
  - [ ] 최소 엔드포인트/CLI/TUI 흐름 중 1개를 사용자 시나리오로 문서화
  - [ ] 권한/승인 흐름 초안

### Chunk 090 — PR/CI 연동(후반): 드라이런 → 실제 PR
- **브랜치**: `feat/inspect-090-pr-ci`
- **목표**: 브랜치/커밋/PR 생성(드라이런부터) + CI 결과 수집
- **완료 조건(DoD)**
  - [ ] 드라이런 모드(실제 push 없이 커맨드/계획만 출력)
  - [ ] 실제 PR 생성(옵션) 또는 레포별 토큰/권한 전략 문서화

### Chunk 100 — 안전망(권한 게이트/리소스 제한)
- **브랜치**: `feat/inspect-100-safety`
- **목표**: 운영 가능한 안전장치(승인/차단/레이트리밋/리소스 캡)
- **완료 조건(DoD)**
  - [ ] 위험 명령 차단 + 사용자 승인 플로우(최소 1개)
  - [ ] 리소스 제한(최소 1개: 시간/동시성/디스크 등)

---

## 머지 후 릴리즈 노트 (Chunk별로 누적)

### (예시 형식)
- **Chunk**: 020
- **요약**: 세션 스모크 경로 1개 추가
- **테스트**: `bun test ...` / `bun run ...`
- **리스크/후속**: 다음 Chunk에서 샌드박스 격리 추가 필요

