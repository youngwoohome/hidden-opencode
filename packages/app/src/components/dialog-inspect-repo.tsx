import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Icon } from "@opencode-ai/ui/icon"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { createStore } from "solid-js/store"
import { createMemo, For, Show } from "solid-js"
import { useInspectRepo } from "@/context/inspect-repo"

export function DialogInspectRepo() {
  const dialog = useDialog()
  const inspectRepo = useInspectRepo()
  const [store, setStore] = createStore({
    url: "",
    ref: "",
    name: "",
    error: "",
  })

  const currentID = createMemo(() => inspectRepo.current()?.id)
  const userRepoIds = createMemo(() => inspectRepo.userRepoIds())
  const repos = createMemo(() => inspectRepo.repos())

  const addRepo = (event: SubmitEvent) => {
    event.preventDefault()
    const repo = inspectRepo.addRepo({
      url: store.url,
      ref: store.ref || undefined,
      name: store.name || undefined,
    })
    if (!repo) {
      setStore("error", "Enter a valid GitHub repo URL.")
      return
    }
    setStore({
      url: "",
      ref: "",
      name: "",
      error: "",
    })
  }

  return (
    <Dialog title="Inspect repositories" description="Pick the default repo for new Inspect sessions.">
      <div class="flex flex-col gap-5 px-2.5 pb-3">
        <div class="flex flex-col gap-2">
          <div class="text-12-medium text-text-weak">Repositories</div>
          <Show
            when={repos().length > 0}
            fallback={<div class="text-12-regular text-text-weak">No repositories configured yet.</div>}
          >
            <div class="flex flex-col gap-1.5">
              <For each={repos()}>
                {(repo) => (
                  <button
                    type="button"
                    class="flex items-center gap-2 rounded-md border border-border-base px-3 py-2 text-left hover:bg-surface-raised-base"
                    onClick={() => inspectRepo.selectRepo(repo.id)}
                  >
                    <div class="flex-1 min-w-0">
                      <div class="text-12-medium text-text-strong truncate">{repo.name}</div>
                      <div class="text-11-regular text-text-weak truncate">
                        {repo.url}
                        <Show when={repo.ref}>
                          <span class="text-text-weak">#{repo.ref}</span>
                        </Show>
                      </div>
                    </div>
                    <Show when={currentID() === repo.id}>
                      <Icon name="check-small" class="text-icon-success-base" />
                    </Show>
                    <Show when={userRepoIds().has(repo.id)}>
                      <Button
                        type="button"
                        variant="ghost"
                        size="small"
                        icon="circle-x"
                        onClick={(event) => {
                          event.stopPropagation()
                          inspectRepo.removeRepo(repo.id)
                        }}
                      />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>

        <form onSubmit={addRepo} class="flex flex-col gap-3">
          <TextField
            label="Repo URL"
            placeholder="https://github.com/org/repo"
            value={store.url}
            onChange={(value) => setStore("url", value)}
            error={store.error || undefined}
          />
          <div class="grid grid-cols-2 gap-3">
            <TextField
              label="Ref (optional)"
              placeholder="main"
              value={store.ref}
              onChange={(value) => setStore("ref", value)}
            />
            <TextField
              label="Name (optional)"
              placeholder="my-repo"
              value={store.name}
              onChange={(value) => setStore("name", value)}
            />
          </div>
          <div class="flex items-center gap-2 pt-1">
            <Button type="submit" icon="plus-small">
              Add repo
            </Button>
            <Button type="button" variant="ghost" onClick={() => dialog.close()}>
              Done
            </Button>
          </div>
        </form>
      </div>
    </Dialog>
  )
}
