// Bundled by lib.mjs (esbuild, node/esm) so the labeling and rendering stages
// call the SHIPPED candidate-action builders — never a Python or .mjs
// re-implementation of them. A row rendered here is byte-identical to the
// DecideRequest createVonPolicy sends Von for that state.
import type { IndexedElement } from '../../src/platform/domIndex'
import { buildControl, renderControl as renderControlImpl } from './prompt-shim'

export { buildObservation, buildControl, clip, opFor } from '../../src/system1/observation'
export { buildCandidateSpace, isElementOperation, isFieldOperation, SHOWN_CONTROLS } from '../../src/system1/candidates'
export {
  blockedQuestion, operationQuestion, renderControl, renderState, targetChunks, targetQuestion, valueQuestion, TARGET_CHUNK,
} from '../../src/system1/vonPolicy'
export { packPrompt } from '../../src/system1/von'

/** What the teachers see per element (label.mjs): the shipped control line. */
export const describe = (el: IndexedElement): string => renderControlImpl(buildControl(el, undefined))
