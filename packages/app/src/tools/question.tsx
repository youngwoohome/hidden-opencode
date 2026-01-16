import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { ToolRegistry, type ToolProps } from "@opencode-ai/ui/message-part"
import { BasicTool } from "@opencode-ai/ui/basic-tool"
import { Button } from "@opencode-ai/ui/button"
import { Checkbox } from "@opencode-ai/ui/checkbox"
import { showToast } from "@opencode-ai/ui/toast"
import { useSDK } from "@/context/sdk"

type QuestionOption = { label: string; description?: string }
type QuestionInfo = { question: string; header?: string; options?: QuestionOption[]; multiple?: boolean }
type QuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
  tool?: { messageID: string; callID: string }
}

const QuestionTool = (props: ToolProps) => {
  const sdk = useSDK()
  const [request, setRequest] = createSignal<QuestionRequest | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [submitting, setSubmitting] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [answers, setAnswers] = createStore<{ selections: Record<number, string[]> }>({
    selections: {},
  })

  const questions = createMemo(() => (props.input?.questions as QuestionInfo[] | undefined) ?? [])
  const hasQuestions = createMemo(() => questions().length > 0)

  const syncAnswersFromRequest = () => {
    const req = request()
    if (!req) return
    setAnswers("selections", {})
  }

  const resolveRequest = (list: QuestionRequest[]) => {
    if (props.callID && props.messageID) {
      const exact = list.find(
        (item) => item.tool?.callID === props.callID && item.tool?.messageID === props.messageID,
      )
      if (exact) return exact
    }

    if (props.sessionID) {
      const bySession = list.filter((item) => item.sessionID === props.sessionID)
      if (bySession.length === 1) return bySession[0]
    }

    const inputQuestions = questions()
    if (inputQuestions.length > 0) {
      const byPrompt = list.find(
        (item) =>
          item.questions?.length === inputQuestions.length &&
          item.questions?.[0]?.question === inputQuestions[0]?.question,
      )
      if (byPrompt) return byPrompt
    }

    return null
  }

  const loadRequest = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await sdk.client.question.list()
      const list = (response.data ?? []) as QuestionRequest[]
      const match = resolveRequest(list)
      setRequest(match ?? null)
      if (!match) {
        setError("Question request not found. It may have been answered or dismissed.")
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load question request."
      setError(message)
    } finally {
      setLoading(false)
      syncAnswersFromRequest()
    }
  }

  const toggleOption = (index: number, label: string, multiple?: boolean) => {
    setAnswers("selections", index, (prev) => {
      const current = prev ?? []
      if (multiple) {
        return current.includes(label) ? current.filter((item) => item !== label) : [...current, label]
      }
      return current.includes(label) ? [] : [label]
    })
  }

  const submitAnswers = async () => {
    let req = request()
    if (!req) {
      await loadRequest()
      req = request()
    }
    if (!req) {
      showToast({ title: "Question not available", description: "Try again after refreshing the session." })
      return
    }
    setSubmitting(true)
    try {
      const payload = questions().map((_, index) => answers.selections[index] ?? [])
      await sdk.client.question.reply({
        requestID: req.id,
        answers: payload,
      })
      showToast({ title: "Answers submitted" })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to submit answers."
      showToast({ title: "Question failed", description: message })
    } finally {
      setSubmitting(false)
    }
  }

  const rejectRequest = async () => {
    const req = request()
    if (!req) return
    setSubmitting(true)
    try {
      await sdk.client.question.reject({ requestID: req.id })
      showToast({ title: "Question dismissed" })
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to dismiss question."
      showToast({ title: "Question failed", description: message })
    } finally {
      setSubmitting(false)
    }
  }

  createEffect(() => {
    if (props.status !== "completed") {
      void loadRequest()
    }
  })

  return (
    <BasicTool
      {...props}
      icon="speech-bubble"
      trigger={{
        title: props.output ? "Question" : "Question pending",
      }}
    >
      <div data-component="tool-output" data-scrollable class="flex flex-col gap-4">
        <Show when={props.output}>
          {(output) => <div class="text-12-regular text-text-base whitespace-pre-wrap">{output()}</div>}
        </Show>
        <Show when={!props.output}>
          <Show when={hasQuestions()} fallback={<div class="text-12-regular text-text-weak">No question details.</div>}>
            <For each={questions()}>
              {(question, index) => (
                <div class="flex flex-col gap-2">
                  <div class="flex items-center gap-2 text-12-medium text-text-strong">
                    <span>{question.header || `Question ${index() + 1}`}</span>
                    <Show when={question.multiple}>
                      <span class="text-11-regular text-text-weak">multiple</span>
                    </Show>
                  </div>
                  <div class="text-12-regular text-text-base">{question.question}</div>
                  <div class="flex flex-col gap-2">
                    <For each={question.options ?? []}>
                      {(option) => {
                        const selected = createMemo(() =>
                          (answers.selections[index()] ?? []).includes(option.label),
                        )
                        return (
                          <button
                            type="button"
                            class="flex items-start gap-2 rounded-md border border-border-base px-2.5 py-2 text-left hover:bg-surface-raised-base"
                            onClick={() => toggleOption(index(), option.label, question.multiple)}
                          >
                            <Checkbox checked={selected()} />
                            <div class="flex flex-col gap-0.5">
                              <span class="text-12-medium text-text-strong">{option.label}</span>
                              <Show when={option.description}>
                                <span class="text-11-regular text-text-weak">{option.description}</span>
                              </Show>
                            </div>
                          </button>
                        )
                      }}
                    </For>
                  </div>
                </div>
              )}
            </For>
          </Show>
          <Show when={error()}>
            {(message) => <div class="text-12-regular text-text-weak">{message()}</div>}
          </Show>
          <div class="flex items-center gap-2">
            <Button size="small" onClick={submitAnswers} disabled={submitting() || loading()}>
              Submit answers
            </Button>
            <Button variant="ghost" size="small" onClick={rejectRequest} disabled={submitting() || loading()}>
              Dismiss
            </Button>
          </div>
        </Show>
      </div>
    </BasicTool>
  )
}

ToolRegistry.register({ name: "question", render: QuestionTool })
