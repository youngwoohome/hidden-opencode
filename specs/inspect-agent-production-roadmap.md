# Inspect 유사 백그라운드 코딩 에이전트 — Production 레벨 로드맵(체크리스트)

이 문서는 제공된 PDF(“Inspect 유사 시스템 구현 계획”)를 기준으로, 현재 `dev`에 머지된 MVP 상태에서 **프로덕션 레벨**로 가기 위해 필요한 작업을 **갭 분석 + 단계별 체크리스트**로 정리합니다.

---

## 현재 상태 요약(이미 구현된 MVP 범위)

아래는 “프로덕션”과는 별개로, 이미 구축된 기반입니다(010~100 완료):

- **세션/툴 스모크**(세션 생성→shell(tool)→메시지 조회)
- **로컬 샌드박스(worktree) 생성/삭제** + 테스트
- **Closed-loop(최소)**: step 변경 후 typecheck/test 실행 + 실패 시 revert(실험 플래그)
- **관측(최소)**: tool 실행 이벤트를 세션 이벤트 로그로 저장/조회
- **UI 검증(최소)**: HTML(DOM) 스냅샷 저장/비교(서버 API + 테스트)
- **스폰/조인**: child session spawn/join + 부모 세션에 synthetic 요약 + event log 기록
- **협업 인터페이스(최소)**: `session spawn/join` CLI
- **PR/CI(최소)**: PR 생성 “드라이런 플랜” CLI
- **안전망(최소)**: 위험 bash 추가 승인(`bash_dangerous`) + timeout cap

즉, “제품화”를 위한 토대는 잡혔고, 이제는 **격리/운영/보안/관측/UX/통합**을 강화해야 합니다.

---

## Production 레벨 정의(DoD 요약)

PDF 관점에서 “프로덕션 레벨”은 최소 아래를 만족해야 합니다.

- **격리된 실행 환경**: 세션별(또는 작업별) 샌드박스가 실제로 격리(파일/프로세스/네트워크/권한/리소스)됨
- **Closed-loop 신뢰성**: 검증 파이프라인이 반복 가능하고 실패/중단/재시도/롤백이 일관됨
- **관측/재현**: 누가/언제/무엇을 했는지 event + artifact(로그/스냅샷/패치)가 남고 재현 가능
- **안전/권한**: 위험 행동이 기본 차단/승인되고 감사 로그가 남음
- **실사용 인터페이스**: CLI/웹/Slack 등 최소 1개 “팀이 실제로 쓰는” 인터페이스에서 E2E 흐름이 원활
- **PR/CI 연동**: PR 생성/업데이트/CI 결과 수집이 자동화되어 개발 루프가 닫힘
- **운영**: 배포/업그레이드/모니터링/알림/장애 대응이 가능한 수준

---

## 우선순위 로드맵(프로덕션까지의 단계)

### Phase 1 — 샌드박스 “진짜 격리”로 승격(가장 우선)
PDF의 핵심은 세션별 격리된 개발환경입니다. 현재는 로컬 worktree 기반이므로, 프로덕션에선 아래를 추가해야 합니다.

- **샌드박스 타입 결정**
  - [ ] VM 기반(예: Firecracker/VM) vs 컨테이너 기반 vs Managed Sandbox(예: Modal) 결정
  - [ ] 네트워크 정책(내부 서비스만/인터넷 허용/도메인 allowlist) 결정
- **샌드박스 수명/정책**
  - [ ] 세션→샌드박스 1:1 매핑(기본) + 재사용 정책(옵션) 정의
  - [ ] TTL/idle timeout/강제 종료 정책
  - [ ] 디스크/CPU/RAM 상한 설정(리소스 캡)
- **프로비저닝**
  - [ ] 레포 checkout/캐시 전략(의존성 캐시, 레이어 캐시)
  - [ ] DB/큐 등 로컬 의존성(예: Postgres) 포함 여부 및 템플릿화
- **보안 경계**
  - [ ] secrets 주입 정책(최소 권한, expiring tokens)
  - [ ] 호스트 탈출 방지(컨테이너면 seccomp/apparmor 등)

### Phase 2 — Frontend “브라우저 기반” 검증으로 업그레이드
현재 HTML fetch diff는 최소치이고, PDF는 headless/VNC/스크린샷 기반 검증까지 포함합니다.

- **헤드리스 브라우저 도입**
  - [ ] Playwright/Puppeteer 중 선택 및 런타임/샌드박스 연계
  - [ ] 인증/세션 쿠키/로그인 플로우 처리(테스트 계정/토큰)
- **스냅샷 아티팩트**
  - [ ] 스크린샷(이미지) 저장 + 비교(픽셀 diff/threshold)
  - [ ] DOM snapshot(정규화) + 비교(불안정 요소 제거: timestamp/random)
  - [ ] PR 코멘트/아티팩트 업로드(스크린샷 첨부)

### Phase 3 — PR/CI “실행 모드” + CI 결과 수집
현재는 드라이런 플랜만 있습니다. 프로덕션은 실제 PR 생성/업데이트/상태 추적이 필요합니다.

