/** The model list the Klipara Scout card offers for its shift and fallback models. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** What the pickers render. */
export interface ScoutModelCatalogState {
  status: 'loading' | 'ready' | 'error'
  groups: readonly ModelProviderGroup[]
}

/** Loads the Host's model catalog and reloads it when adapters or settings change. */
export class ScoutModelCatalog {
  /** The current catalog. */
  readonly store: SnapshotStore<ScoutModelCatalogState> = createSnapshotStore<ScoutModelCatalogState>({ status: 'loading', groups: [] })
  private generation = 0

  /** @param ctx - the plugin context, whose `remote.session` namespace serves the catalog. */
  constructor(private readonly ctx: ClientContext) {}

  /** Load the catalog again, dropping any answer still in flight. */
  refresh(): void {
    const generation = ++this.generation
    this.store.update((draft) => { draft.status = draft.groups.length === 0 ? 'loading' : draft.status })
    let request: ReturnType<ClientContext['remote']['session']['modelCatalog']>
    try {
      request = this.ctx.remote.session.modelCatalog()
    } catch {
      // A Host without the session namespace serves no catalog: the pickers say so and offer a retry.
      this.store.update((draft) => { draft.status = 'error' })
      return
    }
    request.then((response) => {
      if (generation !== this.generation) return
      this.store.set(response.ok ? { status: 'ready', groups: response.value.groups } : { status: 'error', groups: this.store.getSnapshot().groups })
    }, () => {
      if (generation === this.generation) this.store.update((draft) => { draft.status = 'error' })
    })
  }
}
