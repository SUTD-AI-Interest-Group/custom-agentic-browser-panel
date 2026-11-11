# ChatGPT plan provider for Lychee AI

Lychee is a Chrome extension. OpenAI's current public-client sign-in flow requires an HTTP callback on `127.0.0.1` and credentials in a protected local runtime, rather than browser storage. This small Node.js native messaging companion provides that runtime. It is separate from the extension ZIP and must be installed once on each user's computer/browser.

## Install (macOS and Linux)

1. Install Node.js 22 or later. Build/load the Lychee extension normally, or use its distributed extension build.
2. Keep the Lychee source checkout in a permanent location. From that folder run:

   ```sh
   npm ci --prefix companion/chatgpt
   node companion/chatgpt/install.mjs YOUR_EXTENSION_ID
   ```

   Find the 32-letter extension ID in `chrome://extensions` with Developer mode enabled. The provider card also shows a command with the current extension ID. For Edge, Brave, or Chromium, append `edge`, `brave`, or `chromium` to the install command. If the extension ID, checkout location, or Node executable changes, rerun the installer.
3. Reload Lychee, choose **ChatGPT plan** during onboarding or add it in **Settings → Providers**, then select **Continue with ChatGPT**. Allow the browser's optional native messaging permission.
4. Complete OpenAI sign-in, select the account/workspace and grant ChatGPT plan usage. Model choices come from that account's catalog. Select one in the chat model picker; **Manage usage** opens ChatGPT usage settings.

The companion currently supports macOS and Linux. Windows needs a packaged native executable/installer and is not supported by this installer. No local companion is needed for existing API-key providers.

## Privacy and behavior

**Current versus proposed hosting:** This build uses the local companion and does not send ChatGPT-provider data to Supabase. A hosted Supabase connection is proposed but is not enabled. That architecture would add a Lychee-operated backend and Supabase to the data path: request content, included browser context/attachments/tool results, responses, account identifiers and OAuth credentials would be processed server-side. Hosted credential protection, logging, retention, backups and deletion behavior are not implemented or verified. Creating a project does not enable the connection. The in-app privacy label distinguishes this proposal from the current local behavior and must be revised against the deployed implementation before hosted sign-in is offered.

- `app.lychee.chatgpt` is registered only for the extension ID supplied at installation. It has no general HTTP proxy/listening port. A temporary loopback listener exists only during sign-in. Native messages allow only status, sign-in, sign-out, model discovery, and Responses requests.
- OpenAI credentials never enter extension JavaScript, Chrome storage, exported settings, or content scripts. The companion saves them under `~/.config/lychee-ai/chatgpt/`, with directory mode `0700` and atomic credential-file writes using mode `0600`. These are protected local files, not OS-keychain encryption. Keep this folder out of backups or sharing if you do not want credentials copied.
- Each provider UUID identifies a separate account registration. The installation host ID is shared across registrations. Reauthorization preserves client ID and account identity; add another ChatGPT provider to connect another account/workspace.
- OAuth uses fresh state, nonce and PKCE S256, validates ID-token signature/issuer/audience/expiry/nonce and returning subject, checks the granted plan-usage scope, and saves the issued client ID before exchanging the code. Rotating token refresh is serialized across native processes using a heartbeat file lock.
- Model discovery uses the public account-specific `/v1/models` catalog. Inference is pinned to `https://api.openai.com/v1/responses`, with `store: false` and `stream: true`. API-key settings or user-edited endpoints cannot reroute the credential. No ChatGPT `backend-api` endpoints are used.
- Normal chat streams reach the UI incrementally. Calls made through `generateText` (titles, probes, summaries, etc.) are streamed upstream and returned to the SDK only after `response.completed`. Failed, incomplete, and truncated streams fail instead of appearing successful.
- Sign out attempts remote refresh-token revocation and clears local tokens, retaining registration and identity for reauthorization. If remote revocation is unconfirmed, the UI says so and links to ChatGPT settings. Removing a provider also attempts sign-out. Local chats are not deleted. Already submitted requests may finish; sign-out does not undo usage already incurred.
- Lychee sends the same prompt/context/tool data as it does to other providers. Background features using this provider also consume plan usage. The privacy modal explains browser context, attachments, memory, usage/account linkage, local storage, optional Langfuse tracing and MCP destinations. `store: false` is not a zero-retention or no-training guarantee.
- Disconnecting the native port cancels its operation. Closing the side panel does not cancel separately running offscreen research.

To uninstall, remove `app.lychee.chatgpt.json` from your browser's `NativeMessagingHosts` directory (the paths are listed in `install.mjs`). Sign out first, then delete `~/.config/lychee-ai/chatgpt/` if you want to remove retained registrations. Removing only the extension does not remove companion files or revoke remote grants; use [ChatGPT settings](https://chatgpt.com/settings/usage) to disconnect the app.

## Validation

```sh
npm test --prefix companion/chatgpt
npm test
npm run build
```

Automated checks cover OAuth callback/identity failures, scope gating, token rotation records, native transport cancellation/errors, catalog filtering and incomplete streams. Live acceptance still requires an eligible account and installed companion: new registration, denied consent, returning sign-in, refresh after expiry, model discovery, a completed tool-using chat, a model-test/title request, usage limits, sign-out and remote revocation. Automated mocks do not establish account eligibility or successful plan billing.

## Official integration references

Verified against the published documentation on 11 October 2026:

- [Cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines)

Availability and plan eligibility are controlled by OpenAI. Before commercial or remotely hosted distribution, review the current availability requirements in those guides.
