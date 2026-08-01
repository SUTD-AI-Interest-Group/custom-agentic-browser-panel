// Whether an assistant text part needs the silent LaTeX self-repair pass
// (repairAssistantMath, Chat.tsx). Extracted so the detection rule is
// unit-testable on its own.

import { normalizeMathDelimiters } from './mathDelimiters'
import { validateMath } from './mathValidate'

/**
 * Whether `text` contains math the deterministic renderer can't compile.
 *
 * validateMath's scan only recognizes `$…$`/`$$…$$` — it is structurally blind
 * to `\(…\)`/`\[…\]`, the style OpenAI-family models emit (mathDelimiters.ts's
 * own header comment). Normalizing first makes this recognize both delimiter
 * styles, matching what Markdown.tsx's render path already sees (it normalizes
 * before validating too) — without this, repairAssistantMath's filter never
 * even attempted a repair call for that entire class of model, even though the
 * render path correctly fell back to inert code for the same broken math.
 *
 * Detection only: the fix itself must still be spliced back into the RAW,
 * un-normalized text (mathRepair.ts's own concern), so this never changes what
 * gets stored — only whether a repair attempt is triggered at all.
 */
export function hasUncompilableMath(text: string): boolean {
  return validateMath(normalizeMathDelimiters(text)).invalid.length > 0
}
