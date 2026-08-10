import type { ResearchProposal, ResearchTask } from '../data/researchTasks'

/** The five faces of one transcript slot: launch card → live card → result row. */
export type ResearchCardState = 'proposed' | 'running' | 'done' | 'error' | 'cancelled'

/**
 * Which face to render. The task always wins where both exist: the proposal is
 * the pre-launch draft, and once a task carries the same id the draft is spent.
 * `paused` folds into `running` because a retry backoff is still the agent
 * working — the pause reason shows inside the live card, not as its own state.
 */
export function researchCardState(
  proposal: ResearchProposal | undefined,
  task: ResearchTask | undefined,
): ResearchCardState {
  if (!task) return 'proposed'
  switch (task.status) {
    case 'running':
    case 'paused':
      return 'running'
    case 'done':
      return 'done'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'cancelled'
  }
}
