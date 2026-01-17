import { usePlatform } from "@/context/platform"

/**
 * Web 배포(production)에서는 기본적으로 Sandbox-only 모드가 켜집니다.
 * - Desktop(Tauri)은 local 워크플로를 유지
 * - Dev 서버(localhost:3000 등)에서는 기본적으로 끄고, env로 강제 가능
 */
export function useSandboxOnlyMode() {
  const platform = usePlatform()
  const force = import.meta.env.VITE_WEB_SANDBOX_ONLY === "true"
  const isWeb = platform.platform === "web"
  const isProd = import.meta.env.PROD
  return () => force || (isWeb && isProd)
}