- **PR 실행 모드**
  - [ ] `gh` 의존을 유지할지, Octokit API로 직접 호출할지 결정
  - [ ] 토큰/권한/비밀 관리(사용자 계정 vs bot 계정)
  - [ ] 브랜치 생성→커밋→푸시→PR 생성/업데이트 자동화
  - [ ] “드라이런/실행” 모드 토글 및 안전장치(confirmation)
- **CI 결과 수집**
  - [ ] GitHub Checks/Actions 상태 폴링/웹훅
  - [ ] 실패 원인 요약(로그 링크, 실패 step)
  - [ ] 에이전트가 CI 실패를 바탕으로 재시도/수정 루프를 도는 정책(옵션)

### Phase 4 — 관측/재현(리플레이) 강화
현재 event log는 “tool 이벤트” 중심입니다. 프로덕션은 “작업 전체”를 재현 가능해야 합니다.

- **이벤트 스키마 확장**
  - [ ] permission asked/replied 기록
  - [ ] spawn/join, closed-loop verify 결과, worktree/sandbox lifecycle 이벤트
  - [ ] 모델 호출 메타데이터(모델/토큰/비용/재시도/에러 분류)
- **아티팩트 저장**
  - [ ] 로그/스크린샷/DOM snapshot/patch/diff 저장(세션 단위)
  - [ ] PII/secret redaction
- **리플레이**
  - [ ] “이 세션이 실행한 커맨드/툴” 재실행 가능한 최소 리플레이 스펙
  - [ ] 재현 가능한 환경 스냅샷(샌드박스 이미지/의존성 버전)

### Phase 5 — 안전망(권한/정책/감사) 확장
현재는 `bash_dangerous` 추가 승인 + timeout cap 정도입니다. 프로덕션은 정책 기반 제어가 필요합니다.

- **정책 엔진**
  - [ ] allow/deny/ask를 tool별 + 패턴별 + 프로젝트별로 관리 UI/API
  - [ ] 위험 명령 정책(예: `rm -rf`, `curl | bash`, `sudo`, `dd`) 지속 확장
  - [ ] 네트워크 egress 제어(도메인 allowlist)
- **레이트리밋/쿼터**
  - [ ] 세션당/사용자당 동시 실행 수 제한
  - [ ] 시간/비용/토큰/디스크 사용량 쿼터
- **감사 로그**
  - [ ] 누가 승인했는지(사용자/팀) 기록
  - [ ] PR/배포 같은 위험 행위는 2인 승인(optional)

### Phase 6 — 멀티 모델/멀티 세션 운영
PDF는 멀티 모델 플러그인, 병렬 세션, 하위 에이전트 스폰을 강조합니다.

- **멀티 모델**
  - [ ] Provider별 설정/폴백/라우팅
  - [ ] 비용/성능 기반 모델 선택 정책
- **병렬 실행**
  - [ ] 세션/작업 큐잉(우선순위, 동시성 제한)
  - [ ] child session fan-out/fan-in(요약/합류) 전략 고도화

### Phase 7 — 인터페이스 확장(Slack/Web/Extension 중 최소 1개를 “실사용” 수준으로)
MVP CLI는 유용하지만, PDF는 협업 모드(멀티플레이어)와 다양한 인터페이스를 제안합니다.

- **Slack**
  - [ ] 세션 생성/상태/승인 요청/결과 요약 메시지 UX(Block Kit)
  - [ ] 권한 위임/감사(누가 요청/승인했는지)
- **Web UI**
  - [ ] 세션 대시보드, 로그/아티팩트 뷰, 승인 플로우 UI
- **Chrome Extension(선택)**
  - [ ] DOM 선택→파일 매핑→수정 요청→결과 확인

---

## 권장 “다음 2주” 실행 플랜(현실적인 프로덕션 진입 순서)

- **1순위**: Phase 3(PR 실행 모드 + CI 결과 수집) 중 “PR 실제 생성”을 최소 1 repo에서 end-to-end
- **2순위**: Phase 1(샌드박스 격리)에서 “네트워크/리소스 캡 + TTL”부터 도입
- **3순위**: Phase 4(관측/재현)에서 “permission + verify + sandbox lifecycle” 이벤트 확장
- **4순위**: Phase 2(Playwright)로 UI 스크린샷 비교 1 플로우

---

## 참고 링크(검색 결과 기반)

- [Closed-Loop Development: How AI Agents Build Software While You Sleep](https://medium.com/@alexzanfir/closed-loop-development-how-ai-agents-build-software-while-you-sleep-6df42cd05a85)
- [How Coding Agents Actually Work: Inside OpenCode](https://cefboud.com/posts/coding-agents-internals-opencode-deepdive/)
- [Cloudflare Agents](https://agents.cloudflare.com/)
- [Building agents with OpenAI and Cloudflare's Agents SDK](https://blog.cloudflare.com/building-agents-with-openai-and-cloudflares-agents-sdk/)

