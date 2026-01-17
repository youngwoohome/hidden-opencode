import { useGlobalSync } from "@/context/global-sync"
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { Button } from "@opencode-ai/ui/button"
import { Logo } from "@opencode-ai/ui/logo"
import { useLayout } from "@/context/layout"
import { useNavigate } from "@solidjs/router"
import { base64Encode } from "@opencode-ai/util/encode"
import { Icon } from "@opencode-ai/ui/icon"
import { usePlatform } from "@/context/platform"
import { DateTime } from "luxon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { DialogSelectDirectory } from "@/components/dialog-select-directory"
import { DialogSelectServer } from "@/components/dialog-select-server"
import { useServer } from "@/context/server"
import { showToast } from "@opencode-ai/ui/toast"
import { Persist, persisted } from "@/utils/persist"
import { useInspectRepo } from "@/context/inspect-repo"
import { DialogInspectRepo } from "@/components/dialog-inspect-repo"

export default function Home() {
  const sync = useGlobalSync()
  const layout = useLayout()
  const platform = usePlatform()
  const dialog = useDialog()
  const navigate = useNavigate()
  const server = useServer()
  const inspectRepo = useInspectRepo()
  const homedir = createMemo(() => sync.data.path.home)
  const [startingInspect, setStartingInspect] = createSignal(false)
  const [inspectSandboxes, setInspectSandboxes] = persisted(
    Persist.global("inspect-sandboxes", ["inspect-sandboxes.v1"]),
    createStore({
      urls: [] as string[],
    }),
  )

  const registerInspectSandbox = (url: string) => {
    setInspectSandboxes("urls", (prev) => {
      const next = [url, ...prev.filter((item) => item !== url)]
      return next.slice(0, 50)
    })
  }

  const inspectApiUrl = () => import.meta.env.VITE_INSPECT_API_URL?.replace(/\/+$/, "")
  const inspectSandboxProvider = () => import.meta.env.VITE_INSPECT_SANDBOX_PROVIDER ?? "modal"
  const inspectModel = () => import.meta.env.VITE_INSPECT_MODEL
  const isInspectContext = createMemo(() => {
    const api = inspectApiUrl()
    const url = server.url
    if (!api || !url) return false
    return url === api || inspectSandboxes.urls.includes(url)
  })
  const isInspectApi = createMemo(() => {
    const api = inspectApiUrl()
    const url = server.url
    if (!api || !url) return false
    return url === api
  })

  function parseModel(input?: string) {
    if (!input) return undefined
    const [providerID, ...rest] = input.split("/")
    if (!providerID || rest.length === 0) return undefined
    return { providerID, modelID: rest.join("/") }
  }

  function openProject(directory: string) {
    layout.projects.open(directory)
    navigate(`/${base64Encode(directory)}`)
  }

  createEffect(() => {
    // If we're already connected to a real server (local or sandbox) and we have projects,
    // skip the Home screen and jump straight into the main app (DirectoryLayout → Session).
    // Avoid doing this on the Inspect API "control plane" itself.
    if (isInspectApi()) return
    const projects = sync.data.project
    if (!projects.length) return
    const mostRecent = projects
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))[0]
    if (!mostRecent?.worktree) return
    openProject(mostRecent.worktree)
  })

  async function chooseProject() {
    function resolve(result: string | string[] | null) {
      if (Array.isArray(result)) {
        for (const directory of result) {
          openProject(directory)
        }
      } else if (result) {
        openProject(result)
      }
    }

    if (platform.openDirectoryPickerDialog && server.isLocal()) {
      const result = await platform.openDirectoryPickerDialog?.({
        title: "Open project",
        multiple: true,
      })
      resolve(result)
    } else {
      dialog.show(
        () => <DialogSelectDirectory multiple={true} onSelect={resolve} />,
        () => resolve(null),
      )
    }
  }

  async function startInspectSandbox() {
    if (startingInspect()) return
    const apiUrl = inspectApiUrl()
    const repo = inspectRepo.current()

    if (!apiUrl || !repo?.url) {
      showToast({
        title: "Inspect repo missing",
        description: "Add a repository before starting a new Inspect session.",
      })
      dialog.show(() => <DialogInspectRepo />)
      return
    }

    const payload = {
      repo: { url: repo.url, ...(repo.ref ? { ref: repo.ref } : {}) },
      model: parseModel(inspectModel()),
      sandbox: { provider: inspectSandboxProvider() },
    }

    setStartingInspect(true)
    try {
      const response = await (platform.fetch ?? fetch)(`${apiUrl}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const detail = await response.text().catch(() => "")
        throw new Error(detail || response.statusText)
      }
      const data = await response.json()
      const sandboxUrl = data?.sandbox?.url
      const opencodeSessionID = data?.opencode?.sessionID as string | undefined
      if (!sandboxUrl) {
        throw new Error("Sandbox URL not returned")
      }
      registerInspectSandbox(sandboxUrl)
      server.add(sandboxUrl)
      let worktree = "/work/repo"
      try {
        const projectResponse = await (platform.fetch ?? fetch)(`${sandboxUrl}/project/current`)
        if (projectResponse.ok) {
          const project = await projectResponse.json()
          if (typeof project?.worktree === "string" && project.worktree.trim()) {
            worktree = project.worktree
          }
        }
      } catch {}
      const encoded = base64Encode(worktree)
      navigate(`/${encoded}/session${opencodeSessionID ? `/${opencodeSessionID}` : ""}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start sandbox"
      showToast({ title: "Sandbox start failed", description: message })
    } finally {
      setStartingInspect(false)
    }
  }

  return (
    <div class="mx-auto mt-55 w-full md:w-auto px-4">
      <Logo class="md:w-xl opacity-12" />
      <Button
        size="large"
        variant="ghost"
        class="mt-4 mx-auto text-14-regular text-text-weak"
        onClick={() => dialog.show(() => <DialogSelectServer />)}
      >
        <div
          classList={{
            "size-2 rounded-full": true,
            "bg-icon-success-base": server.healthy() === true,
            "bg-icon-critical-base": server.healthy() === false,
            "bg-border-weak-base": server.healthy() === undefined,
          }}
        />
        {server.name}
      </Button>
      <Show when={inspectApiUrl() && isInspectApi()}>
        <div class="mt-4 mx-auto flex flex-col items-center gap-2">
          <Button size="large" onClick={startInspectSandbox} disabled={startingInspect()}>
            {startingInspect() ? "Starting sandbox..." : "Start Inspect sandbox"}
          </Button>
          <Button variant="ghost" size="normal" onClick={() => dialog.show(() => <DialogInspectRepo />)}>
            Configure Inspect repo
          </Button>
        </div>
      </Show>
      <Switch>
        <Match when={sync.data.project.length > 0}>
          <div class="mt-20 w-full flex flex-col gap-4">
            <div class="flex gap-2 items-center justify-between pl-3">
              <div class="text-14-medium text-text-strong">Recent projects</div>
              <Button icon="folder-add-left" size="normal" class="pl-2 pr-3" onClick={chooseProject}>
                Open project
              </Button>
            </div>
            <ul class="flex flex-col gap-2">
              <For
                each={sync.data.project
                  .toSorted((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
                  .slice(0, 5)}
              >
                {(project) => (
                  <Button
                    size="large"
                    variant="ghost"
                    class="text-14-mono text-left justify-between px-3"
                    onClick={() => openProject(project.worktree)}
                  >
                    {project.worktree.replace(homedir(), "~")}
                    <div class="text-14-regular text-text-weak">
                      {DateTime.fromMillis(project.time.updated ?? project.time.created).toRelative()}
                    </div>
                  </Button>
                )}
              </For>
            </ul>
          </div>
        </Match>
        <Match when={true}>
          <div class="mt-30 mx-auto flex flex-col items-center gap-3">
            <Icon name="folder-add-left" size="large" />
            <div class="flex flex-col gap-1 items-center justify-center">
              <div class="text-14-medium text-text-strong">No recent projects</div>
              <div class="text-12-regular text-text-weak">Get started by opening a local project</div>
            </div>
            <div />
            <Button class="px-3" onClick={chooseProject}>
              Open project
            </Button>
          </div>
        </Match>
      </Switch>
    </div>
  )
}
