# Deployment verification — 2026-10-14

Scope: reconciled MCP/WebMCP branch based on 751c574. Browser-native architecture retained. ChatGPT provider work in the primary checkout is excluded and its working-tree status was unchanged.

## Result

Automated checks pass after dependency remediation. This is not yet a production release sign-off. No store upload or production deployment was performed.

## Security remediation

Initial npm audit: 21 affected dependency entries (1 critical, 11 high, 7 moderate, 2 low). Final npm audit: zero reported vulnerabilities, including development dependencies. This is advisory coverage, not proof of absence of vulnerabilities.

Updated MCP SDK to 1.32.1 (issuer-bound OAuth credentials), Office parser to 8.1.1, PDF.js to 6.4.299, KaTeX to 0.18.10, and compatible transitive patches in the lockfile. The CIMD integration assertion now verifies the SDK's issuer stamp. KaTeX stays within the marked extension's supported peer range. Clean npm ci and npm ls both succeed.

## Executed checks

- Clean lockfile installation: pass.
- Full Vitest suite: 2,014 tests across 150 files pass.
- TypeScript and both production Vite builds: pass.
- Production packaging: pass; 91 entries, 6,192,992 bytes.
- ZIP CRC integrity, root MV3 manifest, excluded source maps/source directories/.env files, no remote HTML script entrypoints, no nativeMessaging permission: pass. This filename check is not a comprehensive secret scan.
- Real browser local HTTP fixture under strict CSP without unsafe-eval: modern/legacy negotiation, tool calls and legacy schema validation, subscription acknowledgements and URI-only notices, explicit insufficient-scope authorization, OAuth discovery/DCR/PKCE/issuer callback/token exchange all pass.
- Upgraded Office slim parser: actual generated DOCX text extraction passes. KaTeX math rendering and rejection of a javascript link with trust disabled pass.
- Primary checkout status matches the pre-task snapshot; ChatGPT files untouched.

Artifact: lychee-ai-v0.4.0.zip (ignored build output in this worktree).
SHA-256: 8422c3d0e63ea51c2eee8f80353311d2803573e6df68ddaa31c9d4f9a5678977

## Remaining release gates

1. Bump and synchronize release versions before store upload: this artifact is still 0.4.0, the existing live version. Rebuild and record the new checksum after the bump.
2. Load the packaged extension in a clean Chrome profile and verify actual chrome.identity login, refresh, sign-out and service-worker/panel lifecycle against a production MCP server. The browser fixture simulates Chrome storage/identity; no real account was used.
3. Run the installed extension's model/tool/approval workflow using the configured local LM Studio model. The endpoint was reachable, but an installed-extension model turn was not executed in this run.
4. Verify real PDF/Office attachment rendering in the installed extension after dependency upgrades; unit/build and DOCX parser smoke checks are not visual rendering verification.
5. Verify hosted CIMD metadata before enabling a metadata URL. Static metadata remains opt-in.

Vite reports large chunks (including lazy Office parsing). Builds succeed; startup/memory performance on minimum-supported Chrome has not been measured. Existing broad host permissions and wasm-unsafe-eval remain; no middleware server was introduced.
