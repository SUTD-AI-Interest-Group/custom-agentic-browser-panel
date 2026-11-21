// The decision request, mirroring strands_decider/core/request.py (System One request).

export type Content = string | Record<string, unknown> | unknown[]

export type DecisionQuestion =
  | { type: 'choice'; instructions: Content; criteria: Record<string, Content | null> }
  | { type: 'noul'; instructions: Content; criteria?: Partial<Record<'true' | 'false', Content | null>> }
  | { type: 'score'; instructions: Content; criteria: string[] }

export interface DecisionRequest {
  state: Content
  questions: Record<string, DecisionQuestion>
}
