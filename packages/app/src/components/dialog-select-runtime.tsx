import { createMemo } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List } from "@opencode-ai/ui/list"
import { useDialog } from "@opencode-ai/ui/context/dialog"

import type { SessionRuntime } from "@/types/session-runtime"
import { useSandboxOnlyMode } from "@/utils/runtime-mode"

type RuntimeOption = {
  id: SessionRuntime
  label: string
  description: string
  disabled?: boolean
}

interface DialogSelectRuntimeProps {
  current: SessionRuntime
  inspectEnabled: boolean
  onSelect: (runtime: SessionRuntime) => void
}

export function DialogSelectRuntime(props: DialogSelectRuntimeProps) {
  const dialog = useDialog()
  const sandboxOnly = useSandboxOnlyMode()

  const options = createMemo<RuntimeOption[]>(() => [
    ...(sandboxOnly()
      ? []
      : ([
          {
            id: "local" as const,
            label: "Local",
            description: "현재 로컬 OpenCode 서버에서 세션을 시작합니다.",
          },
        ] satisfies RuntimeOption[])),
    {
      id: "sandbox",
      label: "Sandbox",
      description: "Inspect 샌드박스에서 세션을 시작합니다.",
      disabled: !props.inspectEnabled,
    },
  ])

  function select(value: SessionRuntime | undefined) {
    if (!value) return
    const opt = options().find((o) => o.id === value)
    if (opt?.disabled) return
    props.onSelect(value)
    dialog.close()
  }

  return (
    <Dialog
      title="Runtime"
      description={props.inspectEnabled ? "새 세션의 실행 환경을 선택하세요." : "Sandbox를 사용하려면 Inspect 설정이 필요합니다."}
    >
      <div class="flex flex-col gap-3 pb-2">
        <List
          items={options}
          key={(x) => x.id}
          current={options().find((x) => x.id === props.current)}
          onSelect={(x) => select(x?.id)}
        >
          {(i) => (
            <div class="flex items-center gap-3 min-w-0 flex-1">
              <div classList={{ "min-w-0 flex-1": true, "opacity-50": !!i.disabled }}>
                <div class="flex items-center gap-2">
                  <span class="text-14-regular text-text-strong">{i.label}</span>
                  <span class="text-12-regular text-text-weak">{i.disabled ? "(unavailable)" : ""}</span>
                </div>
                <div class="text-12-regular text-text-weak truncate">{i.description}</div>
              </div>
            </div>
          )}
        </List>
      </div>
    </Dialog>
  )
}

