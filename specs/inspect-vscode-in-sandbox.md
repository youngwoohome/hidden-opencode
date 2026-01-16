# Inspect: 샌드박스 내 “웹 기반 VS Code” (code-server/openvscode-server) 설계 메모

목표: Ramp Inspect가 언급한 “web-based VS Code editor”와 유사하게, **세션 샌드박스 VM 내부에서 동작하는 VS Code를 웹으로 접속**해 사용자가 수동 수정(Manual edits)을 할 수 있게 한다.  
핵심 요구: **온디맨드로 켰다가(버튼 클릭) 필요 없어지면 끄기**, 그리고 **세션/클라이언트(UI)와 자연스럽게 동기화**.

---

## 1) 범위/가정

- **샌드박스**: Modal 등 원격 VM/컨테이너에서 OpenCode 서버가 떠 있고, `sandboxUrl`로 외부 접속 가능.
- **클라이언트**: `packages/app`(Inspect UI)가 `sandboxUrl`을 알고 있고, 이를 통해 세션으로 접속/프롬프트 전송을 수행.
- **VS Code 형태**: 로컬 데스크탑 앱이 아니라 **샌드박스 안에서 실행되는 웹 기반 VS Code**(code-server 또는 openvscode-server).
- **비용 최적화**: 기본은 꺼짐. 사용자가 원할 때만 켜고, 다시 채팅으로 돌아오면 끄거나 idle timeout으로 자동 종료.

---

## 2) “Inspect의 VS Code 버튼” 해석

Ramp 글의 표현:
- “drop into a **web-based VS Code editor**”
- “A **hosted VS Code instance**, which runs **inside of the sandbox**”

따라서 버튼의 의미는 보통:
- 사용자의 로컬 VS Code로 이동(딥링크) **아님**
- 샌드박스 내부에 VS Code 서버를 띄워 웹으로 접속 **맞음**

---

## 3) 아키텍처(권장)

### 권장 구성(옵션 A)

- 샌드박스 내부에 다음 중 하나를 설치/실행:
  - **code-server** (가장 흔함)
  - **openvscode-server** (VS Code OSS 기반)
- 샌드박스 내부에서 프로세스로 실행하고, `sandboxUrl`의 특정 경로로 reverse proxy:
  - 예: `https://<sandboxUrl>/vscode/` → `127.0.0.1:<port>`

### 대안(옵션 B, 비권장)

- 로컬 VS Code(Desktop)로 여는 방식(딥링크/Remote SSH 류)
  - “노트북이 필요 없다”는 hosted agent 철학과 충돌
  - 사내 네트워크/SSH/자격증명/포트포워딩 난이도↑

---

## 4) 기능 요구사항(UX)

- **UI 버튼**
  - “VS Code 열기”
  - (VS Code 화면 상단) “채팅으로 돌아가기(= VS Code 종료)” 또는 “Stop VS Code”
- **온디맨드**
  - 기본 OFF
  - 필요 시 start
  - 사용 종료 시 stop (명시 버튼 + idle timeout 백업)
- **동기화 체감**
  - VS Code와 에이전트(OpenCode)가 **같은 worktree 디렉토리**를 바라보게 하면 기본적인 동기화는 자연스럽게 달성됨
  - 추가 UX(선택): VS Code에서 파일 저장 이벤트를 세션 이벤트로 남겨 채팅에 “User edited X files” 같은 로그 표시

---

## 5) API/라우팅 설계(제안)

샌드박스(OpenCode 서버와 같은 origin, 또는 샌드박스 프록시 계층)에 다음 엔드포인트를 추가한다는 가정.

### 5.1 상태 조회
- `GET /vscode/status`
  - 응답 예:
    - `{ running: true, url: "/vscode/", pid: 1234, startedAt: 1700000000000, idleTimeoutSec: 900 }`
    - `{ running: false }`

### 5.2 시작
- `POST /vscode/start`
  - 요청 body(예):
    - `{ worktree?: "/work/repo", profile?: "default", extensions?: ["..."], settings?: {...} }`
  - 응답:
    - `{ url: "/vscode/", running: true }`

### 5.3 종료
- `POST /vscode/stop`
  - 응답:
    - `{ ok: true }`

### 5.4 reverse proxy
- `GET /vscode/*`
  - 내부에서 `127.0.0.1:<port>`로 프록시
  - WebSocket 업그레이드 지원 필요(코드 서버가 사용)

---

## 6) 인증/권한(매우 중요)

문제: `sandboxUrl`이 외부에 노출되면 누구나 VS Code에 접근할 위험.

권장 접근(최소 1개는 필수):
- **세션 토큰 기반**
  - Inspect API(Workers/DO)가 세션 생성 시 `vscodeAccessToken` 같은 값을 발급
  - UI는 `sandboxUrl` 접근 시 `?token=...` 또는 `Authorization: Bearer ...`로 전달
  - 샌드박스는 token 검증 후에만 `/vscode/*` 허용
