# Inspect 에이전트 핸드오프 (새 세션용)

이 문서는 **새 대화/새 에이전트 세션에서 Chunk 050을 이어서 개발**하기 위한 최소 컨텍스트입니다.

---

## 현재 상태 (git)

- **기본 브랜치**: `dev`
- **현재 작업 브랜치(Chunk 050)**: `feat/inspect-050-observability`
- **Chunk 040까지는 dev에 FF-merge 완료**

새 세션에서 시작 커맨드:

```bash
cd /Users/youngwoojung/hidden-opencode
git checkout dev
git pull --ff-only
git checkout feat/inspect-050-observability
```

---

## 지금까지 완료된 Chunk 요약

- **Chunk 010**: `specs/inspect-agent-roadmap.md` 추가(브랜치/머지/DoD 추적)
- **Chunk 020**: 세션 스모크 테스트 추가
  - 파일: `packages/opencode/test/server/session-smoke.test.ts`
- **Chunk 030**: 로컬 샌드박스(worktree) 생성/삭제 + 테스트
  - API:
    - `POST /experimental/worktree`
    - `GET /experimental/worktree`
    - `DELETE /experimental/worktree` (추가됨)
  - 파일:
    - `packages/opencode/src/worktree/index.ts`
    - `packages/opencode/src/server/server.ts`
    - `packages/opencode/test/server/worktree.test.ts`
- **Chunk 040**: closed-loop(검증 실행 + 실패 시 revert) (실험 기능)
  - 플래그:
    - `OPENCODE_EXPERIMENTAL_CLOSED_LOOP=true`
    - `OPENCODE_EXPERIMENTAL_CLOSED_LOOP_COMMANDS` (줄바꿈으로 커맨드 리스트)
  - 기본 검증 커맨드: `bun run typecheck` → `bun test`
  - 파일:
    - `packages/opencode/src/session/closed-loop.ts`
    - `packages/opencode/src/session/processor.ts`
    - `packages/opencode/test/session/closed-loop.test.ts`
    - `packages/opencode/src/flag/flag.ts`

---

## Chunk 050 목표(관측/기록)

**목표**: “무엇을 했는지”를 나중에 재현 가능한 수준으로 저장/조회 가능하게 만들기.

### 최소 구현 제안(추천)
- **구조화 이벤트 로그 모델 정의**
  - 세션 단위로 `tool 호출`, `shell 실행`, `closed-loop 결과`, `worktree create/remove`, `permission 요청/응답` 등을
    하나의 event 스키마로 저장
- **저장 위치**
  - `Storage` 하위로 `["session", <projectID>, <sessionID>, "event", <eventID>]` 같은 key 패턴
- **조회 경로**
  - 최소 1개 API(예: `GET /session/:sessionID/event`) 또는 기존 메시지 조회 흐름에 포함
- **테스트**
  - endpoint 테스트(서버 `Server.App().request`) 또는 순수 Storage 테스트 1개

### 구현 시 참고(패턴)
- 서버 엔드포인트 테스트 패턴: `packages/opencode/test/server/session-select.test.ts`
- 기존 메시지/파트 이벤트: `MessageV2.Event.*` / `Session.Event.*`
- storage 사용: `packages/opencode/src/storage/storage.ts`

---

## 새 세션에서 에이전트에게 줄 “최소 프롬프트”

다음만 전달하면 됨:

- “`feat/inspect-050-observability`에서 Chunk 050 진행”
- “`specs/inspect-agent-roadmap.md`와 이 핸드오프 문서 읽고 시작”
- “서버 테스트는 `Server.App().request` 패턴 사용”

