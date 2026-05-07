const form = document.querySelector("#chatForm");
const input = document.querySelector("#messageInput");
const sendButton = document.querySelector("#sendButton");
const messages = document.querySelector("#messages");
const statusText = document.querySelector("#statusText");
const specDetails = document.querySelector("#specDetails");
const missingFields = document.querySelector("#missingFields");
const conversationIdBadge = document.querySelector("#conversationIdBadge");
const contextWindowBadge = document.querySelector("#contextWindowBadge");
const metricsSummary = document.querySelector("#metricsSummary");
const metricsUpdatedAt = document.querySelector("#metricsUpdatedAt");
const newConversationButton = document.querySelector("#newConversationButton");

const conversationKey = "app-builder-chatbot-conversation-id";
const metricsRefreshIntervalMs = 5000;
const defaultContextWindowMaxTokens = 200000;
const defaultContextWindowWarningRatio = 0.8;
const defaultContextWindowBlockRatio = 0.95;
const userId = "local-user";
let conversationId = localStorage.getItem(conversationKey) || createConversationId();
let contextWindowMaxTokens = defaultContextWindowMaxTokens;
let contextWindowModelId = null;
let contextWindowWarningRatio = defaultContextWindowWarningRatio;
let contextWindowBlockRatio = defaultContextWindowBlockRatio;
let contextWindowStatus = "ok";
let runtimeMetadataAvailable = false;
let serverContextWindow = null;
let requestInFlight = false;
let currentStatus = "collecting_requirements";
let currentAppSpec = {};
let currentMissingFields = [];

localStorage.setItem(conversationKey, conversationId);
conversationIdBadge.textContent = shortId(conversationId);
renderEmptyConversation();
loadRuntimeInfo();
loadConversation();
loadMetrics();
setInterval(loadMetrics, metricsRefreshIntervalMs);

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!canSendMessage()) {
    input.focus();
    return;
  }

  const text = input.value.trim();
  if (!text) {
    return;
  }

  serverContextWindow = null;
  addMessage("user", text);
  input.value = "";
  setLoading(true);

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, userId, message: text })
    });

    if (!response.ok) {
      throw new Error("Request failed");
    }

    const result = await response.json();
    renderConversationState(result);
    loadMetrics();
  } catch {
    setStatus("failed");
    addMessage("assistant", "I could not process that message. Check the server logs and try again.");
  } finally {
    setLoading(false);
    input.focus();
  }
});

newConversationButton.addEventListener("click", () => {
  conversationId = createConversationId();
  localStorage.setItem(conversationKey, conversationId);
  conversationIdBadge.textContent = shortId(conversationId);
  renderEmptyConversation();
  input.focus();
});

function createConversationId() {
  return `conv_${crypto.randomUUID()}`;
}

async function loadMetrics() {
  try {
    const response = await fetch("/api/metrics");

    if (!response.ok) {
      throw new Error("Request failed");
    }

    const metrics = await response.json();
    renderMetrics(metrics);
  } catch {
    renderMetricsUnavailable();
  }
}

async function loadRuntimeInfo() {
  try {
    const response = await fetch("/api/runtime");

    if (!response.ok) {
      throw new Error("Request failed");
    }

    const runtime = await response.json();
    contextWindowMaxTokens = Number(runtime.contextWindowTokens);
    contextWindowWarningRatio = Number(runtime.contextWindowWarningRatio) || contextWindowWarningRatio;
    contextWindowBlockRatio = Number(runtime.contextWindowBlockRatio) || contextWindowBlockRatio;
    contextWindowModelId = runtime.modelId || null;
    runtimeMetadataAvailable = true;
    updateContextWindowBadge();
  } catch {
    contextWindowMaxTokens = defaultContextWindowMaxTokens;
    contextWindowWarningRatio = defaultContextWindowWarningRatio;
    contextWindowBlockRatio = defaultContextWindowBlockRatio;
    contextWindowModelId = null;
    runtimeMetadataAvailable = false;
    updateContextWindowBadge();
  }
}

