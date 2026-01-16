import { action, createAsync, json, query, useParams, useSubmission } from "@solidjs/router"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { GithubRepoAllowlist } from "@opencode-ai/console-core/github-repo-allowlist.js"
import { withActor } from "~/context/auth.withActor"
import styles from "./github-allowlist-section.module.css"

const listAllowlist = query(async (workspaceID: string) => {
  "use server"
  return withActor(() => GithubRepoAllowlist.list(), workspaceID)
}, "github.allowlist.list")

const addRepo = action(async (form: FormData) => {
  "use server"
  const owner = form.get("owner")?.toString()
  const repo = form.get("repo")?.toString()
  const workspaceID = form.get("workspaceID")?.toString()
  if (!owner) return { error: "Owner is required" }
  if (!repo) return { error: "Repo is required" }
  if (!workspaceID) return { error: "Workspace ID is required" }
  return json(
    await withActor(
      () =>
        GithubRepoAllowlist.add({ owner, repo })
          .then(() => ({ error: undefined }))
          .catch((e) => ({ error: e.message as string })),
      workspaceID,
    ),
    { revalidate: listAllowlist.key },
  )
}, "github.allowlist.add")

const removeRepo = action(async (form: FormData) => {
  "use server"
  const owner = form.get("owner")?.toString()
  const repo = form.get("repo")?.toString()
  const workspaceID = form.get("workspaceID")?.toString()
  if (!owner) return { error: "Owner is required" }
  if (!repo) return { error: "Repo is required" }
  if (!workspaceID) return { error: "Workspace ID is required" }
  return json(await withActor(() => GithubRepoAllowlist.remove({ owner, repo }), workspaceID), {
    revalidate: listAllowlist.key,
  })
}, "github.allowlist.remove")

export function GithubAllowlistSection() {
  const params = useParams()
  const repos = createAsync(() => listAllowlist(params.id!))
  const addSubmission = useSubmission(addRepo)
  const [store, setStore] = createStore({ owner: "", repo: "" })

  function onInput(field: "owner" | "repo") {
    return (event: Event) => {
      const target = event.target as HTMLInputElement
      setStore(field, target.value)
    }
  }

  return (
    <section class={styles.root}>
      <div data-slot="section-title">
        <h2>GitHub allowlist</h2>
        <p>Restrict PR creation to approved repositories in this workspace.</p>
      </div>
      <div data-slot="section-content">
        <form action={addRepo} method="post" data-slot="add-form">
          <input
            name="owner"
            type="text"
            placeholder="owner"
            value={store.owner}
            onInput={onInput("owner")}
          />
          <input name="repo" type="text" placeholder="repo" value={store.repo} onInput={onInput("repo")} />
          <input type="hidden" name="workspaceID" value={params.id} />
          <button type="submit" data-color="primary" disabled={addSubmission.pending}>
            {addSubmission.pending ? "Adding..." : "Add"}
          </button>
          <Show when={addSubmission.result && addSubmission.result.error}>
            {(err) => <div data-slot="form-error">{err()}</div>}
          </Show>
        </form>

        <div data-slot="allowlist-table">
          <table data-slot="allowlist-table-element">
            <thead>
              <tr>
                <th>Owner</th>
                <th>Repo</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <For each={repos() ?? []}>
                {(row) => (
                  <tr>
                    <td data-slot="allowlist-owner">{row.owner}</td>
                    <td data-slot="allowlist-repo">{row.repo}</td>
                    <td data-slot="allowlist-action">
                      <form action={removeRepo} method="post">
                        <input type="hidden" name="owner" value={row.owner} />
                        <input type="hidden" name="repo" value={row.repo} />
                        <input type="hidden" name="workspaceID" value={params.id} />
                        <button data-color="ghost" type="submit">
                          Remove
                        </button>
                      </form>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  )
}
