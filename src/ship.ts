/**
 * `ship()` library function.
 *
 * Takes copy text + a destination handle from brand-kit, looks up the
 * adapter, dispatches the publish. Mirror of the `gen` entry point — both
 * the CLI shell and any direct library consumer call through here.
 *
 * V0.1.0-alpha.6: output-file is real, three SaaS adapters are stubs.
 */

import { defaultDestinations } from './destination/index.js'
import type { DestinationAdapter, ShipResult } from './destination/index.js'
import type { BrandKit } from './types.js'

export interface ShipOptions {
  copy: string
  /** Key in brand-kit.destinations.entries. */
  destination: string
  brandKit: BrandKit
  /** Override the default destination roster (e.g. for tests). */
  adapters?: DestinationAdapter[]
}

export async function ship(opts: ShipOptions): Promise<ShipResult> {
  const { copy, destination, brandKit, adapters: adaptersOverride } = opts

  const entry = brandKit.destinations?.entries?.[destination]
  if (!entry) {
    return {
      ok: false,
      destinationName: destination,
      adapterName: '?',
      error: `destination "${destination}" not declared in brand-kit.destinations.entries`,
    }
  }

  const adapters = adaptersOverride ?? (await defaultDestinations())
  const byName = new Map(adapters.map((a) => [a.name, a]))
  const adapter = byName.get(entry.adapter)
  if (!adapter) {
    return {
      ok: false,
      destinationName: destination,
      adapterName: entry.adapter,
      error: `no DestinationAdapter registered for adapter name "${entry.adapter}"`,
    }
  }

  return await adapter.publish({
    copy,
    targetName: destination,
    config: entry.config ?? {},
  })
}
