<div align="center">

# Front Desk

### Find your files. Book your time. Just start talking.

Edith is a local voice assistant that finds and opens files from allowed Windows folders and helps book appointments with a final review before saving.

![Gemini Live](https://img.shields.io/badge/AI-Gemini_Live-4285F4?style=flat-square)
![Node.js](https://img.shields.io/badge/Node.js-20.11%2B-339933?style=flat-square)
![JavaScript](https://img.shields.io/badge/JavaScript-ES_Modules-F7DF1E?style=flat-square)
![WebSocket](https://img.shields.io/badge/Audio-WebSocket_%2B_Web_Audio-52734E?style=flat-square)

[Quick start](#quick-start) · [Screenshots](#screenshots) · [Tech stack](#tech-stack) · [Configuration](#configuration) · [Tests](#tests)

</div>

![Front Desk desktop interface with voice concierge and available appointment times](docs/screenshots/desktop.png)

## What it does

- **Local file assistant:** fuzzy filename search in Downloads, latest-first sorting, and Open / Show in folder actions by voice or click. File contents are never read or sent to Gemini.

Front Desk turns a booking request into a natural conversation. Tell the AI which service you want and when you are free. It checks real availability in the included demo calendar and prepares an appointment for you to review.

- **Live voice conversation:** streaming microphone input, spoken replies, and captions using Google Gemini Live.
- **Interrupt and change your mind:** stop scheduled assistant playback when you speak; change dates, services, or preferences during the conversation.
- **Calendar tools:** non-blocking function calls check available times and prepare booking details on the server.
- **Confirm before saving:** review the service, date, time, name, and price, then press **Confirm booking**. Voice statements alone do not save a booking.
- **Visible appointments:** browse open slots and see confirmed bookings in the UI, with server-side conflict checks.
- **A ready-to-try demo:** Edith includes services and a sample calendar. Manual booking works without an API key.
- **Configurable businesses:** switch branding, services, prices, currency, timezone, hours, and booking rules through JSON.
- **Session controls:** microphone permission handling, mute/unmute, interruption cleanup, and upstream session shutdown.

## Screenshots

These are actual application screenshots captured with fictional demo data. They do not represent a recorded AI conversation.

### Review before saving

![Appointment review card showing service, date, name, price and a confirmation button](docs/screenshots/review.png)

### Confirmed appointment

![Saved appointment in the demo calendar](docs/screenshots/confirmed.png)

<details>
<summary>View the mobile layout</summary>
<br>
<img src="docs/screenshots/mobile.png" alt="Front Desk responsive mobile interface" width="390">
</details>

Regenerate the screenshots with `npm run screenshots`. This uses an isolated in-memory calendar and makes no voice API calls.

## Tech stack

| Layer | Technology | Role |
| --- | --- | --- |
| Voice AI | Google Gemini Live, `@google/genai` | Streaming audio, transcripts, interruptions, and non-blocking function calling |
| Server | Node.js, Express | Application routes, credential handling, configuration, and booking validation |
| Transport | `ws`, browser WebSocket | Server-proxied voice stream; the API key never reaches the browser |
| Browser | HTML, CSS, JavaScript ES modules | Responsive interface, availability, review cards, and appointments |
| Audio | AudioWorklet, Web Audio API | Mono PCM16 capture at 16 kHz, resampling, playback scheduling, and interruption cleanup |
| UI updates | Server-Sent Events | Calendar availability, draft, and booking updates |
| Storage | Local JSON with atomic file replacement | Persistent demo bookings and conflict checks in one server process |
| File tools | Fuse.js, Node.js `fs.watch`, Ajv, JSONC | Fuzzy filename index, change monitoring, validated tool calls and commented folder config |
| Settings | JSON, dotenv, `Intl` | Business configuration, environment settings, currency, timezone and date formatting |
| Tests | Node.js test runner, Playwright | Calendar, audio, browser, alternate-business, and simulated voice verification |

## Quick start

### 1. Install

Use Node.js **20.11 or later** and npm.

```bash
git clone https://github.com/Durga697/NewAgent.git
cd NewAgent
npm ci
```

### 2. Configure voice access

Copy `.env.example` to `.env.local` and set your own `GEMINI_API_KEY` in that local file. Get a key from [Google AI Studio](https://aistudio.google.com/apikey). The selected project must have access to the configured Live model and sufficient quota.

On PowerShell:

```powershell
Copy-Item .env.example .env.local
```

On macOS/Linux:

```bash
cp .env.example .env.local
```

In local development, `.env.local` takes precedence over inherited shell settings; restart the server after changing it. Production and test processes (`NODE_ENV=production` or `test`) skip `.env.local` and keep their explicitly supplied environment values. `.env` supplies remaining defaults. Environment files are ignored by Git. The included `.env.example` has no credential. You can skip voice configuration and still try the manual demo calendar.

### 3. Start

```bash
npm start
```

Open [http://localhost:3000](http://localhost:3000). Press **Start a conversation**, allow microphone access, and tell the concierge what you would like to book. Voice API usage starts only when a conversation is started; provider charges and limits apply.

Try: “I'd like a haircut tomorrow afternoon.” Then change your preference: “Actually, make that the morning.” Review the final card and press **Confirm booking**. Use **Finish conversation** when done.

Microphone capture requires localhost or HTTPS. Finish stops microphone capture and playback and closes the browser and Gemini connections. Leaving the page also requests cleanup.

## How the AI flow works

```mermaid
flowchart LR
    U[Browser microphone and UI] <-->|PCM audio and events| S[Node.js WebSocket proxy]
    S <-->|Server-side API key| G[Gemini Live]
    G -->|Non-blocking function call| T[Calendar tools]
    T -->|Availability or draft| G
    T -->|SSE updates| U
    U -->|User presses Confirm booking| B[Validate and save booking]
    B --> C[(Local demo calendar)]
    B -->|Confirmed appointment| U
```

The browser sends mono PCM16 audio in 32 ms frames. The server connects to Gemini and owns tool execution. Audio returns to the browser for scheduled playback; an interruption discards queued output. Canceled tool calls are ignored. A review card is invalidated when spoken preferences change, and confirmation rechecks availability before writing a booking.

The current implementation uses **Gemini Live**, with `gemini-3.8-live` as its configured default. It does not require OpenAI credentials or external calendar integrations.

## Configuration

Edit [`config/business.json`](config/business.json) and restart. The UI, calendar engine, voice prompts, and tool service IDs all use this shared configuration.

| Setting | What it changes |
| --- | --- |
| `name`, `tagline`, `address` | Business identity shown in the UI and used by the AI |
| `voiceStyle` | Accent, language, pacing and clarification guidance for the AI |
| `timezone`, `locale`, `currency` | IANA timezone, date/time display, and price formatting |
| `services` | Unique service IDs, names, durations, prices, and descriptions |
| `calendar.opensAt`, `calendar.closesAt` | Local opening hours in `HH:mm` format |
| `calendar.slotMinutes` | Available start-time interval |
| `calendar.bookingWindowDays` | How far ahead users can book |
| `calendar.openWeekdays` | Open days; Sunday = `0`, Saturday = `6` |
| `calendar.blockedTimes` | Recurring unavailable periods; use `[]` for none |

Configuration is validated at startup. Daylight-saving gaps are omitted; repeated local times use their first occurrence. Overnight opening hours are not supported.

An alternate [Harbour Clinic configuration](config/examples/clinic.json) demonstrates different branding, services, GBP prices, London time, and weekday hours.

### Server environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `GEMINI_API_KEY` | Unset | Private server credential for voice |
| `GEMINI_LIVE_MODEL` | `gemini-3.8-live` | Gemini Live model; availability depends on your project |
| `GEMINI_VOICE` | `Kore` | Assistant voice |
| `VOICE_MAX_MINUTES` | `10` | Per-conversation duration limit |
| `PORT` | `3000` | Local server port |
| `BUSINESS_CONFIG` | `config/business.json` | Business JSON file |
| `CALENDAR_FILE` | `data/bookings.json` | Booking storage; `:memory:` disables persistence |

For a different business, set `BUSINESS_CONFIG=config/examples/clinic.json` and choose a separate `CALENDAR_FILE`. Changing the timezone or schedule does not migrate existing appointments. New bookings retain their confirmed business name, currency, and timezone.

## Tests

```bash
npm test
npm run test:browser
npm run test:voice
npm run test:config
```

The browser checks use installed Microsoft Edge in headless mode. Screenshot capture also supports `BROWSER_CHANNEL` if another installed Playwright browser channel is preferred.

| Command | Coverage |
| --- | --- |
| `npm test` | Calendar validation and conflicts, confirmation behavior, configuration, DST conversion, and PCM resampling at 44.1/48 kHz |
| `npm run test:browser` | Review/confirm flow, stale and repeated submissions, origin checks, microphone denial recovery, and mobile overflow |
| `npm run test:voice` | Actual Gemini SDK and browser audio code against a local provider double: tools, PCM capture, captions, playback, interruption, cancellation, mute, and shutdown |
| `npm run test:config` | Alternate clinic configuration rendered in the browser |

Voice checks use a local test double and make no paid API calls. They do not establish that a real credential, microphone, model access, or quota will work in every environment.

## Project structure

```text
config/                  Business configuration and an alternate clinic example
public/                  Browser UI, styles, audio capture, and playback
checks/                  Browser, simulated voice, config, and screenshot checks
test/                    Calendar, configuration, date, and audio unit tests
docs/screenshots/        Real screenshots used in this README
server.mjs               HTTP routes, SSE, Gemini connection, and tool execution
calendar.mjs             Availability, drafts, confirmation, and local persistence
config.mjs               Startup validation and server settings
dates.mjs                Business-date arithmetic and timezone conversion
.env.example             Credential-free environment template
```

## Demo scope

This is a single-process local demo bound to loopback. Bookings persist in `data/bookings.json`, and each browser sees appointments created in its current server session. Environment files, local booking data, dependencies, and logs are excluded from Git.

For public deployment, add authentication, HTTPS-aware origin checks, rate and cost controls, session expiry, and a transactional database. Provider GoAway events or connection expiry end the current demo voice session; start a new conversation to continue.

## API references

- [Google Gemini Live model](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-live)
- [Live API function calling](https://ai.google.dev/gemini-api/docs/live-api/tools)
- [Live WebSocket reference](https://ai.google.dev/api/live)
- [Audio streaming and interruptions](https://ai.google.dev/gemini-api/docs/live-api/best-practices)

Edith uses configurable Indian English voice guidance, including clarification of names, dates and times. Accent is requested through system instructions; the generated accent can vary between sessions. Native Live audio does not require a forced language-code setting.

## Local computer tools (Windows v1)

The existing Node server now owns a separate `tools/` layer. The Gemini connection uses declarations generated by `ToolRegistry`, which validates every call with Ajv and writes a local audit record. The booking tools still work alongside normal conversation.

### Run and try each stage

```bash
npm ci
npm test                 # Guards, ranking, filters, IDs, consent and existing calendar/audio tests
npm run test:files       # End-to-end file voice/UI flow against a local Gemini test double
npm run test:voice       # Existing voice + booking regression check
npm run test:browser     # Existing booking browser flow
npm run test:config      # Alternate-business regression check
npm start               # Live assistant at http://localhost:3000
```

The integration check creates fictional files in a temporary folder. A **test-only Node preload** intercepts `explorer.exe`; no actual document app opens, no personal files are searched, and no paid AI requests are made. Production never imports that preload. The normal live assistant uses the real Windows adapter.

At startup, Edith builds a metadata-only index in the background and watches changes with Node’s recursive filesystem watcher. The UI reports indexing progress; searches during the initial scan return an incomplete-results warning. Normal conversation and bookings can start while indexing continues. The **Find a local file** panel also works without an AI key. Gemini voice requires your existing valid server credential.

Example voice commands:

- “Edith, what folders can you access?”
- “Find my latest electricity bill in Downloads.”
- “Find electricity bills as PDFs modified after the first of February.”
- “Open the second one.”
- “Show the first one in its folder.”

One match: Edith asks “Open filename?” unless you already asked to open it. Multiple matches: she reads the top two or three, displays the ordered list, and waits. No match: try broader words, another file type, or another **allowed** folder. This is filename search; “find a document about college admission” only matches those words in its filename, not its contents.

### Configure the folder allowlist

Edit [`config/file-tools.jsonc`](config/file-tools.jsonc) and restart. JSON comments are supported. The default is **Downloads only**, under `${home}` for the Windows account running the server. Documents and Desktop are commented-out opt-ins; uncomment a root to authorize it. If Windows has moved Downloads elsewhere, explicitly set its physical local path in this config.

```jsonc
"roots": [
  { "id": "Downloads", "path": "${home}/Downloads" }
  // , { "id": "Documents", "path": "${home}/Documents" }
  // , { "id": "Desktop", "path": "${home}/Desktop" }
]
```

Use `FILE_TOOLS_CONFIG` to choose a different config file. Do not add whole drives just to work around a missing-folder error. The UI reports missing or inaccessible roots; correct the path or Windows permissions and restart.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Enable or disable local file tools |
| `roots` | Downloads only | Unique folder aliases and absolute paths; `${home}` expands locally |
| `blockedExtensions` | Script, executable, shortcut and active-document types | Case-insensitive deny list for both open and reveal; remove entries only if you deliberately trust those file types |
| `maxDepth` | `8` | Maximum folder recursion depth |
| `maxFiles` | `20000` | Maximum indexed filenames; incomplete results are reported |
| `resultTtlSeconds` | `600` | Search-result ID lifetime |
| `maxResults` | `50` | Maximum results returned by one search |
| `maxStoredResults` | `200` | Maximum retained IDs per browser session |
| `auditFile` | `data/tool-audit.jsonl` | Local append-only tool audit log; tool execution fails closed if logging fails |

Test processes disable the real allowlist unless an explicit `FILE_TOOLS_CONFIG` is supplied. Do not commit a machine-specific private config, audit log, or file-result screenshot containing personal filenames. Keep local logs under ignored `data/`.

### Tool interface

| Tool | Input | Result |
| --- | --- | --- |
| `list_allowed_folders` | `{}` | Root aliases/paths, availability and index status |
| `search_files` | `{ query, folder?, extensions?, modifiedAfter?, modifiedBefore?, sortBy?, limit? }` | Ordered metadata and opaque result IDs |
| `open_file` | `{ resultId }` | Confirmation request, refusal, or handoff to the default Windows app |
| `reveal_in_folder` | `{ resultId }` | Confirmation request, refusal, or Explorer selection |

`folder` accepts an allowed alias or a validated subfolder path. `query` is filename words, not a path; typos and reordered words are supported. `extensions` accepts values such as `pdf` or `.pdf`. Dates use `YYYY-MM-DD` (UTC day boundaries, with an inclusive end date) or ISO timestamps with a timezone. Sorts are `modifiedDesc` (default/latest), `modifiedAsc`, `relevance` and `name`. Results contain filename, full path, folder, byte size, modified date, ordinal, expiry and stable session-scoped ID. Contents are never included.

### Security model

- Only root-allowlisted local paths are indexed or acted on. Directory traversal, UNC/network shares, Windows device paths/names, alternate data streams, and ambiguous trailing dots/spaces are rejected.
- Paths are normalized with Windows case-insensitive containment checks and canonicalized to handle 8.3 aliases. Symlinks and junctions are rejected rather than followed, including replacements made after a search.
- Open/reveal accepts **only** an opaque ID issued to the same browser session. The server rechecks real path, file type and identity immediately before handing the request to Windows. Removed, changed, expired, cross-session and blocked results fail.
- Executables, scripts, shortcuts, active document types and extensionless files are blocked by default. The browser/model cannot provide shell commands. The Windows adapter uses `spawn` argument arrays with `shell: false`.
- Voice actions require a recent explicit open/show request, a matching ordinal/filename, or confirmation of a pending file action. Ambiguity returns `confirmation_required`. A UI Open / Show in folder click is itself authorization for that displayed result. Voice authorization is consumed after a successful launch.
- The server still binds to `127.0.0.1`. HTTP mutations and WebSocket upgrades check the origin; host checks reject DNS-rebinding hosts. The session cookie scopes file results. File metadata obtained through a voice tool call (filenames, paths, sizes and dates) is shared with Gemini; file contents are not. Clicking search while voice is active supplies that displayed metadata to the conversation so “the second one” refers to the visible list.
- Every registry tool call, including refusals and calendar calls, is logged with timestamp, tool, args, result count and outcome. Logs stay local and can contain private filenames/paths. Open/reveal does not delete, move, rename or write documents. Existing calendar booking writes and audit-log writes are separate application features.

### Known limitations and extension points

- Windows-first. Search can run on other OSes, but the default open/reveal adapter refuses there. The panel records that Windows received a request; it cannot prove a third-party application displayed the document.
- Recursion and file-count caps may make large folders incomplete. Watcher errors and missing roots are reported. Restart after changing roots or their availability. Recently rewritten files may require a repeated search while watcher metadata catches up.
- Guards reject symlink/junction roots too. Use an explicitly authorized physical folder for redirected Windows folders. Network shares are deliberately unsupported in v1.
- File checks and shell handoff cannot be made atomic across third-party applications. Use user-owned folders, not adversarial shared writable directories. The opened app's own file handlers and behavior are outside Edith's control.
- There is no content search, delete, move, rename, clipboard access, volume control, arbitrary application launching, or Electron packaging.
- Each tool has its own module. `ToolRegistry` generates Gemini declarations from the same schemas used for server validation. `FileIndex` exposes `start`, `search`, `folders` and `close`; a future index provider can implement that interface and return the same metadata records. A content provider would need a separate explicit privacy design; it is not enabled by this v1. The result serializer deliberately returns metadata fields only.
