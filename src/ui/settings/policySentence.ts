import type { ToolPolicy } from '../../data/settings'

/**
 * Plain-English state of one tool's gate.
 *
 * Tab visibility and Browsing insights used to *assert* that reads "still ask for
 * permission" — which was simply false whenever that tool's policy was `always`.
 * Rendering the sentence *from* the policy rather than alongside it is the actual
 * fix: the copy cannot drift from the behaviour, because it is the behaviour.
 */
export function policySentence(policy: ToolPolicy, noun: string): string {
  if (policy === 'never') return `${noun} are turned off.`
  if (policy === 'always') return `${noun} run without asking.`
  return `${noun} ask for approval each time.`
}
