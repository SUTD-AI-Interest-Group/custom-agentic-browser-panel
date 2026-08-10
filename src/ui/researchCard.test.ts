import { expect, test } from 'vitest'
import { researchCardState } from './researchCard'
import type { ResearchProposal, ResearchTask } from '../data/researchTasks'

const proposal: ResearchProposal = {
  taskId: 'r-1', question: 'q', subQuestions: [], sites: [], draftedAt: 1,
}
const task = (status: ResearchTask['status']): ResearchTask =>
  ({ id: 'r-1', question: 'q', status, steps: [], startedAt: 1, updatedAt: 2 })

test('a proposal with no task is proposed', () => {
  expect(researchCardState(proposal, undefined)).toBe('proposed')
})

test('a task always wins over the proposal at the same id', () => {
  expect(researchCardState(proposal, task('running'))).toBe('running')
  expect(researchCardState(proposal, task('done'))).toBe('done')
})

test('paused reads as running — it is still the agent working', () => {
  expect(researchCardState(proposal, task('paused'))).toBe('running')
})

test('error and cancelled keep their own terminal states', () => {
  expect(researchCardState(undefined, task('error'))).toBe('error')
  expect(researchCardState(undefined, task('cancelled'))).toBe('cancelled')
})

test('neither present is proposed, so a card never renders blank', () => {
  expect(researchCardState(undefined, undefined)).toBe('proposed')
})
