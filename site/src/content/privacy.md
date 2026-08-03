# Privacy Policy for Lychee AI

**Last updated: 3 August 2026**
**Applies to: Lychee AI Chrome Extension, version 0.3.0 and later**

Lychee AI is a Chrome side-panel AI assistant. It has **no backend server of its
own**. Everything it stores stays on your computer, and everything it sends goes
directly from your browser to services *you* choose and configure — never to us.
We operate no servers, receive no copy of your data, and run no analytics.

---

## What Data Is Stored, and Where

All of it is stored **locally on your device**. Lychee AI does not use Chrome's
sync storage, so none of this is uploaded to your Google account.

### In extension storage

| Data | Why it exists |
|---|---|
| API keys for the AI providers you add | Authenticates your requests to the model endpoint you chose |
| Provider endpoints, model choices, reasoning-effort settings | Remembers which model to use |
| Your system prompt, tool permissions, and tab-access preference | Applies your configured behaviour and permission rules |
| Connected MCP server addresses and their access tokens | Reconnects to the tool servers you added |
| Whether a model can read images, and when memory was last consolidated | Avoids repeating setup work on every run |

### In the extension's local database

| Data | Why it exists |
|---|---|
| Your conversation history | Lets you reopen past chats |
| Long-term memories, including any personal profile details you save (such as your name, email, or address) | Personalises replies and fills forms when you ask it to |
| Screenshots the assistant captured | Shown in the panel so you can see what the assistant looked at |
| Files you attach to a message (images, PDFs, text files) | Kept so the attachment still displays when you reopen that chat |
| Generated artifacts, tables and cards | Rendered in the conversation |
| Skills you write or import | Reusable instructions you invoke by name |

**You can delete all of it.** Settings contains "Reset memory" for stored
memories, per-conversation deletion for chat history, and removing the extension
from Chrome erases every database listed above. No copy survives elsewhere,
because no copy was ever sent to us.

---

## What Data Leaves Your Device

Lychee AI transmits data only to destinations you have configured or that a
feature you invoked requires. There is no intermediary proxy — requests go
straight from your browser to the destination.

### 1. The AI provider you configure — the main one to understand

When you send a message, Lychee AI calls the model endpoint you set up (for
example OpenAI, Anthropic, OpenRouter, Groq, or a local server such as Ollama or
LM Studio). That request can contain:

- your messages and the conversation so far,
- **the text, structure, and screenshots of web pages you ask it to read or act on**,
- any file you attach to a message — an image, a PDF, or a text file you drag in,
  paste, or pick with the paperclip,
- when you ask about your open tabs, the title, address, and a one-line
  self-description of each tab in that window,
- relevant saved memories,
- results returned by tools it used.

This is the extension's core function: an assistant cannot summarise a page it is
not shown. The page content goes to *your* provider under *your* account and
*their* privacy policy and data-retention terms — please read them. Lychee AI
never sees this traffic.

The assistant reads a page only when you ask it to, and page **control** (clicking,
typing, form filling) requires a separate on-screen approval each session, with an
additional confirmation before irreversible steps such as submitting a form,
navigating to another site, or touching a password or payment field.

### 2. Websites the assistant visits for you

When you ask for research or browsing, Lychee AI requests the pages involved. Those
sites receive an ordinary web request and see whatever a normal visit reveals.
Research browsing is restricted by a built-in policy to reading, navigating, and
site search — it cannot log in, purchase, or submit non-search forms.

### 3. Search and research sources

Only during a search or research task, the query is sent to:

- **DuckDuckGo** (`duckduckgo.com`) — web search — [privacy policy](https://duckduckgo.com/privacy)
- **OpenAlex** (`api.openalex.org`) — academic paper search — [privacy policy](https://openalex.org/privacy-policy)
- **Wikimedia Commons** (`commons.wikimedia.org`) — image search — [privacy policy](https://foundation.wikimedia.org/wiki/Policy:Privacy_policy)
- **Openverse** (`api.openverse.org`) — openly licensed image search — [privacy policy](https://wordpress.org/about/privacy/)

Only your search terms are sent. No identifier of you is attached.

### 4. Link previews (on by default, switchable off)

When a reply contains a link, Lychee AI fetches that page's title and preview
image, which tells the linked site the link was seen. Turn this off in
**Settings → General → link previews**; links then show only a domain and icon.

### 5. MCP servers you connect

If you connect Model Context Protocol servers, tool calls and their arguments go
to those servers. You choose them, and every call is subject to your per-tool
permission setting — including a "never" setting that stops the tool from
existing at all.

### 6. Optional usage tracing — off unless you turn it on

Lychee AI can send conversation traces to **Langfuse** for debugging, using *your
own* Langfuse account and keys. This is **disabled by default**. Nothing is sent,
and no key is stored, unless you explicitly enable it and enter your credentials.
See the [Langfuse privacy policy](https://langfuse.com/privacy).

---

## What We Do Not Do

- We do **not** operate a server that receives your data.
- We do **not** collect analytics, telemetry, crash reports, or usage statistics.
- We do **not** sell or share your data with third parties — we never receive it.
- We do **not** use your data for advertising, profiling, or creditworthiness.
- We do **not** use your data to train any model. (Whether *your chosen provider*
  does is governed by your agreement with them.)
- We do **not** read, transmit, or store page content except when you ask the
  assistant to act on a page.

---

## Permissions and Why They Are Needed

Lychee AI requests access to all websites because you may ask it to help on any
page — the extension cannot know your tabs in advance. This access is used only
when you invoke a feature that needs it.

Access to browsing history, bookmarks, most-visited sites, and downloads is
**optional** and not requested at install. Chrome asks you separately, and only if
you switch those features on in Settings. You can revoke them at any time.

Permission to manage tab groups is **optional** in the same way: Chrome asks for it
the first time you approve a request to sort your tabs into groups, and declining
it leaves every other feature working.

---

## Security

API keys and access tokens are **encrypted at rest**. Every secret Lychee AI
stores — the API keys for the providers you add, the access tokens and header
values for MCP servers you connect, and the tracing keys if you enable that — is
sealed with an encryption key generated on your device, held in a form the browser
will not let any script export, and never sent anywhere. Secrets are unsealed only
in memory, at the moment a request needs them, and transmitted only to the endpoint
they authenticate against, over HTTPS. Because there is no backend, there is no
server-side database of user credentials to breach.

Two honest limits on what that protects against. It secures the stored values
against anything that reads your profile's files, but it is not a substitute for
locking your computer — someone using your unlocked Chrome profile can still open
the extension, which unseals your keys normally. And if the browser ever makes that
encryption unavailable, Lychee AI keeps your keys working rather than locking you
out of your own credentials, storing them unsealed until it recovers; Settings
shows the current state either way, so this never happens silently.

Code that the assistant generates and runs on your behalf executes inside a
sealed interpreter with no network access and no access to your browser, your
tabs, or your data.

---

## Children

Lychee AI is not directed at children under 13 and does not knowingly collect
data from them.

---

## Changes to This Policy

If data practices change, this policy will be updated with a new "Last updated"
date and published at the same address before the change ships in a release. The
version history is public in the project repository.

---

## Contact

Questions about privacy, or a request about your data:

- **Email:** ai@sso.sutd.edu.sg
- **Issues:** https://github.com/SUTD-AI-Interest-Group/custom-agentic-browser-panel/issues