async function loadConversation() {
  try {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`);

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      throw new Error("Request failed");
    }

    const state = await response.json();
    renderConversationState(state);
  } catch {
    addMessage("assistant", "I could not reload the saved conversation. Start a new conversation if this looks out of date.");
  }
}

function renderConversationState(state) {
  conversationId = state.conversationId || conversationId;
  localStorage.setItem(conversationKey, conversationId);
  conversationIdBadge.textContent = shortId(conversationId);
  messages.replaceChildren();
  serverContextWindow = null;

  for (const message of state.messages || []) {
    addMessage(message.role, message.content);
  }

  setStatus(state.status);
  renderSpec(state.appSpec || {});
  renderMissing(state.missingFields || []);
  renderContextWindow(state.contextWindow);
}

function renderEmptyConversation() {
  serverContextWindow = null;
  messages.replaceChildren();
  setStatus("collecting_requirements");
  renderSpec({});
  renderMissing(null);
  addMessage("assistant", "Tell me what kind of app you want to build.");
}

function setStatus(status) {
  currentStatus = normalizeStatus(status);
  statusText.textContent = formatStatus(currentStatus);
  statusText.dataset.status = currentStatus;
  syncComposerState();
}

function renderContextWindow(contextWindow) {
  if (contextWindow) {
    serverContextWindow = contextWindow;
    contextWindowMaxTokens = Number(contextWindow.maxTokens) || contextWindowMaxTokens;
    runtimeMetadataAvailable = true;
  }

  updateContextWindowBadge();
}

function updateContextWindowBadge() {
  const contextWindow = getDisplayedContextWindow();
  contextWindowStatus = contextWindow.status;
  contextWindowBadge.textContent = `Ctx ~${formatTokenCount(contextWindow.usedTokens)} / ${formatTokenCount(contextWindow.maxTokens)}`;
  contextWindowBadge.title = buildContextWindowTitle(contextWindow);
  contextWindowBadge.classList.toggle("warning", contextWindow.status === "warning");
  contextWindowBadge.classList.toggle("blocked", contextWindow.status === "blocked");
  syncComposerState();
}

function getDisplayedContextWindow() {
  if (serverContextWindow) {
    return serverContextWindow;
  }

  const usedTokens = estimateContextUsageTokens();
  const maxTokens = Number(contextWindowMaxTokens);

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return {
      usedTokens,
      maxTokens,
      usedRatio: 0,
      status: "ok"
    };
  }

  const usedRatio = usedTokens / maxTokens;
  const status = usedRatio >= contextWindowBlockRatio ? "blocked" : usedRatio >= contextWindowWarningRatio ? "warning" : "ok";

  return {
    usedTokens,
    maxTokens,
    usedRatio,
    status
  };
}

function buildContextWindowTitle(contextWindow) {
  const maxTokens = Number(contextWindow.maxTokens);
  const modelText = contextWindowModelId ? ` for ${contextWindowModelId}` : "";

  if (!Number.isFinite(maxTokens) || maxTokens <= 0) {
    return `Estimated context used${modelText}. Configured max is unavailable.`;
  }

  const percent = ((contextWindow.usedTokens / maxTokens) * 100).toFixed(2);
  const statusText = contextWindow.status === "blocked" ? " Context is full; new model calls are paused." : contextWindow.status === "warning" ? " Context is near the configured limit." : "";
  const metadataText = runtimeMetadataAvailable ? "" : " Runtime metadata is unavailable, so the UI is using the default local max; restart the server or use a port with /api/runtime for backend-enforced limits.";
  return `Estimated context used / configured window${modelText}: ${contextWindow.usedTokens} / ${maxTokens} tokens (${percent}%).${statusText}${metadataText} Actual provider token accounting may differ.`;
}

function estimateContextUsageTokens() {
  const messageContents = Array.from(messages.children).map((message) => message.textContent || "");
  const contextPayload = {
    status: statusText.textContent,
    messages: messageContents,
    appSpec: currentAppSpec,
    missingFields: currentMissingFields
  };

  return estimateTokens(JSON.stringify(contextPayload));
}

function estimateTokens(text) {
  const characterCount = String(text || "").length;
  return Math.max(1, Math.ceil(characterCount / 4));
}

function formatTokenCount(value) {
  const tokens = Number(value);

  if (!Number.isFinite(tokens) || tokens <= 0) {
    return "-";
  }

  if (tokens >= 1000000) {
    return `${formatCompactNumber(tokens / 1000000)}M`;
  }

  if (tokens >= 1000) {
    return `${formatCompactNumber(tokens / 1000)}K`;
  }

  return String(tokens);
}

function formatCompactNumber(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function shortId(id) {
  return id.replace("conv_", "").slice(0, 8);
}

function setLoading(isLoading) {
  requestInFlight = isLoading;
  syncComposerState();
}

function syncComposerState() {
  const disabled = requestInFlight || !canSendMessage();
  sendButton.disabled = disabled;
  input.disabled = disabled;
}

function canSendMessage() {
  return contextWindowStatus !== "blocked" || currentStatus === "awaiting_confirmation";
}

function addMessage(role, content) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = content;
  messages.appendChild(node);
  messages.scrollTop = messages.scrollHeight;
  updateContextWindowBadge();
}

function renderSpec(spec) {
  currentAppSpec = spec;
  const rows = [
    ["Name", spec.appName],
    ["Purpose", spec.purpose],
    ["Type", spec.appType],
    ["Target", spec.deploymentTarget],
    ["Users", spec.targetUsers],
    ["Features", spec.coreFeatures],
    ["Entities", spec.dataEntities],
    ["Integrations", spec.integrations],
    ["Auth", formatBoolean(spec.authRequired)]
  ];

  specDetails.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const term = document.createElement("dt");
      term.textContent = label;
      const description = document.createElement("dd");
      description.textContent = formatValue(value);
      description.className = isEmptySpecValue(value) ? "empty" : "filled";
      return [term, description];
    })
  );
  updateContextWindowBadge();
}

function renderMissing(fields) {
  currentMissingFields = fields ?? [];

  if (!fields) {
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = "Not evaluated";
    missingFields.replaceChildren(item);
    updateContextWindowBadge();
    return;
  }

  if (fields.length === 0) {
    const item = document.createElement("li");
    item.className = "complete";
    item.textContent = "None";
    missingFields.replaceChildren(item);
    updateContextWindowBadge();
    return;
  }

  missingFields.replaceChildren(
    ...fields.map((field) => {
      const item = document.createElement("li");
      item.textContent = splitCamelCase(field);
      return item;
    })
  );
  updateContextWindowBadge();
}

function renderMetrics(metrics) {
  const turns = metrics.turns || {};
  const extractionFailures = metrics.extractionFailures || {};
  const confirmations = metrics.confirmations || {};
  const appCreation = metrics.appCreation || {};
  const decisions = confirmations.decisions || {};

  metricsUpdatedAt.textContent = formatMetricsUpdatedAt(metrics.generatedAt);
  renderMetricRows([
    {
      label: "Turns",
      value: `${formatWholeNumber(turns.started)} started / ${formatWholeNumber(turns.completed)} done / ${formatWholeNumber(turns.failed)} failed`
    },
    {
      label: "Extraction",
      value: `${formatWholeNumber(extractionFailures.total)} failures`,
      title: `${formatWholeNumber(extractionFailures.requestFailures)} request, ${formatWholeNumber(extractionFailures.structuredOutputFailures)} JSON, ${formatWholeNumber(extractionFailures.repairFailures)} repair`
    },
    {
      label: "Confirm",
      value: `${formatWholeNumber(decisions.yes)} yes / ${formatWholeNumber(decisions.no)} no / ${formatWholeNumber(decisions.ambiguous)} unclear`,
      title: `${formatWholeNumber(confirmations.requested)} confirmation prompts requested`
    },
    {
      label: "Creation",
      value: `${formatWholeNumber(appCreation.success)} created / ${formatWholeNumber(appCreation.failure)} failed`
    },
    {
      label: "Turn Latency",
      value: formatLatencySummary(turns.latencyMs)
    },
    {
      label: "Build Latency",
      value: formatLatencySummary(appCreation.latencyMs)
    }
  ]);
}

function renderMetricsUnavailable() {
  metricsUpdatedAt.textContent = "Unavailable";
  renderMetricRows([
    { label: "Turns", value: "-" },
    { label: "Extraction", value: "-" },
    { label: "Confirm", value: "-" },
    { label: "Creation", value: "-" }
  ]);
}

function renderMetricRows(rows) {
  metricsSummary.replaceChildren(
    ...rows.flatMap((row) => {
      const term = document.createElement("dt");
      term.textContent = row.label;
      const description = document.createElement("dd");
      description.textContent = row.value;
      if (row.title) {
        description.title = row.title;
      }
      return [term, description];
    })
  );
}

function formatValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "-";
  }

  if (value === null || value === undefined || value === "") {
    return "-";
  }

  return String(value);
}

function formatBoolean(value) {
  if (value === true) {
    return "Yes";
  }
  if (value === false) {
    return "No";
  }
  return null;
}

function formatWholeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number).toLocaleString() : "0";
}

function formatLatencySummary(summary) {
  if (!summary || !Number.isFinite(Number(summary.averageMs)) || Number(summary.count) === 0) {
    return "-";
  }

  return `${formatDurationMs(summary.averageMs)} avg`;
}

function formatDurationMs(value) {
  const milliseconds = Number(value);

  if (!Number.isFinite(milliseconds)) {
    return "-";
  }

  if (milliseconds >= 1000) {
    return `${(milliseconds / 1000).toFixed(1)} s`;
  }

  return `${Math.round(milliseconds)} ms`;
}

function formatMetricsUpdatedAt(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Updated -";
  }

  return `Updated ${date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

function formatStatus(status) {
  return splitCamelCase(normalizeStatus(status).replaceAll("_", " "));
}

function normalizeStatus(status) {
  return String(status || "collecting_requirements").trim().toLowerCase().replaceAll(" ", "_");
}

function isEmptySpecValue(value) {
  if (Array.isArray(value)) {
    return value.length === 0;
  }

  return value === null || value === undefined || value === "";
}

function splitCamelCase(value) {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}
