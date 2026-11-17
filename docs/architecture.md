# EDITH OS workspace architecture

The Express process renders two HTML shells and injects one shared Windows file panel. Browser modules and styles are served as static assets. The repository has no frontend build step. The workspace uses real path navigation with the History API and restores the current view on Back, Forward and reload.

| Entry | Owner and behavior |
| --- | --- |
| `/`, `/app` | Root redirects to the workspace by default. Home shows the console, composer, connection status and current visit activity. |
| `/app/voice`, `/app/conversations` | A persistent client session owns audio and the socket while navigating. Conversation text is bounded to 80 turns in page memory and can be cleared in Settings. |
| `/app/files`, `/app/devices`, `/app/permissions` | Capability information comes from the server. Local filename operations reuse the allowlist, path validation, policy engine, session references and audit. Unpaired hosted devices have no file controls. |
| `/app/integrations`, `/app/skills`, `/app/calendar` | Display available providers, file capability and calendar connection status. The sample calendar is a separate explicit demo. |
| `/app/activity`, `/app/settings`, `/app/help` | Show up to 60 observed events, tab-scoped captions and privacy controls, or keyboard and setup guidance. |
| `/app/tasks`, `/app/automations`, `/app/knowledge`, `/app/memory`, `/app/notifications` | First-release availability views. No fabricated records. Unknown record links display an unavailable state. |
| `/demo` | Original Front Desk voice, review-before-save calendar and local file interface. |

## Runtime boundaries

`views/workspace.html` and `public/workspace.css` define the shell. The route metadata and navigation icons live in `public/workspace-nav.js`. `public/workspace.js` binds real capability and session events to each view. `public/workspace-session.js` owns the WebSocket, audio graph, captured media tracks, interruption and teardown. Screenshots and checks live under `docs/screenshots` and `checks`.

The browser bootstraps an expiring HttpOnly session with `GET /api/state`. All three realtime routes require the matching origin and a valid session. A session has one active socket. The existing `/api/voice` serves the classic product. The workspace uses `/api/assistant/voice` for PCM microphone input and `/api/assistant/text` for bounded typed messages. Typed mode requests no microphone and receives captions. It stays on the existing Gemini Live connection for follow-up questions. Typed sessions advertise no tools. Local workspace voice uses the existing file registry and policy. The hosted workspace exposes no tools to the model. Workspace sessions exclude demo booking tools. Tool requests are checked against the declarations actually offered to that connection.

Provider secrets, OS roots and the private index remain under server control. Cloud output filtering still applies to model tool responses. User speech or typed prompts sent to Gemini are transmitted to that provider. This release does not implement personal accounts, remote PC pairing or durable multiuser history. Activity in the browser is a local session timeline. The server's security audit has its existing redaction and access boundaries.

## Configuration and rollback

Server configuration names include `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`, `GEMINI_VOICE`, `VOICE_MAX_MINUTES`, `PORT`, `NODE_ENV`, `BUSINESS_CONFIG`, `CALENDAR_FILE`, `FILE_TOOLS_CONFIG`, `EDITH_SECURITY_CONFIG` and `EDITH_INDEX_CONFIG`. Render supplies `RENDER` and `RENDER_EXTERNAL_URL`. The local provider double in tests uses `GOOGLE_GEMINI_BASE_URL`. No key values belong in these documents.

Set `EDITH_UI=classic` and restart the process to restore the original root experience. Both explicit product URLs remain available. This release requires no calendar or index data migration. For a complete rollback, redeploy the previous commit and preserve the existing environment variables.
