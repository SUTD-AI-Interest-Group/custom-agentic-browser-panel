// The math half of Markdown's render path, split into its own chunk so KaTeX
// (~250 kB minified — a third of the side panel's entry bundle when it was
// imported statically) loads only when a message actually needs it. Never import
// this module statically: go through `loadMathEngine` in Markdown.tsx, or a
// dynamic `import()`, or the chunk folds back into the entry.

import { Marked } from 'marked'
import markedKatex from 'marked-katex-extension'
import 'katex/dist/katex.min.css'
import { validateMath } from './mathValidate'

// A private Marked instance rather than `marked.use(...)` on the shared one, so
// the math-free fallback in Markdown.tsx stays genuinely math-free. Options
// beyond the two documented ones pass through to KaTeX. throwOnError:false
// renders malformed LaTeX as an inline error node instead of throwing and
// dropping the whole message.
export const mathMarked = new Marked(markedKatex({ throwOnError: false, output: 'htmlAndMathml' }))

export { validateMath }
