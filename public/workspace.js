import "./files.js";
import { setCsrfToken } from "./security.js";
import { pages, link, icon } from "./workspace-nav.js";
import { createSession } from "./workspace-session.js";

const $ = (id) => document.getElementById(id);
const element = (tag, value, cls) => {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (cls) node.className = cls;
  return node;
};
document
  .querySelectorAll("[data-icon]")
  .forEach((node) => node.replaceWith(icon(node.dataset.icon)));
let group,
  current,
  snapshot,
  eventStream,
  loadError = "",
  partial,
  captions = true;
let phase = "idle",
  mode,
  micMuted = false,
  pendingReview,
  reviewTimer;
const activity = [],
  turns = [];
for (const [id, label, glyph, section] of pages) {
  if (group !== section) {
    $("side-nav").append(element("p", section, "nav-group"));
    group = section;
  }
  $("side-nav").append(link(id, label, glyph));
}
for (const id of ["home", "voice", "tasks", "files"]) {
  const [, label, glyph] = pages.find((p) => p[0] === id);
  $("mobile-nav").append(
    link(
      id,
      id === "tasks" ? "Tasks" : id === "voice" ? "Voice" : label,
      glyph,
    ),
  );
}
const more = element("button");
more.append(icon("more"), element("span", "More"));
$("mobile-nav").append(more);
function makeButton(text, handler) {
  const b = element("button", text);
  b.type = "button";
  b.onclick = handler;
  return b;
}
function card(title, description, action, glyph) {
  const box = element("article", null, "card detail");
  if (glyph) box.append(icon(glyph));
  box.append(element("h2", title), element("p", description));
  if (action) box.append(action);
  return box;
}
function log(title) {
  activity.unshift({ title, at: new Date() });
  if (activity.length > 60) activity.pop();
  renderRecent();
  if (current === "activity") renderPage();
}
function timeline(items) {
  return items.map((item) => {
    const row = element("div", null, "timeline-row");
    row.append(
      icon("clock"),
      element("span", item.title),
      element(
        "time",
        item.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      ),
    );
    return row;
  });
}
function renderRecent() {
  const list = $("recent-list");
  if (activity.length) list.replaceChildren(...timeline(activity.slice(0, 3)));
  else {
    const empty = element("div", null, "empty-row");
    empty.append(
      icon("clock"),
      element("p", "Your conversations and actions will appear here."),
    );
    list.replaceChildren(empty);
  }
}
function appendCaption(speaker, delta) {
  if (!partial || partial.speaker !== speaker) {
    partial = { speaker, text: "", at: new Date() };
    turns.push(partial);
    if (turns.length > 80) turns.shift();
    const row = element("div", null, "turn");
    row.append(element("strong", speaker), element("span"));
    $("dialogue").append(row);
    if ($("dialogue").children.length > 80)
      $("dialogue").firstElementChild.remove();
  }
  partial.text = (partial.text + delta).slice(-16000);
  $("dialogue").lastElementChild.lastElementChild.textContent = partial.text;
  $("dialogue").hidden = !captions;
  $("dialogue").scrollTop = $("dialogue").scrollHeight;
  if (current === "conversations") renderPage();
}
const phaseNames = {
  idle: ["Ready when you are.", "Microphone off"],
  requesting_permission: ["Allow microphone access", "Requesting access"],
  connecting: ["Connecting to Edith…", "Connecting"],
  listening: ["I’m listening.", "Listening"],
  text: ["What’s on your mind?", "Text session"],
  thinking: ["Thinking it through…", "Thinking"],
  speaking: ["Edith is speaking.", "Speaking"],
  executing: ["Working on your request…", "Using a tool"],
  error: ["Let’s try again.", "Connection issue"],
};
function updateControls() {
  const inSession = !!mode;
  $("talk").hidden = inSession;
  $("talk").disabled = !snapshot?.hasKey;
  $("mic-toggle").hidden =
    mode !== "voice" || ["requesting_permission", "connecting"].includes(phase);
  $("mic-toggle").textContent = micMuted ? "Unmute mic" : "Mute mic";
  $("end-session").hidden = !inSession;
  $("orb-title").textContent =
    micMuted && phase === "listening"
      ? "Microphone muted."
      : phaseNames[phase][0];
  $("orb-status").textContent =
    micMuted && phase === "listening" ? "Muted" : phaseNames[phase][1];
  $("console").dataset.phase = phase;
  if (pendingReview && mode && phase !== "speaking") {
    $("orb-status").textContent = "Review required";
    $("console").dataset.phase = "awaiting_approval";
  }
  $("orb-hint").textContent = inSession
    ? mode === "text"
      ? "This conversation uses your keyboard."
      : "Speak naturally. You can interrupt or end the session."
    : "Start a conversation or type a message below.";
  $("mic-status").textContent =
    mode === "voice" && phase !== "requesting_permission"
      ? micMuted
        ? "Muted"
        : "In use"
      : "Off";
  $("composer").querySelector("button").disabled =
    !$("message").value.trim() ||
    ["requesting_permission", "connecting", "thinking"].includes(phase);
}
function errorMessage(text) {
  $("console-error").textContent = text;
  $("console-error").hidden = !text;
}
const session = createSession({
  onState(s) {
    phase = s.phase;
    mode = s.mode;
    micMuted = s.muted;
    if (!mode) setReview(null);
    updateControls();
    errorMessage(s.message || "");
  },
  onCaption: appendCaption,
  onBoundary() {
    partial = null;
  },
  onLevel(level) {
    $("orb-zone").style.setProperty("--level", String(Math.min(level, 1)));
  },
  onActivity: log,
});
$("talk").onclick = () => session.start("voice");
$("end-session").onclick = () => session.end();
$("mic-toggle").onclick = () => session.mute();
$("message").oninput = updateControls;
function navigate(path) {
  if (location.pathname !== path) {
    history.pushState(null, "", path);
    route(true);
  } else if ($("palette").open) $("palette").close();
}
function localCommand(text) {
  const query = text.trim().toLowerCase().replace(/^\//, "");
  return pages.find(
    ([id, label]) =>
      query === id ||
      query === label.toLowerCase() ||
      query === "open " + label.toLowerCase(),
  );
}
$("composer").onsubmit = (event) => {
  event.preventDefault();
  const value = $("message").value.trim();
  if (!value) return;
  const match = localCommand(value);
  if (match) {
    navigate(link(match[0], match[1]).pathname);
    log("Opened " + match[1]);
  } else if (!snapshot?.hasKey) {
    errorMessage(
      loadError ||
        "Gemini is unavailable. Type “Files”, “Calendar” or “Help” to open a workspace page.",
    );
    return;
  } else if (!session.send(value)) return;
  $("message").value = "";
  updateControls();
};
const exampleRow = element("div", null, "examples");
for (const [label, prompt] of [
  ["Plan my day", "Help me plan my day. Ask what I need to get done."],
  ["Brainstorm ideas", "Help me brainstorm ideas for "],
  ["Draft a message", "Help me draft a message about "],
  ["Explore a topic", "Explain this topic with a practical example: "],
]) {
  const chip = makeButton(label, () => {
    $("message").value = prompt;
    $("message").focus();
    updateControls();
  });
  exampleRow.append(chip);
}
$("composer").after(exampleRow);
const searchDialog = $("palette");
if (!/Mac|iPhone|iPad/.test(navigator.platform))
  $("search-open").querySelector("kbd").textContent = "Ctrl K";
function setReview(request) {
  clearTimeout(reviewTimer);
  pendingReview = request;
  document.querySelector(".approval-link span").textContent = request
    ? "Review a file request"
    : "Permissions & approvals";
  if (request)
    reviewTimer = setTimeout(
      () => setReview(null),
      Math.max(0, request.expiresAt - Date.now()),
    );
  updateControls();
  if (current === "permissions") renderPage();
}
function openPalette() {
  if (!searchDialog.open) searchDialog.showModal();
  $("palette-input").value = "";
  filterPalette();
  $("palette-input").focus();
}
function filterPalette() {
  const query = $("palette-input").value.trim().toLowerCase();
  const matches = pages.filter((p) =>
    (p[1] + " " + p[3]).toLowerCase().includes(query),
  );
  $("palette-results").replaceChildren(
    ...matches.map(([id, label, glyph]) => link(id, label, glyph)),
  );
  if (!matches.length)
    $("palette-results").append(element("p", "No matching pages."));
}
$("search-open").onclick = more.onclick = openPalette;
$("palette-close").onclick = () => searchDialog.close();
$("palette-input").oninput = filterPalette;
$("palette-input").onkeydown = (e) => {
  const first = $("palette-results").querySelector("a");
  if (e.key === "Enter" && first) {
    e.preventDefault();
    first.click();
  }
  if (e.key === "ArrowDown" && first) {
    e.preventDefault();
    first.focus();
  }
};
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    searchDialog.open ? searchDialog.close() : openPalette();
  }
});
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (
    !a ||
    a.origin !== location.origin ||
    !/^\/app(?:\/|$)/.test(a.pathname) ||
    a.hash ||
    e.ctrlKey ||
    e.metaKey ||
    e.shiftKey ||
    e.altKey ||
    e.button !== 0
  )
    return;
  e.preventDefault();
  if (searchDialog.open) searchDialog.close();
  navigate(a.pathname);
});
$("rail-toggle").onclick = () => {
  const b = $("rail-toggle");
  b.setAttribute(
    "aria-expanded",
    String(b.getAttribute("aria-expanded") !== "true"),
  );
};
const upcoming = {
  tasks: [
    "No tasks to review",
    "Task plans, approvals and persistent execution history are planned for a later release.",
  ],
  automations: [
    "No workflows scheduled",
    "The automation editor and background scheduler are coming in a later release.",
  ],
  knowledge: [
    "No collections connected",
    "Document import and answers with source citations are coming in a later release.",
  ],
  memory: [
    "Session only",
    "Long-term memory is unavailable. This workspace keeps dialogue in the open page until you clear it or reload.",
  ],
  notifications: [
    "No notifications",
    "This release shows connection and permission messages in the voice console.",
  ],
};
function renderPage() {
  const body = $("page-body");
  body.replaceChildren();
  const files = snapshot?.files;
  const entry = pages.find((page) => page[0] === current);
  if (!entry || location.pathname.split("/").filter(Boolean).length > 2) {
    body.append(
      card(
        "Page or record unavailable",
        "This address has no accessible record in this workspace.",
        link("home", "Return home"),
        "folder",
      ),
    );
    return;
  }
  if (upcoming[current]) {
    body.append(card(...upcoming[current], null, entry[2]));
    return;
  }
  if (current === "conversations") {
    if (!turns.length)
      body.append(
        card(
          "No conversation yet",
          "Start speaking or send a message. Your dialogue will appear here for this visit.",
          link("voice", "Open Voice Studio"),
          "message",
        ),
      );
    else {
      const panel = card(
        "Current conversation",
        "Available for this visit.",
        link("voice", "Continue conversation"),
        "message",
      );
      for (const turn of turns) {
        const row = element("div", null, "turn");
        row.append(element("strong", turn.speaker), element("span", turn.text));
        panel.append(row);
      }
      body.append(panel);
    }
  } else if (current === "activity") {
    const panel = card(
      activity.length ? "Session activity" : "No activity yet",
      "This view records connections and actions observed in this tab.",
      null,
      "pulse",
    );
    panel.append(...timeline(activity));
    body.append(panel);
  } else if (current === "files" || current === "devices") {
    const local = files && !files.hosted && files.enabled;
    if (current === "devices" || !local)
      body.append(
        card(
          !snapshot
            ? "Device status unavailable"
            : local
              ? "Local Windows edition"
              : files.hosted
                ? "No paired computer"
                : "Local file search disabled",
          local
            ? "The local service can search folders authorized on this PC."
            : files?.hosted
              ? "Run the Windows edition on your PC to search authorized folders. Remote pairing is planned for a later release."
              : "Enable authorized file roots in the Windows edition to use file search.",
          local ? link("files", "View files") : link("help", "Setup guidance"),
          "monitor",
        ),
      );
  } else if (current === "calendar") {
    const demo = element("a", "Open demo calendar");
    demo.href = "/demo";
    body.append(
      card(
        "No personal calendar connected",
        "External calendar connections are coming later. The sample appointment calendar is available separately.",
        demo,
        "calendar",
      ),
    );
  } else if (current === "integrations" || current === "skills") {
    body.append(
      card(
        "Gemini Live",
        snapshot?.hasKey
          ? "A server credential is configured. Start a session to connect for voice or text."
          : "Provider configuration is unavailable.",
        link("voice", "Open Voice Studio"),
        "wave",
      ),
      card(
        "Windows file search",
        files && !files.hosted && files.enabled
          ? "Available on this PC for authorized folders."
          : "Available in the local Windows edition.",
        link("files", "View files"),
        "folder",
      ),
    );
  } else if (current === "permissions") {
    if (pendingReview)
      body.append(
        card(
          "Review required",
          pendingReview.preview +
            " Review the matching result in Files to choose your next action.",
          link("files", "Review file results"),
          "shield",
        ),
      );
    body.append(
      card(
        "Microphone access",
        "Your browser asks for microphone access when you choose Talk to Edith. Ending the session releases the microphone. Change permission in your browser’s site settings.",
        link("voice", "Voice controls"),
        "mic",
      ),
      card(
        "File access",
        files?.hosted
          ? "The hosted workspace has no access to your PC."
          : "The local service enforces configured folders and file types. Review the authorized roots in Files.",
        link("files", "View file access"),
        "shield",
      ),
    );
  } else if (current === "settings") {
    const toggle = makeButton(
      captions ? "Hide live captions" : "Show live captions",
      () => {
        captions = !captions;
        $("dialogue").hidden = !captions || !turns.length;
        renderPage();
      },
    );
    toggle.setAttribute("aria-pressed", String(captions));
    const clear = makeButton("Clear conversation", () => {
      turns.length = 0;
      partial = null;
      $("dialogue").replaceChildren();
      $("dialogue").hidden = true;
      if (mode) session.end();
      log("Conversation cleared");
      renderPage();
    });
    clear.disabled = !turns.length;
    body.append(
      card(
        "Live captions",
        "Show transcribed speech and assistant replies in the console for this visit.",
        toggle,
        "wave",
      ),
      card(
        "Conversation privacy",
        "Clear the transcript from this tab and end its active session.",
        clear,
        "shield",
      ),
    );
  } else if (current === "help") {
    body.append(
      card(
        "Talk or type",
        "Choose Talk to Edith and allow your microphone, or type a question in the composer. Use End session when you finish.",
        link("home", "Open console"),
        "mic",
      ),
      card(
        "Navigate by keyboard",
        "Press Ctrl+K or ⌘K to find a page. You can also type a page name in the composer.",
        makeButton("Search workspace", openPalette),
        "search",
      ),
      card(
        "Use local files",
        "On Windows, run npm ci and npm start in the project folder, open localhost:3000/app/files and select an authorized folder. Configure allowed roots in config/file-tools.jsonc.",
        link("devices", "View devices"),
        "folder",
      ),
    );
  }
}
function route(focus = false) {
  const path = location.pathname.split("/").filter(Boolean);
  current = path[1] || "home";
  const page = pages.find((p) => p[0] === current);
  const detail = path.length > 2;
  const home = current === "home" && !detail;
  const consolePage = home || (current === "voice" && !detail);
  $("workspace-grid").hidden = !consolePage;
  $("context").hidden = !home;
  $("recent").hidden = !home;
  $("page-body").hidden = consolePage;
  $("workspace-grid").classList.toggle("studio", !home);
  $("file-view").hidden =
    current !== "files" ||
    detail ||
    !snapshot?.files?.enabled ||
    snapshot.files.hosted;
  $("crumb").textContent = page?.[1] || "Page unavailable";
  $("page-kicker").textContent = home
    ? new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
      }).format(new Date())
    : page?.[3] || "Workspace";
  $("page-title").textContent = page?.[4] || "Page unavailable";
  $("page-description").textContent = page?.[5] || "";
  $("dock").hidden =
    consolePage && $("talk").getBoundingClientRect().bottom > 0;
  document.title = "EDITH OS · " + $("crumb").textContent;
  for (const a of document.querySelectorAll("#side-nav a,#mobile-nav a")) {
    if (a.pathname === (current === "home" ? "/app" : "/app/" + current))
      a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  if (!consolePage) renderPage();
  if (focus) {
    window.scrollTo(0, 0);
    $("content").focus({ preventScroll: true });
  }
}
window.addEventListener("popstate", () => route(true));
new IntersectionObserver(([entry]) => {
  $("dock").hidden = entry.isIntersecting;
}).observe(document.querySelector(".controls"));
renderRecent();
route();
updateControls();
async function init() {
  try {
    const res = await fetch("/api/state");
    if (!res.ok) throw new Error();
    snapshot = await res.json();
    setCsrfToken(snapshot.csrfToken);
    $("provider-status").textContent = snapshot.hasKey
      ? "Configured"
      : "Unavailable";
    $("provider-status").classList.toggle("configured", snapshot.hasKey);
    $("device-status").textContent = snapshot.files.hosted
      ? "Not paired"
      : snapshot.files.enabled
        ? "Local edition"
        : "Disabled";
    window.dispatchEvent(
      new CustomEvent("edith:ready", { detail: snapshot.files }),
    );
    if (!snapshot.hasKey)
      errorMessage(
        "Gemini is unavailable. You can still open pages by typing their names.",
      );
    if (snapshot.files.enabled && !snapshot.files.hosted) {
      eventStream = new EventSource("/api/events");
      eventStream.addEventListener("securityConfirmation", (event) => {
        const { preview, expiresAt } = JSON.parse(event.data);
        setReview({ preview, expiresAt });
        log("File action needs review");
      });
      for (const [event, type] of [
        ["indexProgress", "index"],
        ["fileResults", "files"],
        ["fileAction", "file-action"],
      ]) {
        eventStream.addEventListener(event, (e) => {
          window.dispatchEvent(
            new CustomEvent("edith:" + type, { detail: JSON.parse(e.data) }),
          );
          if (type === "files") log("File search returned results");
        });
      }
    }
  } catch {
    loadError = "The workspace could not connect. Reload to retry.";
    errorMessage(loadError);
    $("provider-status").textContent = $("device-status").textContent =
      "Unavailable";
  }
  route();
  updateControls();
}
window.addEventListener("pagehide", () => {
  if (mode) session.end();
  eventStream?.close();
});
init();
