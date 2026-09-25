/// <reference types="vite/client" />

// No file declared this before: env vars are otherwise unused in this codebase
// (`import.meta.url` call sites bring their own `/// <reference types="vite/client" />`,
// which is enough for that alone). `VITE_SYSTEM1_PIN` is the first one that needs
// typed `import.meta.env` access — see src/system1/weightsManifest.ts for why it
// exists. Augments vite/client's own `ImportMetaEnv` via declaration merging.
interface ImportMetaEnv {
  readonly VITE_SYSTEM1_PIN?: string
}