- **1회용 토큰 + 만료**
  - “VS Code 열기” 시점에만 짧은 TTL(예: 60초) 토큰 발급
- **IP/Origin 제한**
  - 현실적으로 완전한 해결은 아니므로 토큰 방식과 병행

주의:
- code-server 자체 auth(패스워드)만 쓰면 토큰 전달/저장/노출이 번거로움
- 가능하면 “샌드박스 프록시 레이어에서 토큰 검증 후 내부로만 프록시”가 관리가 쉬움

---

## 7) 비용/성능: “켜기/끄기”가 중요한 이유

- VS Code 서버는 다음 때문에 샌드박스가 완전 idle이 되기 어렵다:
  - 파일 인덱싱, LSP(tsserver/pylance 등), 파일 감시
  - 확장(extension) 백그라운드 작업
- 따라서:
  - **상시 ON** → 비용 상승 가능성 큼
  - **온디맨드 ON + 즉시 OFF/idle timeout** → 비용 영향을 제한할 수 있음

권장 정책:
- “채팅으로 돌아가기” 버튼 누르면 `POST /vscode/stop` 호출
- 백업 안전장치로 `idleTimeoutSec`(예: 10~30분) 후 자동 종료

---

## 8) 설정/확장(사용자화) 지속성 전략

샌드박스가 매번 새 VM이면 기본적으로 VS Code 설정/확장도 리셋될 수 있음. 이를 해결하는 방법:

### 8.1 기본값은 이미지에 “미리 굽기”(팀 표준)
- 이미지 빌드 단계에서:
  - 기본 `settings.json`, `keybindings.json`
  - 팀 공통 확장(최소 세트)
  - (가능하면) 언어 서버 최소화 구성
- 장점: 가장 단순, 빠름, 운영 용이

### 8.2 사용자 프로필을 외부 스토리지에 저장(개인화)
- 저장 대상 예:
  - `settings.json`
  - 설치 확장 목록(allowlist 기반) 또는 확장 번들
- 흐름:
  - `start` 시: 기본 + 사용자 오버레이 적용
  - `stop` 시: 사용자 변경분 업로드(또는 “Save” 버튼으로 명시 저장)
- 저장소: R2/S3/DB(세션/계정 기준)

### 8.3 세션 스냅샷/복원(Inspect가 말한 방식)
- Modal snapshot/restore가 안정적이면:
  - “같은 세션”을 다시 열 때 설정/확장 그대로 유지 가능
- 단점:
  - 사용자 “전역 프로필”로 쓰기에는 불편(세션 단위로 흩어짐)

권장 결합:
- **팀 기본은 이미지**(8.1)
- **개인화는 외부 프로필**(8.2)
- **세션 재개는 스냅샷**(8.3)

보안 주의:
- 확장은 실행 코드이므로 무제한 설치는 위험
- 최소한:
  - 확장 allowlist
  - Marketplace 접근 제한(또는 내부 mirror)
  - 위험 설정 제한

---

## 9) 구현 체크리스트(실행 계획)

### Phase 0: PoC
- [ ] 샌드박스 이미지에 code-server/openvscode-server 설치
- [ ] `POST /vscode/start`로 프로세스 실행(고정 포트)
- [ ] `GET /vscode/*` reverse proxy 연결(WS 포함)

### Phase 1: 제품 UX
- [ ] `packages/app`에 “VS Code” 버튼 추가(Inspect sandbox 컨텍스트에서만 노출)
- [ ] “Back to chat (stops VS Code)” 버튼/동작 추가
- [ ] `GET /vscode/status`로 현재 상태 표시(켜짐/꺼짐)

### Phase 2: 보안
- [ ] Inspect API에서 VS Code 접근 토큰 발급/검증 플로우 설계
- [ ] 토큰 없는 `/vscode/*` 접근 차단
- [ ] 로그/감사(누가/언제 VS Code를 켰는지)

### Phase 3: 비용 최적화
- [ ] idle timeout 자동 종료
- [ ] LSP/확장 최소화(기본 세팅)

### Phase 4: 사용자화
- [ ] 기본 설정/확장 이미지 bake
- [ ] 사용자 프로필 저장/복원(외부 스토리지)
- [ ] allowlist 정책

---

## 10) 결정해야 할 질문(구현 전 합의 포인트)

- VS Code 서버 선택: **code-server vs openvscode-server**
- 인증 방식: 세션 토큰을 **어디서 검증할지**(샌드박스 자체 vs 프록시/DO)
- 프로필 저장소: R2/S3/DB 중 무엇을 사용할지
- 확장 정책: allowlist/marketplace 접근 여부
- idle timeout 값(기본 10~30분 권장)

