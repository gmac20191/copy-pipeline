/**
 * @consumer/copy-pipeline-plugins
 *
 * <Consumer>-specific Verifier plugins.
 *
 * Usage at consumer startup (apps that run copy-pipeline programmatically):
 *
 *   import { registerVerifier } from "@gmac20191/copy-pipeline";
 *   import { registerAll } from "@consumer/copy-pipeline-plugins";
 *   registerAll(registerVerifier);
 *
 * Or via brand-kit declaration (CLI + MCP server auto-load):
 *
 *   {
 *     "verifiers": {
 *       "plugins": ["@consumer/copy-pipeline-plugins"]
 *     }
 *   }
 */

import type { RegisterVerifierFn, Verifier } from '@gmac20191/copy-pipeline'

import { exampleVerifier } from './example-verifier.js'

export { exampleVerifier } from './example-verifier.js'

/** Every Verifier this plugin pack ships. New verifiers get added here. */
export const consumerVerifiers: readonly Verifier[] = [exampleVerifier] as const

/** Register every verifier in one call. */
export function registerAll(register: RegisterVerifierFn): void {
  for (const v of consumerVerifiers) {
    register(v)
  }
}
