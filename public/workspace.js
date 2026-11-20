import "./files.js";
import { setCsrfToken, csrfHeaders } from "./security.js";
import { pages, link, icon } from "./workspace-nav.js";
import { createSession } from "./workspace-session.js";
import {
  mountBusinessEditor,
  formatPrice,
  effectiveServiceContact,
  formatContactParts,
} from "./business-editor.js";

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
let agentTasks = [],
  agentApprovals = [],
  agentTools = [],
  agentBusy = false,
  agentError = "";
let companionState = null,
  companionTelemetry = null,
  companionPairing = null,
  companionPendingApproval = null,
  companionBusy = false,
  companionError = "",
  processSort = "memory";
let kbCollections = [],
  kbDocuments = [],
  kbSummary = null,
  kbActiveCollectionId = "",
  kbSelectedDocIds = new Set(),
  kbPreviewDoc = null,
  kbActiveCitation = null,
  kbSearchResults = null,
  kbChatResponse = null,
  kbBusy = false,
  kbError = "",
  kbNotice = "",
  kbNewColName = "",
  kbNewColOcr = false,
  kbNewColRet = "0",
  kbSearchQuery = "",
  kbChatQuestion = "",
  kbChatMode = "qa",
  kbStateSig = "",
  kbPendingUploadFile = null;
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
$("composer").onsubmit = async (event) => {
  event.preventDefault();
  const value = $("message").value.trim();
  if (!value) return;
  if (/^\/task\s+/i.test(value)) {
    const prompt = value.replace(/^\/task\s+/i, "").trim();
    $("message").value = "";
    updateControls();
    if (!prompt) return;
    navigate("/app/tasks");
    await runAgentTask(prompt);
    return;
  }
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
function updateApprovalBadge() {
  const pendingCount = agentApprovals.filter((a) => a.state === "pending").length;
  const linkLabel = document.querySelector(".approval-link span");
  if (!linkLabel) return;
  if (pendingCount > 0) {
    linkLabel.textContent = `Pending approvals (${pendingCount})`;
  } else if (pendingReview) {
    linkLabel.textContent = "Review a file request";
  } else {
    linkLabel.textContent = "Permissions & approvals";
  }
}

function setReview(request) {
  clearTimeout(reviewTimer);
  pendingReview = request;
  updateApprovalBadge();
  if (request)
    reviewTimer = setTimeout(
      () => setReview(null),
      Math.max(0, request.expiresAt - Date.now()),
    );
  updateControls();
  if (current === "permissions") renderPage();
}

async function apiJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...csrfHeaders(),
      ...options.headers,
    },
  });
  let body = {};
  try {
    body = await res.json();
  } catch {}
  if (!res.ok) {
    throw new Error(body.error?.message || body.error || "Request failed.");
  }
  return body;
}

function upsertTask(task) {
  if (!task?.id) return;
  const idx = agentTasks.findIndex((t) => t.id === task.id);
  if (idx >= 0) agentTasks[idx] = task;
  else agentTasks.unshift(task);
}

function upsertApproval(approval) {
  if (!approval?.id) return;
  const idx = agentApprovals.findIndex((a) => a.id === approval.id);
  if (idx >= 0) agentApprovals[idx] = approval;
  else agentApprovals.unshift(approval);
  updateApprovalBadge();
}

async function refreshAgentState({ includeTools = false } = {}) {
  try {
    const requests = [
      apiJson("/api/agent/tasks"),
      apiJson("/api/agent/approvals"),
    ];
    if (includeTools) requests.push(apiJson("/api/agent/tools"));
    const [tasksRes, approvalsRes, toolsRes] = await Promise.all(requests);
    agentTasks = tasksRes.tasks || [];
    agentApprovals = approvalsRes.approvals || [];
    if (toolsRes?.tools) agentTools = toolsRes.tools;
    updateApprovalBadge();
    if (["tasks", "permissions", "skills"].includes(current)) renderPage();
  } catch {}
}

async function runAgentTask(prompt) {
  if (agentBusy) return;
  agentBusy = true;
  agentError = "";
  if (current === "tasks") renderPage();
  try {
    const res = await apiJson("/api/agent/tasks", {
      method: "POST",
      body: JSON.stringify({ prompt }),
    });
    if (res.task) {
      upsertTask(res.task);
      for (const app of res.task.approvals || []) upsertApproval(app);
      log("Task: " + res.task.state.replace(/_/g, " "));
    }
  } catch (err) {
    agentError = err.message;
  } finally {
    agentBusy = false;
    await refreshAgentState();
  }
}

async function handleApprovalDecision(approvalId, decision) {
  if (agentBusy) return;
  agentBusy = true;
  agentError = "";
  if (["tasks", "permissions"].includes(current)) renderPage();
  try {
    const res = await apiJson(
      `/api/agent/approvals/${encodeURIComponent(approvalId)}/${decision}`,
      { method: "POST", body: "{}" },
    );
    if (res.approval) upsertApproval(res.approval);
    if (res.task) upsertTask(res.task);
    log(
      decision === "approve"
        ? "Approved agent action"
        : "Rejected agent action",
    );
  } catch (err) {
    agentError = err.message;
  } finally {
    agentBusy = false;
    await refreshAgentState();
  }
}

async function controlAgentTask(taskId, action) {
  if (agentBusy) return;
  agentBusy = true;
  agentError = "";
  try {
    const res = await apiJson(
      `/api/agent/tasks/${encodeURIComponent(taskId)}/${action}`,
      { method: "POST", body: "{}" },
    );
    if (res.task) upsertTask(res.task);
    log(`Task ${action}`);
  } catch (err) {
    agentError = err.message;
  } finally {
    agentBusy = false;
    await refreshAgentState();
  }
}

function updateDeviceStatusChip() {
  const el = $("device-status");
  if (!el) return;
  if (snapshot?.files?.hosted || companionState?.hosted) {
    el.textContent = "Not paired";
  } else if (companionState?.paired) {
    el.textContent = "Paired";
  } else if (companionState?.securityState === "revoked") {
    el.textContent = "Revoked";
  } else if (snapshot?.files?.enabled) {
    el.textContent = "Local edition";
  } else {
    el.textContent = "Disabled";
  }
}

async function refreshCompanionState({ includeTelemetry = false } = {}) {
  try {
    companionState = await apiJson("/api/companion/status");
    updateDeviceStatusChip();
    if (companionState?.paired && includeTelemetry && companionState.permissions?.telemetry) {
      try {
        companionTelemetry = await apiJson(
          `/api/companion/telemetry?sortBy=${encodeURIComponent(processSort)}`,
        );
      } catch {
        companionTelemetry = null;
      }
    } else if (!companionState?.paired || !companionState.permissions?.telemetry) {
      companionTelemetry = null;
    }
    if (current === "devices") renderPage();
  } catch {}
}

async function startCompanionPairing() {
  if (companionBusy) return;
  companionBusy = true;
  companionError = "";
  if (current === "devices") renderPage();
  try {
    companionPairing = await apiJson("/api/companion/pair/start", {
      method: "POST",
      body: "{}",
    });
  } catch (err) {
    companionError = err.message;
  } finally {
    companionBusy = false;
    if (current === "devices") renderPage();
  }
}

async function completeCompanionPairing(deviceName) {
  if (companionBusy || !companionPairing) return;
  companionBusy = true;
  companionError = "";
  if (current === "devices") renderPage();
  try {
    companionState = await apiJson("/api/companion/pair/complete", {
      method: "POST",
      body: JSON.stringify({
        challengeId: companionPairing.challengeId,
        pairingCode: companionPairing.pairingCode,
        deviceName,
      }),
    });
    companionPairing = null;
    updateDeviceStatusChip();
    log("Paired local Windows PC");
    await refreshCompanionState({ includeTelemetry: true });
    await refreshAgentState();
  } catch (err) {
    companionError = err.message;
  } finally {
    companionBusy = false;
    if (current === "devices") renderPage();
  }
}

async function disconnectCompanion() {
  if (companionBusy) return;
  companionBusy = true;
  companionError = "";
  try {
    companionState = await apiJson("/api/companion/disconnect", {
      method: "POST",
      body: "{}",
    });
    companionTelemetry = null;
    companionPendingApproval = null;
    updateDeviceStatusChip();
    log("Disconnected PC companion");
  } catch (err) {
    companionError = err.message;
  } finally {
    companionBusy = false;
    if (current === "devices") renderPage();
  }
}

async function triggerEmergencyStop() {
  if (companionBusy) return;
  companionBusy = true;
  companionError = "";
  try {
    companionState = await apiJson("/api/companion/emergency-stop", {
      method: "POST",
      body: "{}",
    });
    companionTelemetry = null;
    companionPairing = null;
    companionPendingApproval = null;
    updateDeviceStatusChip();
    log("Emergency Stop activated");
    await refreshAgentState();
  } catch (err) {
    companionError = err.message;
  } finally {
    companionBusy = false;
    if (current === "devices") renderPage();
  }
}

