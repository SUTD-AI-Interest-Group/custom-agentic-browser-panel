import { Validator } from '@cfworker/json-schema'

self.onmessage = (event: MessageEvent<{ schema: Record<string, unknown>; args: Record<string, unknown> }>) => {
  try {
    const validator = new Validator(event.data.schema)
    self.postMessage({ valid: validator.validate(event.data.args).valid })
  } catch {
    self.postMessage({ valid: false })
  }
}
