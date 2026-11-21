import { Tokenizer } from '@huggingface/tokenizers'
import type { EncodeText } from './prompt'

/**
 * Plain-text encoder matching the checkpoint's reference tokenizer: request text must never
 * match a special token's string (control tokens are inserted by id), so every special
 * added token is dropped before construction.
 */
export function createEncoder(
  tokenizerJson: Record<string, unknown>,
  tokenizerConfig: Record<string, unknown>,
): EncodeText {
  const json = structuredClone(tokenizerJson) as { added_tokens?: { special?: boolean }[] }
  if (Array.isArray(json.added_tokens)) json.added_tokens = json.added_tokens.filter((t) => !t.special)
  const tokenizer = new Tokenizer(json, tokenizerConfig)
  return (text) => tokenizer.encode(text, { add_special_tokens: false }).ids
}
