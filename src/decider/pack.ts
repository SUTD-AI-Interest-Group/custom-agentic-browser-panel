// Packs the shared state and N questions into one forward pass: every question attends to the
// state (segment 0) and to itself (its own segment), at positions continuing from the state.

export interface PackedPass {
  ids: number[]
  positions: number[]
  /** 0 for the state, 1..N for each question. */
  segments: number[]
  /** Index of each question's last token in `ids`. */
  gather: number[]
}

export function packPass(stateIds: number[], questionIds: number[][]): PackedPass {
  const ids = [...stateIds]
  const positions = stateIds.map((_, i) => i)
  const segments = stateIds.map(() => 0)
  const gather: number[] = []
  questionIds.forEach((q, qi) => {
    q.forEach((id, i) => {
      ids.push(id)
      positions.push(stateIds.length + i)
      segments.push(qi + 1)
    })
    gather.push(ids.length - 1)
  })
  return { ids, positions, segments, gather }
}