async function updateCompanionPermissions(patch) {
  if (companionBusy) return;
  companionBusy = true;
  companionError = "";
  try {
    companionState = await apiJson("/api/companion/permissions", {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    log("Updated device permissions");
    await refreshCompanionState({
      includeTelemetry: Boolean(companionState?.permissions?.telemetry),
    });
  } catch (err) {
    companionError = err.message;
  } finally {
    companionBusy = false;
    if (current === "devices") renderPage();
  }
}

async function requestCompanionConfirmedAction(url, label) {
  if (companionBusy) return;
  companionBusy = true;
  companionError = "";
  if (current === "devices") renderPage();
  try {
    const res = await apiJson(url, { method: "POST", body: "{}" });
    if (res.status === "confirmation_required") {
      companionPendingApproval = { ...res, label };
      await refreshAgentState();
    }
  } catch (err) {
    companionError = err.message;
  } finally {
    companionBusy = false;
    if (current === "devices") renderPage();
  }
}

async function resolveCompanionApproval(approvalId, decision) {
  if (companionBusy) return;
  companionBusy = true;
  companionError = "";
  try {
    await apiJson(
      `/api/agent/approvals/${encodeURIComponent(approvalId)}/${decision}`,
      { method: "POST", body: "{}" },
    );
    companionPendingApproval = null;
    log(
      decision === "approve"
        ? "Approved companion action"
        : "Rejected companion action",
    );
    await refreshCompanionState({ includeTelemetry: true });
    await refreshAgentState();
  } catch (err) {
    companionError = err.message;
  } finally {
    companionBusy = false;
    if (current === "devices") renderPage();
  }
}

function bufferToBase64(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let binary = "";
  const chunk = 16384;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function refreshKnowledgeState({ render = true } = {}) {
  try {
    const [colRes, docRes] = await Promise.all([
      apiJson("/api/knowledge/collections"),
      apiJson(
        `/api/knowledge/documents${kbActiveCollectionId ? `?collectionId=${encodeURIComponent(kbActiveCollectionId)}` : ""}`,
      ),
    ]);
    kbCollections = colRes.collections || [];
    kbSummary = colRes.summary || null;
    kbDocuments = docRes.documents || [];
    const existingIds = new Set(kbDocuments.map((d) => d.id));
    for (const id of [...kbSelectedDocIds]) {
      if (!existingIds.has(id)) kbSelectedDocIds.delete(id);
    }
    if (kbActiveCollectionId && !kbCollections.some((c) => c.id === kbActiveCollectionId)) {
      kbActiveCollectionId = "";
    }
    const nextSig = JSON.stringify([kbActiveCollectionId, kbCollections, kbDocuments, kbSummary]);
    const changed = nextSig !== kbStateSig;
    kbStateSig = nextSig;
    if (render && changed && !kbBusy && current === "knowledge") renderPage();
  } catch {}
}

async function createKnowledgeCollection(payload) {
  if (kbBusy) return;
  kbBusy = true;
  kbError = "";
  kbNotice = "";
  if (current === "knowledge") renderPage();
  try {
    const res = await apiJson("/api/knowledge/collections", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (res.collection?.id) {
      kbActiveCollectionId = res.collection.id;
      kbNewColName = "";
      kbNewColOcr = false;
      kbNewColRet = "0";
      kbNotice = `Created collection "${res.collection.name}".`;
      log(`Knowledge collection: ${res.collection.name}`);
    }
    await refreshKnowledgeState({ render: false });
  } catch (err) {
    kbError = err.message;
  } finally {
    kbBusy = false;
    if (current === "knowledge") renderPage();
  }
}

async function uploadKnowledgeFile(file, { collectionId, ocrEnabled }) {
  if (kbBusy || !file) return;
  kbBusy = true;
  kbError = "";
  kbNotice = "";
  if (current === "knowledge") renderPage();
  try {
    const buf = await file.arrayBuffer();
    const contentBase64 = bufferToBase64(buf);
    const res = await apiJson("/api/knowledge/upload", {
      method: "POST",
      body: JSON.stringify({
        collectionId: collectionId || null,
        fileName: file.name,
        contentBase64,
        ocrEnabled,
      }),
    });
    kbNotice = `Indexed "${res.document?.fileName || file.name}" (v${res.document?.version || 1}, ${res.document?.chunkCount || 0} chunks).`;
    log(`Indexed document: ${file.name}`);
    await refreshKnowledgeState({ render: false });
  } catch (err) {
    kbError = err.message;
  } finally {
    kbBusy = false;
    kbPendingUploadFile = null;
    if (current === "knowledge") renderPage();
  }
}

async function ingestFolderIntoKnowledge(folderId) {
  if (kbBusy) return;
  kbBusy = true;
  kbError = "";
  kbNotice = "";
  if (current === "knowledge") renderPage();
  try {
    const targetColId = kbActiveCollectionId || "default";
    const activeCol = kbCollections.find((c) => c.id === kbActiveCollectionId);
    const res = await apiJson(
      `/api/knowledge/collections/${encodeURIComponent(targetColId)}/ingest-folder`,
      {
        method: "POST",
        body: JSON.stringify({
          folder: folderId,
          ocrEnabled: Boolean(activeCol?.ocrEnabled),
        }),
      },
    );
    kbNotice = `Indexed "${folderId}": ${res.indexedCount} updated/added, ${res.unchangedCount} unchanged, ${res.errorCount} errors.`;
    log(`Indexed local folder: ${folderId}`);
    await refreshKnowledgeState({ render: false });
  } catch (err) {
    kbError = err.message;
  } finally {
    kbBusy = false;
    if (current === "knowledge") renderPage();
  }
}

async function openKnowledgePreview(documentId, citation = null) {
  kbError = "";
  try {
    const res = await apiJson(`/api/knowledge/documents/${encodeURIComponent(documentId)}`);
    kbPreviewDoc = res.document;
    kbActiveCitation = citation;
    if (current === "knowledge") renderPage();
  } catch (err) {
    kbError = err.message;
    if (current === "knowledge") renderPage();
  }
}

async function reindexKnowledgeDoc(documentId) {
  if (kbBusy) return;
  kbBusy = true;
  kbError = "";
  try {
    const res = await apiJson(
      `/api/knowledge/documents/${encodeURIComponent(documentId)}/reindex`,
      { method: "POST", body: "{}" },
    );
    kbNotice = `Re-indexed "${res.document?.fileName}" (v${res.document?.version || 1}).`;
    if (kbPreviewDoc?.id === documentId) {
      await openKnowledgePreview(documentId, null);
    }
    await refreshKnowledgeState({ render: false });
  } catch (err) {
    kbError = err.message;
  } finally {
    kbBusy = false;
    if (current === "knowledge") renderPage();
  }
}

async function deleteKnowledgeDoc(documentId) {
  if (kbBusy) return;
  kbBusy = true;
  kbError = "";
  try {
    await apiJson(`/api/knowledge/documents/${encodeURIComponent(documentId)}`, {
      method: "DELETE",
    });
    kbSelectedDocIds.delete(documentId);
    if (kbPreviewDoc?.id === documentId) kbPreviewDoc = null;
    kbNotice = "Removed document from Knowledge index (original file preserved).";
    await refreshKnowledgeState({ render: false });
  } catch (err) {
    kbError = err.message;
  } finally {
    kbBusy = false;
    if (current === "knowledge") renderPage();
  }
}

async function runKnowledgeSearch(query) {
  if (kbBusy) return;
  kbBusy = true;
  kbError = "";
  try {
    const selected = [...kbSelectedDocIds];
    kbSearchResults = await apiJson("/api/knowledge/search", {
      method: "POST",
      body: JSON.stringify({
        query,
        collectionId: kbActiveCollectionId || null,
        documentIds: selected.length ? selected : null,
        limit: 8,
      }),
    });
  } catch (err) {
    kbError = err.message;
  } finally {
    kbBusy = false;
    if (current === "knowledge") renderPage();
  }
}

async function runKnowledgeChat({ question, mode, selectedOnly }) {
  if (kbBusy) return;
  kbBusy = true;
  kbError = "";
  try {
    const selected = [...kbSelectedDocIds];
    kbChatResponse = await apiJson("/api/knowledge/chat", {
      method: "POST",
      body: JSON.stringify({
        question,
        mode,
        collectionId: kbActiveCollectionId || null,
        documentIds: selected.length ? selected : null,
        selectedOnly,
      }),
    });
  } catch (err) {
    kbError = err.message;
  } finally {
    kbBusy = false;
    if (current === "knowledge") renderPage();
  }
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
  automations: [
    "No workflows scheduled",
    "The automation editor and background scheduler are coming in a later release.",
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
  if (current === "knowledge") {
    if (!snapshot && !loadError) {
      body.append(
        card(
          "Loading Private Knowledge",
          "Connecting to your local workspace session…",
          null,
          "book",
        ),
      );
      return;
    }
    const stats = kbSummary || { collections: kbCollections.length, documents: kbDocuments.length, chunks: 0 };
    const overviewCard = element("article", null, "card detail");
    const oHead = element("div", null, "agent-task-head");
    const oLeft = element("div");
    oLeft.append(
      icon("book"),
      element("h2", "Private Knowledge & Document Intelligence"),
      element(
        "p",
        `${stats.collections} collection(s) · ${stats.documents} indexed document(s) · ${stats.chunks} local chunk(s) · Supported: PDF, DOCX, XLSX, CSV, TXT, MD, JSON, LOG, PNG/JPG (opt-in OCR)`,
        "agent-meta",
      ),
    );
    const privBadge = element("span", "Local-only · Private", "agent-badge");
    oHead.append(oLeft, privBadge);
    overviewCard.append(oHead);

    if (kbNotice) {
      overviewCard.append(element("p", kbNotice, "agent-summary"));
    }
    if (kbError) {
      const errNode = element("p", kbError, "biz-status biz-status-error");
      errNode.setAttribute("role", "alert");
      overviewCard.append(errNode);
    }
    body.append(overviewCard);

    // Collections card
    const colCard = element("article", null, "card detail");
    colCard.append(
      element("h2", "Collections"),
      element(
        "p",
        "Organize private documents into collections with optional local WinRT OCR and retention rules.",
        "agent-meta",
      ),
    );
    const colBar = element("div", null, "agent-actions");
    const allBtn = makeButton("All collections", () => {
      kbActiveCollectionId = "";
      refreshKnowledgeState();
    });
    allBtn.className = !kbActiveCollectionId ? "biz-primary" : "biz-secondary";
    colBar.append(allBtn);
    for (const c of kbCollections) {
      const cBtn = makeButton(`${c.name} (${c.documentCount})`, () => {
        kbActiveCollectionId = c.id;
        refreshKnowledgeState();
      });
      cBtn.className = kbActiveCollectionId === c.id ? "biz-primary" : "biz-secondary";
      colBar.append(cBtn);
    }
    if (kbActiveCollectionId) {
      const reindexColBtn = makeButton("Re-index collection", async () => {
        kbBusy = true;
        try {
          await apiJson(`/api/knowledge/collections/${encodeURIComponent(kbActiveCollectionId)}/reindex`, {
            method: "POST",
            body: "{}",
          });
          kbNotice = "Re-indexed active collection.";
          await refreshKnowledgeState({ render: false });
        } catch (e) {
          kbError = e.message;
        } finally {
          kbBusy = false;
          renderPage();
        }
      });
      reindexColBtn.className = "biz-secondary";
      reindexColBtn.disabled = kbBusy;
      const delColBtn = makeButton("Delete collection", async () => {
        kbBusy = true;
        try {
          await apiJson(`/api/knowledge/collections/${encodeURIComponent(kbActiveCollectionId)}`, {
            method: "DELETE",
          });
          kbActiveCollectionId = "";
          kbNotice = "Collection index removed (original local files preserved).";
          await refreshKnowledgeState({ render: false });
        } catch (e) {
          kbError = e.message;
        } finally {
          kbBusy = false;
          renderPage();
        }
      });
      delColBtn.className = "biz-remove";
      delColBtn.disabled = kbBusy;
      colBar.append(reindexColBtn, delColBtn);
    }
    const purgeBtn = makeButton("Purge expired", async () => {
      kbBusy = true;
      try {
        const res = await apiJson("/api/knowledge/retention/purge", { method: "POST", body: "{}" });
        kbNotice = `Retention check removed ${res.deletedCount || 0} expired document(s).`;
        await refreshKnowledgeState({ render: false });
      } catch (e) {
        kbError = e.message;
      } finally {
        kbBusy = false;
        renderPage();
      }
    });
    purgeBtn.className = "biz-secondary";
    purgeBtn.disabled = kbBusy;
    colBar.append(purgeBtn);
    colCard.append(colBar);

    const newColForm = element("form", null, "kb-form");
    const colNameLabel = element("label", "Collection name", "agent-label");
    colNameLabel.setAttribute("for", "kb-new-col-name");
    const colNameInput = element("input", null, "agent-input");
    colNameInput.id = "kb-new-col-name";
    colNameInput.placeholder = "e.g., Finance & HR";
    colNameInput.required = true;
    colNameInput.maxLength = 80;
    colNameInput.value = kbNewColName;
    colNameInput.oninput = () => {
      kbNewColName = colNameInput.value;
    };
    const colOcrId = "kb-new-col-ocr";
    const colOcrLabel = element("label", null, "biz-day-chip");
    colOcrLabel.setAttribute("for", colOcrId);
    const colOcrCb = element("input");
    colOcrCb.type = "checkbox";
    colOcrCb.id = colOcrId;
    colOcrCb.checked = kbNewColOcr;
    colOcrCb.onchange = () => {
      kbNewColOcr = colOcrCb.checked;
    };
    colOcrLabel.append(colOcrCb, element("span", "Enable opt-in local OCR for images"));
    const colRetLabel = element("label", "Retention days (0 = keep)", "agent-label");
    colRetLabel.setAttribute("for", "kb-new-col-ret");
    const colRetInput = element("input", null, "agent-input kb-num-input");
    colRetInput.id = "kb-new-col-ret";
    colRetInput.type = "number";
    colRetInput.min = "0";
    colRetInput.max = "3650";
    colRetInput.value = kbNewColRet;
    colRetInput.oninput = () => {
      kbNewColRet = colRetInput.value;
    };
    const colCreateBtn = element("button", "Create collection", "biz-primary");
    colCreateBtn.type = "submit";
    colCreateBtn.disabled = kbBusy;
    const colFormRow = element("div", null, "agent-form-row");
    colFormRow.append(colNameInput, colRetInput, colCreateBtn);
    newColForm.append(colNameLabel, colRetLabel, colFormRow, colOcrLabel);
    newColForm.onsubmit = async (ev) => {
      ev.preventDefault();
      await createKnowledgeCollection({
        name: colNameInput.value.trim(),
        ocrEnabled: colOcrCb.checked,
        retentionDays: Number(colRetInput.value || 0),
      });
    };
    colCard.append(newColForm);
    body.append(colCard);

    // Upload & Local Folder Sources card
    const sourceCard = element("article", null, "card detail");
    sourceCard.append(
      icon("folder"),
      element("h2", "Upload Documents & Local Folder Sources"),
      element(
        "p",
        "Documents are parsed, chunked, and embedded locally inside EDITH. Raw document text is never uploaded to Gemini.",
        "agent-meta",
      ),
    );
    const uploadForm = element("form", null, "kb-form");
    const upLabel = element("label", "Upload document (up to 10 MB)", "agent-label");
    upLabel.setAttribute("for", "kb-upload-file");
    const upInput = element("input", null, "agent-input");
    upInput.id = "kb-upload-file";
    upInput.type = "file";
    upInput.accept = ".pdf,.docx,.xlsx,.csv,.txt,.md,.json,.log,.png,.jpg,.jpeg";
    upInput.onchange = () => {
      kbPendingUploadFile = upInput.files?.[0] || null;
    };
    const upOcrId = "kb-upload-ocr";
    const upOcrLabel = element("label", null, "biz-day-chip");
    upOcrLabel.setAttribute("for", upOcrId);
    const upOcrCb = element("input");
    upOcrCb.type = "checkbox";
    upOcrCb.id = upOcrId;
    upOcrCb.checked = Boolean(
      kbCollections.find((c) => c.id === kbActiveCollectionId)?.ocrEnabled,
    );
    upOcrLabel.append(upOcrCb, element("span", "Enable OCR if uploading PNG/JPG image"));
    const upBtn = element("button", kbBusy ? "Indexing…" : "Upload & Index", "biz-primary");
    upBtn.type = "submit";
    upBtn.disabled = kbBusy;
    const upRow = element("div", null, "agent-form-row");
    upRow.append(upInput, upBtn);
    uploadForm.append(upLabel, upRow, upOcrLabel);
    uploadForm.onsubmit = async (ev) => {
      ev.preventDefault();
      const f = upInput.files?.[0] || kbPendingUploadFile;
      if (!f) {
        kbError = "Choose a document to upload first.";
        renderPage();
        return;
      }
      await uploadKnowledgeFile(f, {
        collectionId: kbActiveCollectionId || null,
        ocrEnabled: upOcrCb.checked,
      });
    };
    sourceCard.append(uploadForm);

    if (files && !files.hosted && files.enabled && files.folders?.length) {
      const fList = element("ul", null, "agent-tools-list");
      for (const root of files.folders) {
        const li = element("li", null, "agent-tool-item device-app-row");
        const left = element("div");
        left.append(
          element("strong", `Local folder source: ${root.id}`),
          element(
            "p",
            `Permission: Authorized Read-Only Root · Available: ${root.available === false ? "Unavailable" : "Ready"}`,
            "agent-step-detail",
          ),
        );
        const right = element("div", null, "device-app-controls");
        const idxBtn = makeButton("Index folder", () => ingestFolderIntoKnowledge(root.id));
        idxBtn.className = "biz-secondary";
        idxBtn.disabled = kbBusy || root.available === false;
        right.append(idxBtn);
        li.append(left, right);
        fList.append(li);
      }
      sourceCard.append(fList);
    }
    body.append(sourceCard);

    // Indexed documents card
    const docsCard = element("article", null, "card detail");
    docsCard.append(
      icon("checklist"),
      element("h2", `Indexed Documents (${kbDocuments.length})`),
      element(
        "p",
        "Check specific documents below to scope Q&A or document comparison exclusively to your selection.",
        "agent-meta",
      ),
    );
    if (!kbDocuments.length) {
      docsCard.append(
        element("p", "No documents indexed in this view yet. Upload a document or index an authorized folder above.", "agent-meta"),
      );
    } else {
      const dList = element("ul", null, "agent-tools-list");
      for (const doc of kbDocuments) {
        const li = element("li", null, "agent-tool-item kb-doc-row");
        const selId = `kb-doc-sel-${doc.id}`;
        const chkWrap = element("label", null, "biz-day-chip");
        chkWrap.setAttribute("for", selId);
        const cb = element("input");
        cb.type = "checkbox";
        cb.id = selId;
        cb.checked = kbSelectedDocIds.has(doc.id);
        cb.onchange = () => {
          if (cb.checked) kbSelectedDocIds.add(doc.id);
          else kbSelectedDocIds.delete(doc.id);
          renderPage();
        };
        chkWrap.append(cb, element("span", "Select"));

        const info = element("div", null, "kb-doc-info");
        info.append(
          element("strong", `${doc.fileName} (v${doc.version})`),
          element(
            "p",
            `Status: ${doc.status} · Freshness: ${doc.freshness} · Source: ${doc.sourceType === "upload" ? "Upload (Private)" : `${doc.rootId || "Local"} (Local-only)`} · ${doc.chunkCount} chunks · ${doc.tableCount} table(s)`,
            "agent-step-detail",
          ),
        );
        if (doc.errorMessage) {
          info.append(
            element(
              "p",
              doc.errorMessage,
              doc.status === "error" ? "agent-step-error" : "agent-step-detail",
            ),
          );
        }

        const btns = element("div", null, "device-app-controls");
        const prevBtn = makeButton("Preview", () => openKnowledgePreview(doc.id, null));
        prevBtn.className = "biz-secondary";
        const reBtn = makeButton("Re-index", () => reindexKnowledgeDoc(doc.id));
        reBtn.className = "biz-secondary";
        reBtn.disabled = kbBusy;
        const rmBtn = makeButton("Remove", () => deleteKnowledgeDoc(doc.id));
        rmBtn.className = "biz-remove";
        rmBtn.disabled = kbBusy;
        btns.append(prevBtn, reBtn, rmBtn);

        li.append(chkWrap, info, btns);
        dList.append(li);
      }
      docsCard.append(dList);
    }
    body.append(docsCard);

    // Semantic search & Knowledge Chat card
    const chatCard = element("article", null, "card detail");
    chatCard.append(
      icon("search"),
      element("h2", "Semantic Search & Grounded Knowledge Chat"),
      element(
        "p",
        `${kbSelectedDocIds.size ? `${kbSelectedDocIds.size} document(s) currently selected.` : "All indexed documents in active view are searchable."} Answers cite exact source chunks locally.`,
        "agent-meta",
      ),
    );

    const searchForm = element("form", null, "kb-form");
    const sLabel = element("label", "Semantic & keyword search", "agent-label");
    sLabel.setAttribute("for", "kb-search-input");
    const sInput = element("input", null, "agent-input");
    sInput.id = "kb-search-input";
    sInput.placeholder = "e.g., Mahindra Logistics or 14,850";
    sInput.required = true;
    sInput.value = kbSearchQuery;
    sInput.oninput = () => {
      kbSearchQuery = sInput.value;
    };
    const sBtn = element("button", "Search knowledge", "biz-secondary");
    sBtn.type = "submit";
    sBtn.disabled = kbBusy;
    const sRow = element("div", null, "agent-form-row");
    sRow.append(sInput, sBtn);
    searchForm.append(sLabel, sRow);
    searchForm.onsubmit = async (ev) => {
      ev.preventDefault();
      await runKnowledgeSearch(sInput.value.trim());
    };
    chatCard.append(searchForm);

    if (kbSearchResults) {
      const srBox = element("div", null, "kb-results-box");
      srBox.append(
        element(
          "strong",
          `Search hits for "${kbSearchResults.query}" (${kbSearchResults.results?.length || 0} across ${kbSearchResults.scopedDocumentCount} doc(s))`,
        ),
      );
      if (kbSearchResults.results?.length) {
        const ul = element("ul", null, "agent-tools-list");
        for (const r of kbSearchResults.results) {
          const li = element("li", null, "agent-tool-item");
          const citeBtn = makeButton(
            `Open ${r.fileName} (${r.section}, score ${r.score})`,
            () => openKnowledgePreview(r.documentId, {
              documentId: r.documentId,
              fileName: r.fileName,
              snippet: r.content.slice(0, 120),
              highlightText: kbSearchResults.query.slice(0, 60),
            }),
          );
          citeBtn.className = "kb-cite-chip";
          li.append(citeBtn, element("p", r.content.slice(0, 260), "agent-step-detail"));
          ul.append(li);
        }
        srBox.append(ul);
      }
      chatCard.append(srBox);
    }

    const chatForm = element("form", null, "kb-form");
    const qLabel = element("label", "Ask Private Knowledge", "agent-label");
    qLabel.setAttribute("for", "kb-chat-input");
    const qInput = element("input", null, "agent-input");
    qInput.id = "kb-chat-input";
    qInput.placeholder = "Ask a question, compare offer letters, summarize, or extract tables…";
    qInput.value = kbChatQuestion;
    qInput.oninput = () => {
      kbChatQuestion = qInput.value;
    };
    const modeLabel = element("label", "Analysis mode", "agent-label");
    modeLabel.setAttribute("for", "kb-chat-mode");
    const modeSel = element("select", null, "agent-input kb-mode-select");
    modeSel.id = "kb-chat-mode";
    for (const [val, txt] of [
      ["qa", "Ask question"],
      ["summarize", "Summarize documents"],
      ["compare", "Compare documents"],
      ["tables", "Extract tables"],
    ]) {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = txt;
      modeSel.append(opt);
    }
    modeSel.value = kbChatMode;
    modeSel.onchange = () => {
      kbChatMode = modeSel.value;
    };
    const selOnlyId = "kb-chat-selected-only";
    const selOnlyLabel = element("label", null, "biz-day-chip");
    selOnlyLabel.setAttribute("for", selOnlyId);
    const selOnlyCb = element("input");
    selOnlyCb.type = "checkbox";
    selOnlyCb.id = selOnlyId;
    selOnlyCb.checked = kbSelectedDocIds.size > 0;
    selOnlyLabel.append(selOnlyCb, element("span", "Answer using only selected documents"));

    const askBtn = element("button", kbBusy ? "Working…" : "Run local analysis", "biz-primary");
    askBtn.type = "submit";
    askBtn.disabled = kbBusy;
    const chatRow = element("div", null, "agent-form-row");
    chatRow.append(qInput, modeSel, askBtn);
    chatForm.append(qLabel, modeLabel, chatRow, selOnlyLabel);
    chatForm.onsubmit = async (ev) => {
      ev.preventDefault();
      await runKnowledgeChat({
        question: qInput.value.trim(),
        mode: modeSel.value,
        selectedOnly: selOnlyCb.checked,
      });
    };
    chatCard.append(chatForm);

    if (kbChatResponse) {
      const ansBox = element("div", null, "kb-answer");
      const ansPre = element("pre", kbChatResponse.answer, "agent-preview");
      ansPre.tabIndex = 0;
      ansPre.setAttribute("role", "region");
      ansPre.setAttribute("aria-label", "Knowledge grounded answer");
      ansBox.append(ansPre);

      if (kbChatResponse.citations?.length) {
        const citeBar = element("div", null, "agent-actions");
        for (const c of kbChatResponse.citations) {
          const cBtn = makeButton(
            `[${c.citationNumber}] ${c.fileName} · ${c.section}`,
            () => openKnowledgePreview(c.documentId, c),
          );
          cBtn.className = "kb-cite-chip";
          citeBar.append(cBtn);
        }
        ansBox.append(citeBar);
      }

      if (kbChatResponse.tables?.length) {
        for (const tbl of kbChatResponse.tables) {
          const tw = element("div", null, "device-table-wrap");
          tw.tabIndex = 0;
          tw.setAttribute("role", "region");
          tw.setAttribute("aria-label", `Extracted table ${tbl.title || ""}`);
          const tableEl = element("table", null, "device-table");
          const thead = document.createElement("thead");
          const thr = document.createElement("tr");
          for (const h of tbl.headers || []) {
            const th = element("th", h);
            th.scope = "col";
            thr.append(th);
          }
          thead.append(thr);
          const tbody = document.createElement("tbody");
          for (const rowVals of (tbl.rows || []).slice(0, 30)) {
            const tr = document.createElement("tr");
            for (const cellVal of rowVals) {
              tr.append(element("td", String(cellVal ?? "")));
            }
            tbody.append(tr);
          }
          tableEl.append(thead, tbody);
          tw.append(tableEl);
          ansBox.append(element("p", `${tbl.fileName ? `${tbl.fileName} — ` : ""}${tbl.title || "Table"}`, "kb-table-title"), tw);
        }
      }
      chatCard.append(ansBox);
    }
    body.append(chatCard);

    // Document preview & citation highlight card
    if (kbPreviewDoc) {
      const prevCard = element("article", null, "card detail");
      prevCard.append(
        element("h2", `Preview: ${kbPreviewDoc.fileName} (v${kbPreviewDoc.version})`),
        element(
          "p",
          `Freshness: ${kbPreviewDoc.freshness} · Parser: ${kbPreviewDoc.parserName || "n/a"} · ${kbPreviewDoc.chunkCount} chunks · ${kbPreviewDoc.tableCount} table(s)`,
          "agent-meta",
        ),
      );
      const pre = element("pre", null, "agent-preview kb-preview");
      pre.tabIndex = 0;
      pre.setAttribute("role", "region");
      pre.setAttribute("aria-label", "Document content preview");
      const rawText = kbPreviewDoc.fullText || "(No extracted text content)";
      const needle = (kbActiveCitation?.highlightText || kbActiveCitation?.snippet || "").trim();
      const idx = needle.length >= 3 ? rawText.toLowerCase().indexOf(needle.toLowerCase()) : -1;
      if (idx >= 0) {
        pre.append(document.createTextNode(rawText.slice(0, idx)));
        const mark = element("mark", rawText.slice(idx, idx + needle.length), "kb-cite-mark");
        pre.append(mark);
        pre.append(document.createTextNode(rawText.slice(idx + needle.length)));
      } else {
        pre.textContent = rawText;
      }
      prevCard.append(pre);

      if (kbPreviewDoc.tables?.length) {
        for (const tbl of kbPreviewDoc.tables) {
          const tw = element("div", null, "device-table-wrap");
          tw.tabIndex = 0;
          tw.setAttribute("role", "region");
          tw.setAttribute("aria-label", `Preview table ${tbl.title || ""}`);
          const tableEl = element("table", null, "device-table");
          const thead = document.createElement("thead");
          const thr = document.createElement("tr");
          for (const h of tbl.headers || []) {
            const th = element("th", h);
            th.scope = "col";
            thr.append(th);
          }
          thead.append(thr);
          const tbody = document.createElement("tbody");
          for (const rowVals of (tbl.rows || []).slice(0, 30)) {
            const tr = document.createElement("tr");
            for (const cellVal of rowVals) tr.append(element("td", String(cellVal ?? "")));
            tbody.append(tr);
          }
          tableEl.append(thead, tbody);
          tw.append(tableEl);
          prevCard.append(element("p", tbl.title || "Table", "kb-table-title"), tw);
        }
      }
      body.append(prevCard);
    }
    return;
  }
  if (current === "tasks") {
    const runner = element("article", null, "card detail");
    runner.append(
      icon("checklist"),
      element("h2", "Run an agent task"),
      element(
        "p",
        "Submit a multi-step request. EDITH plans steps, reads authorized local files when needed, and pauses for approval before creating reports.",
      ),
    );
    const form = element("form", null, "agent-form");
    const label = element("label", "Task request", "agent-label");
    label.setAttribute("for", "agent-task-input");
    const input = element("input", null, "agent-input");
    input.id = "agent-task-input";
    input.maxLength = 2000;
    input.required = true;
    input.placeholder =
      "e.g., Find all invoices from October, create a summary report, and save it in Downloads";
    const row = element("div", null, "agent-form-row");
    const runBtn = element(
      "button",
      agentBusy ? "Running…" : "Run task",
      "primary",
    );
    runBtn.type = "submit";
    runBtn.disabled = agentBusy;
    row.append(input, runBtn);
    form.append(label, row);
    form.onsubmit = async (event) => {
      event.preventDefault();
      const prompt = input.value.trim();
      if (!prompt) return;
      await runAgentTask(prompt);
    };
    const presets = element("div", null, "examples");
    for (const [chipLabel, chipPrompt] of [
      [
        "Summarize October invoices",
        "EDITH, find all invoices from October, create a summary report, and save the report in my Downloads folder.",
      ],
      ["Show top RAM apps", "EDITH, show which applications consume the most RAM."],
      ["Check D drive storage", "EDITH, check how much storage is left on D drive."],
      ["Find duplicate screenshots (read-only)", "EDITH, find duplicate screenshots, but don't delete anything."],
      ["Organize PDF invoices", "EDITH, organize the PDF invoices in my Downloads folder."],
      ["Check file index status", "Check local file indexing status"],
      ["Company & booking summary", "Show company services, prices, contacts, and bookings"],
    ]) {
      const btn = makeButton(chipLabel, () => {
        input.value = chipPrompt;
        input.focus();
      });
      presets.append(btn);
    }
    runner.append(form, presets);
    if (agentError) {
      const errNode = element("p", agentError, "biz-status biz-status-error");
      errNode.setAttribute("role", "alert");
      runner.append(errNode);
    }
    body.append(runner);

    if (!agentTasks.length) {
      body.append(
        card(
          "No tasks run yet",
          "Run a request above or type /task <request> in the home composer to view steps, previews, and approvals here.",
          null,
          "checklist",
        ),
      );
    } else {
      for (const task of agentTasks) {
        const box = element("article", null, "card detail agent-task");
        const top = element("div", null, "agent-task-head");
        const titleWrap = element("div");
        titleWrap.append(
          element("h2", task.prompt),
          element(
            "p",
            `Intent: ${task.intent.replace(/_/g, " ")} · ${new Date(task.createdAt).toLocaleString()}`,
            "agent-meta",
          ),
        );
        const badge = element(
          "span",
          task.state.replace(/_/g, " "),
          `agent-badge agent-badge-${task.state}`,
        );
        top.append(titleWrap, badge);
        box.append(top);

        if (task.summary) {
          box.append(element("p", task.summary, "agent-summary"));
        }

        if (task.steps?.length) {
          const list = element("ol", null, "agent-steps");
          for (const step of task.steps) {
            const li = element("li", null, "agent-step");
            const sHead = element("div", null, "agent-step-head");
            sHead.append(
              element("strong", step.title),
              element(
                "span",
                `${step.riskLevel} · ${step.state.replace(/_/g, " ")}`,
                `agent-step-state agent-step-${step.state}`,
              ),
            );
            li.append(sHead);
            if (step.toolName) {
              li.append(
                element("p", `Tool: ${step.toolName}`, "agent-step-detail"),
              );
            }
            if (step.errorMessage) {
              li.append(
                element("p", step.errorMessage, "agent-step-error"),
              );
            } else if (step.output?.status === "saved" && step.output?.verified) {
              li.append(
                element(
                  "p",
                  `Verified: ${step.output.rootId}/${step.output.fileName} (${step.output.sizeBytes} bytes)`,
                  "agent-step-detail",
                ),
              );
            } else if (typeof step.output?.movedCount === "number") {
              li.append(
                element(
                  "p",
                  `Organized ${step.output.movedCount} file(s)${step.output.destination ? ` in ${step.output.destination}` : ""}`,
                  "agent-step-detail",
                ),
              );
            } else if (step.output?.status === "created" && step.output?.directoryName) {
              li.append(
                element(
                  "p",
                  `Created folder: ${step.output.rootId}/${step.output.directoryName}`,
                  "agent-step-detail",
                ),
              );
            }
            list.append(li);
          }
          box.append(list);
        }

        if (task.preview) {
          const details = element("details", null, "agent-preview-wrap");
          details.open = task.state === "awaiting_approval";
          const pre = element("pre", task.preview, "agent-preview");
          pre.tabIndex = 0;
          pre.setAttribute("role", "region");
          pre.setAttribute("aria-label", "Report preview");
          details.append(element("summary", "Report preview"), pre);
          box.append(details);
        }

        const pendingApproval =
          (task.approvals || []).find((a) => a.state === "pending") ||
          agentApprovals.find(
            (a) => a.taskId === task.id && a.state === "pending",
          );

        if (pendingApproval) {
          const appBox = element("div", null, "agent-approval-inline");
          appBox.append(
            element(
              "strong",
              `Approval required: ${pendingApproval.toolName} (${pendingApproval.riskLevel})`,
            ),
            element(
              "p",
              `Target: ${(pendingApproval.targetIds || []).join(", ")}`,
            ),
            element("p", pendingApproval.preview),
          );
          const btns = element("div", null, "agent-actions");
          const approveBtn = makeButton("Approve & run", () =>
            handleApprovalDecision(pendingApproval.id, "approve"),
          );
          approveBtn.className = "biz-primary";
          approveBtn.disabled = agentBusy;
          const rejectBtn = makeButton("Reject", () =>
            handleApprovalDecision(pendingApproval.id, "reject"),
          );
          rejectBtn.className = "biz-remove";
          rejectBtn.disabled = agentBusy;
          btns.append(approveBtn, rejectBtn);
          appBox.append(btns);
          box.append(appBox);
        }

        const controls = element("div", null, "agent-actions");
        if (task.state === "running") {
          const pauseBtn = makeButton("Pause", () =>
            controlAgentTask(task.id, "pause"),
          );
          pauseBtn.disabled = agentBusy;
          controls.append(pauseBtn);
        }
        if (task.state === "paused") {
          const resumeBtn = makeButton("Resume", () =>
            controlAgentTask(task.id, "resume"),
          );
          resumeBtn.className = "biz-primary";
          resumeBtn.disabled = agentBusy;
          controls.append(resumeBtn);
        }
        if (
          ["created", "planning", "running", "paused", "awaiting_approval"].includes(
            task.state,
          )
        ) {
          const cancelBtn = makeButton("Cancel task", () =>
            controlAgentTask(task.id, "cancel"),
          );
          cancelBtn.className = "biz-remove";
          cancelBtn.disabled = agentBusy;
          controls.append(cancelBtn);
        }
        if (controls.children.length) box.append(controls);

        body.append(box);
      }
    }
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
  } else if (current === "files") {
    const local = files && !files.hosted && files.enabled;
    if (!local)
      body.append(
        card(
          !snapshot
            ? "Device status unavailable"
            : files.hosted
              ? "No paired computer"
              : "Local file search disabled",
          files?.hosted
            ? "Run the Windows edition on your PC to search authorized folders."
            : "Enable authorized file roots in the Windows edition to use file search.",
          link("help", "Setup guidance"),
          "monitor",
        ),
      );
  } else if (current === "devices") {
    const comp = companionState;
    const hostedMode = Boolean(snapshot?.files?.hosted || comp?.hosted);
    const headerCard = element("article", null, "card detail");
    const headRow = element("div", null, "agent-task-head");
    const headInfo = element("div");
    headInfo.append(
      icon("monitor"),
      element(
        "h2",
        hostedMode
          ? "Hosted Workspace — Local PC Control Disabled"
          : comp?.paired
            ? comp.device?.deviceName || "Paired Windows Computer"
            : comp?.securityState === "revoked"
              ? "Windows Companion Revoked (Emergency Stop)"
              : "Windows Companion Not Paired",
      ),
      element(
        "p",
        hostedMode
          ? "Hosted deployments never assume access to your personal computer. Run EDITH locally on Windows to pair your PC."
          : comp?.paired
            ? `Device: ${comp.device?.hostname || "localhost"} (${comp.device?.platform || "win32"}) · Channel: 127.0.0.1 HMAC + Scoped Capability Token · Daemon PID ${comp.daemon?.pid ?? "n/a"}`
            : "Explicitly pair this local Windows computer to enable live CPU/RAM/disk monitoring, approved app launching, duplicate analysis, and reversible file organization.",
        "agent-meta",
      ),
    );
    const stateLabel = hostedMode
      ? "Hosted disabled"
      : comp?.paired
        ? "Paired · Local HMAC"
        : comp?.securityState === "revoked"
          ? "Revoked"
          : "Not paired";
    const secBadge = element(
      "span",
      stateLabel,
      `agent-badge ${comp?.paired ? "" : comp?.securityState === "revoked" || hostedMode ? "agent-badge-rejected" : "agent-badge-paused"}`.trim(),
    );
    headRow.append(headInfo, secBadge);
    headerCard.append(headRow);

    if (companionError) {
      const errP = element("p", companionError, "biz-status biz-status-error");
      errP.setAttribute("role", "alert");
      headerCard.append(errP);
    }

    if (!hostedMode) {
      const btnRow = element("div", null, "agent-actions");
      if (!comp?.paired) {
        if (!companionPairing) {
          const startBtn = makeButton(
            companionBusy ? "Starting…" : "Start pairing",
            startCompanionPairing,
          );
          startBtn.className = "biz-primary";
          startBtn.disabled = companionBusy;
          btnRow.append(startBtn);
        }
      } else {
        const refreshBtn = makeButton("Refresh telemetry", () =>
          refreshCompanionState({ includeTelemetry: true }),
        );
        refreshBtn.className = "biz-secondary";
        refreshBtn.disabled = companionBusy;
        const disconnectBtn = makeButton("Disconnect", disconnectCompanion);
        disconnectBtn.className = "biz-secondary";
        disconnectBtn.disabled = companionBusy;
        const stopBtn = makeButton("Emergency Stop", triggerEmergencyStop);
        stopBtn.className = "device-danger-btn";
        stopBtn.disabled = companionBusy;
        btnRow.append(refreshBtn, disconnectBtn, stopBtn);
      }
      headerCard.append(btnRow);

      if (companionPairing && !comp?.paired) {
        const pairBox = element("form", null, "device-pair-box");
        pairBox.append(
          element("strong", "Verify local device pairing code"),
          element(
            "p",
            `One-time pairing code: ${companionPairing.pairingCode} (${companionPairing.hostname} · ${companionPairing.platform})`,
          ),
        );
        const nameLabel = element("label", "Device display name", "agent-label");
        nameLabel.setAttribute("for", "companion-device-name");
        const nameInput = element("input", null, "agent-input");
        nameInput.id = "companion-device-name";
        nameInput.value = companionPairing.suggestedDeviceName || "";
        nameInput.maxLength = 80;
        const pairActions = element("div", null, "agent-actions");
        const confirmBtn = element("button", "Confirm & pair this PC", "biz-primary");
        confirmBtn.type = "submit";
        confirmBtn.disabled = companionBusy;
        const cancelBtn = makeButton("Cancel pairing", () => {
          companionPairing = null;
          renderPage();
        });
        pairActions.append(confirmBtn, cancelBtn);
        pairBox.append(nameLabel, nameInput, pairActions);
        pairBox.onsubmit = async (ev) => {
          ev.preventDefault();
          await completeCompanionPairing(nameInput.value.trim());
        };
        headerCard.append(pairBox);
      }
    }
    body.append(headerCard);

    if (companionPendingApproval) {
      const appBanner = element("article", null, "card detail agent-approval-inline");
      appBanner.append(
        element(
          "h2",
          `Confirmation required: ${companionPendingApproval.label || "Companion action"}`,
        ),
        element("p", companionPendingApproval.preview || ""),
      );
      const actBtns = element("div", null, "agent-actions");
      const okBtn = makeButton("Approve & execute", () =>
        resolveCompanionApproval(companionPendingApproval.approvalId, "approve"),
      );
      okBtn.className = "biz-primary";
      okBtn.disabled = companionBusy;
      const noBtn = makeButton("Reject", () =>
        resolveCompanionApproval(companionPendingApproval.approvalId, "reject"),
      );
      noBtn.className = "biz-remove";
      noBtn.disabled = companionBusy;
      actBtns.append(okBtn, noBtn);
      appBanner.append(actBtns);
      body.append(appBanner);
    }

    if (comp?.paired && !hostedMode) {
      // Telemetry summary cards
      const telemetryCard = element("article", null, "card detail");
      telemetryCard.append(
        icon("pulse"),
        element("h2", "Live Windows Telemetry"),
      );
      if (!comp.permissions?.telemetry) {
        telemetryCard.append(
          element(
            "p",
            "Telemetry permission is currently disabled in Capability Permissions below.",
            "agent-meta",
          ),
        );
      } else if (!companionTelemetry?.metrics) {
        telemetryCard.append(
          element("p", "Loading Windows CPU, RAM, storage, and battery metrics…", "agent-meta"),
        );
      } else {
        const m = companionTelemetry.metrics;
        const grid = element("div", null, "device-grid");

        const makeMeter = (title, mainVal, subText, pct) => {
          const tile = element("div", null, "device-metric");
          tile.append(
            element("span", title, "device-metric-label"),
            element("strong", mainVal, "device-metric-val"),
            element("p", subText, "device-metric-sub"),
          );
          if (typeof pct === "number") {
            const bar = element("div", null, "device-bar");
            bar.setAttribute("role", "progressbar");
            bar.setAttribute("aria-label", `${title} utilization`);
            bar.setAttribute("aria-valuemin", "0");
            bar.setAttribute("aria-valuemax", "100");
            bar.setAttribute("aria-valuenow", String(Math.round(pct)));
            const fill = element("span", null, "device-bar-fill");
            fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
            bar.append(fill);
            tile.append(bar);
          }
          return tile;
        };

        grid.append(
          makeMeter(
            "CPU utilization",
            `${m.cpu.cpuPercent}%`,
            `${m.cpu.cpuCores} logical cores · ${m.cpu.cpuModel}`,
            m.cpu.cpuPercent,
          ),
          makeMeter(
            "Memory (RAM)",
            `${m.memory.usedGb} / ${m.memory.totalGb} GB`,
            `${m.memory.usedPercent}% used · ${m.memory.freeGb} GB available`,
            m.memory.usedPercent,
          ),
          makeMeter(
            "Battery",
            m.battery.supported ? `${m.battery.percent}%` : "AC / N/A",
            m.battery.status,
            m.battery.supported ? m.battery.percent : undefined,
          ),
        );
        for (const d of m.drives || []) {
          grid.append(
            makeMeter(
              `Drive ${d.drive} (${d.label})`,
              `${d.freeGb} GB free`,
              `${d.totalGb} GB total · ${d.usedPercent}% used`,
              d.usedPercent,
            ),
          );
        }
        telemetryCard.append(grid);
      }
      body.append(telemetryCard);

      // Running processes card
      if (comp.permissions?.telemetry && companionTelemetry?.processes?.processes) {
        const procCard = element("article", null, "card detail");
        const pHead = element("div", null, "agent-task-head");
        pHead.append(element("h2", "Top Running Processes"));
        const sortBtns = element("div", null, "agent-actions");
        const ramBtn = makeButton("Sort by RAM", () => {
          processSort = "memory";
          refreshCompanionState({ includeTelemetry: true });
        });
        ramBtn.className = processSort === "memory" ? "biz-primary" : "biz-secondary";
        const cpuBtn = makeButton("Sort by CPU", () => {
          processSort = "cpu";
          refreshCompanionState({ includeTelemetry: true });
        });
        cpuBtn.className = processSort === "cpu" ? "biz-primary" : "biz-secondary";
        sortBtns.append(ramBtn, cpuBtn);
        pHead.append(sortBtns);
        procCard.append(pHead);

        const wrap = element("div", null, "device-table-wrap");
        wrap.tabIndex = 0;
        wrap.setAttribute("role", "region");
        wrap.setAttribute("aria-label", "Top running Windows processes");
        const table = element("table", null, "device-table");
        table.innerHTML =
          "<thead><tr><th scope='col'>Process</th><th scope='col'>PID</th><th scope='col'>Memory</th><th scope='col'>CPU Time</th></tr></thead>";
        const tbody = element("tbody");
        for (const p of companionTelemetry.processes.processes) {
          const tr = element("tr");
          tr.append(
            element("td", p.name),
            element("td", String(p.pid)),
            element("td", `${p.memoryMb} MB`),
            element("td", `${p.cpuSeconds}s`),
          );
          tbody.append(tr);
        }
        table.append(tbody);
        wrap.append(table);
        procCard.append(wrap);
        body.append(procCard);
      }

      // Approved apps & Capability permissions cards
      const appsCard = element("article", null, "card detail");
      appsCard.append(
        icon("spark"),
        element("h2", "Approved Applications"),
        element(
          "p",
          "Curated allowlist only. Launching any application requires explicit confirmation.",
          "agent-meta",
        ),
      );
      const appsList = element("ul", null, "agent-tools-list");
      for (const app of comp.approvedApps || []) {
        const li = element("li", null, "agent-tool-item device-app-row");
        const left = element("div");
        left.append(
          element("strong", `${app.displayName} (${app.category})`),
          element(
            "p",
            `${app.installed ? "Installed" : "Not detected"} · ${app.enabled ? "Enabled" : "Disabled"}`,
            "agent-step-detail",
          ),
        );
        const right = element("div", null, "device-app-controls");
        const toggleId = `app-enable-${app.appId}`;
        const chkWrap = element("label", null, "biz-day-chip");
        chkWrap.setAttribute("for", toggleId);
        const chk = element("input");
        chk.type = "checkbox";
        chk.id = toggleId;
        chk.checked = app.enabled;
        chk.disabled = companionBusy;
        chk.onchange = () => {
          const disabledSet = new Set(comp.disabledApps || []);
          if (chk.checked) disabledSet.delete(app.appId);
          else disabledSet.add(app.appId);
          updateCompanionPermissions({ disabledApps: [...disabledSet] });
        };
        chkWrap.append(chk, element("span", "Allowed"));

        const launchBtn = makeButton("Launch", () =>
          requestCompanionConfirmedAction(
            `/api/companion/apps/${encodeURIComponent(app.appId)}/launch`,
            `Launch ${app.displayName}`,
          ),
        );
        launchBtn.disabled =
          companionBusy || !app.installed || !app.enabled || !comp.permissions?.apps;
        right.append(chkWrap, launchBtn);
        li.append(left, right);
        appsList.append(li);
      }
      appsCard.append(appsList);
      body.append(appsCard);

      const permCard = element("article", null, "card detail");
      permCard.append(
        icon("shield"),
        element("h2", "Capability Permissions"),
        element(
          "p",
          "Toggle local capability scopes enforced by both the backend PolicyEngine and the loopback companion daemon.",
          "agent-meta",
        ),
      );
      const permGrid = element("div", null, "device-perm-list");
      for (const [scopeKey, scopeLabel] of [
        ["telemetry", "System telemetry & running processes"],
        ["apps", "Approved application discovery & launching"],
        ["fileAnalysis", "Large file & SHA-256 duplicate scanning (read-only)"],
        ["fileMutations", "Confirmed reversible file changes (rename, move, copy, mkdir, Recycle Bin)"],
      ]) {
        const pId = `perm-scope-${scopeKey}`;
        const rowLabel = element("label", null, "biz-day-chip");
        rowLabel.setAttribute("for", pId);
        const cb = element("input");
        cb.type = "checkbox";
        cb.id = pId;
        cb.checked = Boolean(comp.permissions?.[scopeKey]);
        cb.disabled = companionBusy;
        cb.onchange = () =>
          updateCompanionPermissions({ scopes: { [scopeKey]: cb.checked } });
        rowLabel.append(cb, element("span", scopeLabel));
        permGrid.append(rowLabel);
      }
      permCard.append(permGrid);
      body.append(permCard);
    }

    // Reversible actions & undo card (shown whenever local)
    if (!hostedMode) {
      const undoCard = element("article", null, "card detail");
      undoCard.append(
        icon("checklist"),
        element("h2", "Reversible Actions & Undo History"),
      );
      const revList = comp?.reversibleActions || [];
      if (!revList.length) {
        undoCard.append(
          element("p", "No reversible file actions recorded for this account yet.", "agent-meta"),
        );
      } else {
        const ul = element("ul", null, "agent-tools-list");
        for (const act of revList) {
          const li = element("li", null, "agent-tool-item device-app-row");
          const left = element("div");
          left.append(
            element("strong", act.summary),
            element(
              "p",
              `${act.actionType.replace(/_/g, " ")} · ${new Date(act.createdAt).toLocaleString()} · Status: ${act.status.replace(/_/g, " ")}`,
              "agent-step-detail",
            ),
          );
          const right = element("div", null, "device-app-controls");
          if (act.undoAvailable && act.status === "available" && comp?.paired) {
            const undoBtn = makeButton("Undo action", () =>
              requestCompanionConfirmedAction(
                `/api/companion/undo/${encodeURIComponent(act.id)}`,
                `Undo: ${act.summary}`,
              ),
            );
            undoBtn.className = "biz-secondary";
            undoBtn.disabled = companionBusy;
            right.append(undoBtn);
          } else {
            right.append(
              element(
                "span",
                act.status.replace(/_/g, " "),
                `agent-badge agent-badge-${act.status === "undone" ? "completed" : "paused"}`,
              ),
            );
          }
          li.append(left, right);
          ul.append(li);
        }
        undoCard.append(ul);
      }
      body.append(undoCard);

      const historyCard = element("article", null, "card detail");
      historyCard.append(
        icon("clock"),
        element("h2", "Recent Device Actions & Connection History"),
      );
      const events = comp?.recentActions || [];
      if (events.length) {
        const evList = element("ul", null, "agent-tools-list");
        for (const ev of events.slice(0, 12)) {
          const li = element("li", null, "agent-tool-item");
          li.append(
            element("strong", ev.summary),
            element(
              "p",
              `${ev.eventType.replace(/_/g, " ")}${ev.toolName ? ` · ${ev.toolName}` : ""} · ${new Date(ev.createdAt).toLocaleString()}`,
              "agent-step-detail",
            ),
          );
          evList.append(li);
        }
        historyCard.append(evList);
      } else {
        historyCard.append(element("p", "No companion device actions recorded yet.", "agent-meta"));
      }
      const conns = comp?.connectionHistory || [];
      if (conns.length) {
        const connTitle = element("h3", "Device Connection History", "device-subhead");
        const cList = element("ul", null, "agent-tools-list");
        for (const c of conns.slice(0, 8)) {
          const li = element("li", null, "agent-tool-item");
          li.append(
            element("strong", `${c.deviceName} (${c.hostname} · ${c.platform})`),
            element(
              "p",
              `State: ${c.state} · Paired: ${new Date(c.pairedAt).toLocaleString()}${c.disconnectedAt ? ` · Closed: ${new Date(c.disconnectedAt).toLocaleString()}` : ""}`,
              "agent-step-detail",
            ),
          );
          cList.append(li);
        }
        historyCard.append(connTitle, cList);
      }
      body.append(historyCard);
    }
  } else if (current === "calendar") {
    const biz = snapshot?.business;
    const user = snapshot?.user;
    const summary = element("article", null, "card detail biz-summary");
    summary.append(
      icon("calendar"),
      element(
        "h2",
        user
          ? `${biz.name} — Services & Contacts`
          : "Front Desk & Company Services",
      ),
      element(
        "p",
        biz
          ? `${biz.address}${
              formatContactParts(biz.contact).length
                ? ` · Primary contact: ${formatContactParts(biz.contact).join(" · ")}`
                : ""
            }`
          : "Loading company details…",
      ),
    );
    if (biz?.services?.length) {
      const list = element("ul", null, "biz-summary-list");
      for (const svc of biz.services) {
        const item = element("li", null, "biz-summary-item");
        const top = element("div", null, "biz-summary-top");
        top.append(
          element("strong", svc.name),
          element("span", `${formatPrice(svc.price, biz)} · ${svc.minutes} min`),
        );
        const contact = effectiveServiceContact(svc, biz);
        const parts = formatContactParts(contact);
        const contactLine = element(
          "p",
          parts.length
            ? `Personal contact: ${parts.join(" · ")}`
            : "Personal contact: Not set",
          "biz-summary-contact",
        );
        item.append(top, contactLine);
        list.append(item);
      }
      summary.append(list);
    }
    const actions = element("div", null, "biz-summary-actions");
    const deskLink = element("a", "Open Front Desk");
    deskLink.href = "/desk";
    const setupLink = link(
      "settings",
      user ? "Edit company & services" : "Set up your company",
    );
    actions.append(deskLink, setupLink);
    summary.append(actions);
    body.append(summary);

    const bookingsCard = element("article", null, "card detail biz-summary");
    const bookings = snapshot?.bookings || [];
    bookingsCard.append(
      icon("checklist"),
      element(
        "h2",
        bookings.length
          ? `Confirmed appointments (${bookings.length})`
          : "No appointments booked yet",
      ),
      element(
        "p",
        bookings.length
          ? "Appointments booked on your Front Desk appear below."
          : "Bookings made through your Front Desk calendar will appear here.",
      ),
    );
    if (bookings.length) {
      const bList = element("ul", null, "biz-summary-list");
      for (const b of bookings) {
        const item = element("li", null, "biz-summary-item");
        const top = element("div", null, "biz-summary-top");
        top.append(
          element("strong", `${b.service} — ${b.name}`),
          element(
            "span",
            `${b.date} · ${b.time} ${b.timezone} · ${formatPrice(b.price, { locale: biz?.locale, currency: b.currency || biz?.currency })}`,
          ),
        );
        item.append(top);
        const cParts = formatContactParts(b.contact);
        if (cParts.length) {
          item.append(
            element(
              "p",
              `Service contact: ${cParts.join(" · ")}`,
              "biz-summary-contact",
            ),
          );
        }
        bList.append(item);
      }
      bookingsCard.append(bList);
    }
    body.append(bookingsCard);
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
    if (current === "skills" && agentTools.length) {
      const toolsCard = element("article", null, "card detail");
      toolsCard.append(
        icon("spark"),
        element("h2", `Registered agent tools (${agentTools.length})`),
        element(
          "p",
          "All tools are validated with AJV schemas, evaluated by PolicyEngine, and executed with voice/text authorization parity.",
        ),
      );
      const list = element("ul", null, "agent-tools-list");
      for (const tool of agentTools) {
        const li = element("li", null, "agent-tool-item");
        const head = element("div", null, "agent-step-head");
        head.append(
          element("strong", `${tool.name} (${tool.id})`),
          element(
            "span",
            `${tool.riskLevel} · ${tool.requiresConfirmation ? "Approval required" : "Auto-allowed"} · ${Math.round(tool.timeoutMs / 1000)}s`,
            "agent-badge",
          ),
        );
        li.append(head, element("p", tool.description, "agent-step-detail"));
        list.append(li);
      }
      toolsCard.append(list);
      body.append(toolsCard);
    }
  } else if (current === "permissions") {
    const pendingList = agentApprovals.filter((a) => a.state === "pending");
    const recentList = agentApprovals
      .filter((a) => a.state !== "pending")
      .slice(0, 5);
    if (pendingList.length) {
      for (const app of pendingList) {
        const appCard = element("article", null, "card detail agent-approval-card");
        appCard.append(
          icon("shield"),
          element("h2", `Pending approval: ${app.toolName}`),
          element("p", app.preview),
          element(
            "p",
            `Risk: ${app.riskLevel} · ${app.reversible ? "Reversible" : "Non-reversible"} · Targets: ${(app.targetIds || []).join(", ")}`,
            "agent-meta",
          ),
          element("p", `Reason: ${app.reason}`, "agent-step-detail"),
          element(
            "p",
            `Expires: ${new Date(app.expiresAt).toLocaleTimeString()}`,
            "agent-step-detail",
          ),
        );
        const btns = element("div", null, "agent-actions");
        const approveBtn = makeButton("Approve", () =>
          handleApprovalDecision(app.id, "approve"),
        );
        approveBtn.className = "biz-primary";
        approveBtn.disabled = agentBusy;
        const rejectBtn = makeButton("Reject", () =>
          handleApprovalDecision(app.id, "reject"),
        );
        rejectBtn.className = "biz-remove";
        rejectBtn.disabled = agentBusy;
        btns.append(approveBtn, rejectBtn);
        appCard.append(btns);
        body.append(appCard);
      }
    } else {
      body.append(
        card(
          "No pending agent approvals",
          "Reversible or write operations (such as saving a report) appear here for explicit approval before executing.",
          link("tasks", "Open Task Center"),
          "shield",
        ),
      );
    }
    if (recentList.length) {
      const historyCard = element("article", null, "card detail");
      historyCard.append(
        icon("clock"),
        element("h2", "Recent approval decisions"),
      );
      const ul = element("ul", null, "agent-tools-list");
      for (const item of recentList) {
        const li = element("li", null, "agent-tool-item");
        const head = element("div", null, "agent-step-head");
        head.append(
          element("strong", `${item.toolName} (${(item.targetIds || []).join(", ")})`),
          element("span", item.state, `agent-badge agent-badge-${item.state}`),
        );
        li.append(head);
        ul.append(li);
      }
      historyCard.append(ul);
      body.append(historyCard);
    }
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
    const bizCard = element("article", null, "card detail");
    if (snapshot) {
      mountBusinessEditor(bizCard, {
        getState: () => snapshot,
        onStateChange: (next) => applyWorkspaceState(next, { fromEditor: true }),
        mode: "workspace",
      });
    } else {
      bizCard.append(
        element("h2", "Company & services setup"),
        element("p", "Loading account and company settings…"),
      );
    }
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
      bizCard,
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
function route(focus = false, { fromInit = false } = {}) {
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
  if (snapshot && current === "devices" && !detail) {
    refreshCompanionState({ includeTelemetry: Boolean(companionState?.paired) });
  }
  if (snapshot && !fromInit && current === "knowledge" && !detail) {
    refreshKnowledgeState();
  }
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
function updateWorkspaceBadge() {
  const badge = document.querySelector(".workspace-link");
  if (!badge || !snapshot) return;
  const user = snapshot.user;
  const biz = snapshot.business;
  const initialEl = badge.querySelector("b");
  const titleWrap = badge.querySelector("span");
  const subEl = badge.querySelector("small");
  const labelText = user ? biz.name : "Personal workspace";
  if (initialEl) initialEl.textContent = Array.from(labelText)[0] || "E";
  if (titleWrap && titleWrap.firstChild?.nodeType === Node.TEXT_NODE) {
    titleWrap.firstChild.nodeValue = labelText;
  }
  if (subEl) subEl.textContent = user ? user.email : "Workspace settings";
}

function connectWorkspaceEvents() {
  eventStream?.close();
  eventStream = new EventSource("/api/events");
  eventStream.addEventListener("business", (event) => {
    applyWorkspaceState(JSON.parse(event.data));
  });
  eventStream.addEventListener("agentTask", (event) => {
    const task = JSON.parse(event.data);
    upsertTask(task);
    if (current === "tasks") renderPage();
  });
  eventStream.addEventListener("agentApproval", (event) => {
    const approval = JSON.parse(event.data);
    upsertApproval(approval);
    log(`Approval ${approval.state}: ${approval.toolName}`);
    if (["tasks", "permissions"].includes(current)) renderPage();
  });
  eventStream.addEventListener("companionStatus", (event) => {
    companionState = JSON.parse(event.data);
    updateDeviceStatusChip();
    if (current === "devices") renderPage();
  });
  eventStream.addEventListener("knowledgeUpdated", () => {
    refreshKnowledgeState();
  });
  eventStream.addEventListener("booking", (event) => {
    const b = JSON.parse(event.data);
    if (snapshot && !snapshot.bookings.some((x) => x.id === b.id)) {
      snapshot.bookings.push(b);
      if (current === "calendar") renderPage();
    }
  });
  eventStream.addEventListener("bookings", (event) => {
    if (snapshot) {
      snapshot.bookings = JSON.parse(event.data);
      if (current === "calendar") renderPage();
    }
  });
  if (snapshot?.files?.enabled && !snapshot?.files?.hosted) {
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
}

async function applyWorkspaceState(next, { fromEditor = false } = {}) {
  const prevUserId = snapshot?.user?.id || null;
  if (next.csrfToken) setCsrfToken(next.csrfToken);
  snapshot = { ...snapshot, ...next };
  if ("user" in next) snapshot.user = next.user;
  if ("business" in next) snapshot.business = next.business;
  if ("bookings" in next) snapshot.bookings = next.bookings;
  if ("today" in next) snapshot.today = next.today;
  if ("maxDate" in next) snapshot.maxDate = next.maxDate;
  const nextUserId = snapshot?.user?.id || null;
  if (prevUserId !== nextUserId) {
    connectWorkspaceEvents();
    refreshAgentState({ includeTools: false });
    refreshCompanionState({ includeTelemetry: false });
    refreshKnowledgeState();
    log(nextUserId ? `Signed in (${snapshot.business.name})` : "Signed out");
  } else if (fromEditor) {
    log("Updated company & services");
  }
  updateWorkspaceBadge();
  if (!fromEditor || current !== "settings") {
    if (!["home", "voice"].includes(current)) renderPage();
  }
}

async function init() {
  try {
    const res = await fetch("/api/state");
    if (!res.ok) throw new Error();
    snapshot = await res.json();
    setCsrfToken(snapshot.csrfToken);
    updateWorkspaceBadge();
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
    connectWorkspaceEvents();
    refreshAgentState({ includeTools: true });
    refreshCompanionState({ includeTelemetry: false });
    if (window.location.pathname === "/app/knowledge") {
      await refreshKnowledgeState({ render: false });
    } else {
      refreshKnowledgeState();
    }
  } catch {
    loadError = "The workspace could not connect. Reload to retry.";
    errorMessage(loadError);
    $("provider-status").textContent = $("device-status").textContent =
      "Unavailable";
  }
  route(false, { fromInit: true });
  updateControls();
}
window.addEventListener("pagehide", () => {
  if (mode) session.end();
  eventStream?.close();
});
init();
