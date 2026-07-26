const PROFILE_DEFAULTS = Object.freeze({
  id: "",
  label: "Project profile",
  projectName: "",
  projectId: "",
  matchAnyProject: false,
  enabled: true,
  uploadEnabled: true,
  watchFolder: "",
  uploadPattern: ".*\\.(pdf|docx|xlsx|xls|csv|tsv|txt|md|pptx|png|jpe?g)$",
  promptText: "Please process the attached file.",
  autoSubmit: true,
  recursive: false,
  includeExisting: false,
  stableSeconds: 2,
  retrySeconds: 20,
  uploadDelayMs: 1500,
  maxFileBytes: 50 * 1024 * 1024,
  downloadEnabled: true,
  downloadPattern: ".*\\.(zip|pdf|docx|xlsx|xls|csv|tsv|pptx|txt|md)$",
  downloadSubfolder: "ChatGPT",
  downloadLastOnReload: false
});

const GLOBAL_DEFAULTS = Object.freeze({
  enabled: false,
  hostName: "com.local.chatgpt_folder_bridge",
  profiles: [],
  selectedProfileId: ""
});

const LEGACY_PROFILE_KEYS = [
  "watchFolder", "uploadPattern", "downloadPattern", "downloadSubfolder", "promptText",
  "autoSubmit", "recursive", "includeExisting", "stableSeconds", "retrySeconds",
  "uploadDelayMs", "maxFileBytes"
];

let nativePort = null;
let nativeConnectInProgress = false;
let nativeConnectionEpoch = 0;
let reconnectTimer = null;
let retryQueueTimer = null;
let nativeQueue = Promise.resolve();
let activeTransfer = null;
let pendingFiles = [];
let currentNativeProfileId = null;
let nativeReconfigurePending = false;
const tabProjects = new Map();
const requestedDownloads = new Set();
const pendingDownloadProfiles = new Map();
let lastStatus = {
  nativeConnected: false,
  message: "Not connected",
  lastFile: null,
  lastError: null,
  activeProject: null,
  activeProfile: null
};

function makeProfileId() {
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeProjectId(value) {
  const text = String(value || "").trim();
  const match = text.match(/(?:^|\/)(g-p-[^/?#]+)/i);
  if (match?.[1]) return match[1].toLowerCase();
  return /^g-p-[^/?#]+$/i.test(text) ? text.toLowerCase() : "";
}

function normalizeProjectName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function normalizeProject(project) {
  if (!project || typeof project !== "object") return null;
  const id = normalizeProjectId(project.id || project.projectId || project.href || "");
  const name = String(project.name || project.projectName || "").replace(/\s+/g, " ").trim();
  if (!id && !name) return null;
  return {
    id,
    name,
    href: String(project.href || ""),
    key: id || normalizeProjectName(name)
  };
}

function normalizeProfile(profile, index = 0) {
  const value = { ...PROFILE_DEFAULTS, ...(profile && typeof profile === "object" ? profile : {}) };
  value.id = String(value.id || makeProfileId());
  value.label = String(value.label || value.projectName || `Project profile ${index + 1}`).trim();
  value.projectName = String(value.projectName || "").replace(/\s+/g, " ").trim();
  value.projectId = normalizeProjectId(value.projectId);
  value.matchAnyProject = Boolean(value.matchAnyProject);
  value.enabled = Boolean(value.enabled);
  value.uploadEnabled = Boolean(value.uploadEnabled);
  value.downloadEnabled = Boolean(value.downloadEnabled);
  value.downloadLastOnReload = Boolean(value.downloadLastOnReload);
  value.autoSubmit = Boolean(value.autoSubmit);
  value.recursive = Boolean(value.recursive);
  value.includeExisting = Boolean(value.includeExisting);
  value.stableSeconds = Math.max(1, Number(value.stableSeconds) || PROFILE_DEFAULTS.stableSeconds);
  value.retrySeconds = Math.max(5, Number(value.retrySeconds) || PROFILE_DEFAULTS.retrySeconds);
  value.uploadDelayMs = Math.max(0, Number(value.uploadDelayMs) || 0);
  value.maxFileBytes = Math.max(1, Number(value.maxFileBytes) || PROFILE_DEFAULTS.maxFileBytes);
  return value;
}

function legacyProfileFromStorage(raw) {
  const hasLegacyValues = LEGACY_PROFILE_KEYS.some((key) => raw[key] !== undefined);
  return normalizeProfile({
    id: "legacy-default-profile",
    label: "Default (all projects)",
    projectName: "",
    projectId: "",
    matchAnyProject: true,
    ...Object.fromEntries(LEGACY_PROFILE_KEYS.map((key) => [key, raw[key] ?? PROFILE_DEFAULTS[key]]))
  }, 0, hasLegacyValues);
}

async function ensureSettings() {
  const raw = await chrome.storage.local.get(null);
  const profiles = Array.isArray(raw.profiles) && raw.profiles.length
    ? raw.profiles.map(normalizeProfile)
    : [legacyProfileFromStorage(raw)];
  const settings = {
    enabled: raw.enabled === undefined ? GLOBAL_DEFAULTS.enabled : Boolean(raw.enabled),
    hostName: String(raw.hostName || GLOBAL_DEFAULTS.hostName),
    profiles,
    selectedProfileId: String(raw.selectedProfileId || profiles[0]?.id || "")
  };

  const needsSave = !Array.isArray(raw.profiles) || !raw.profiles.length ||
    raw.enabled === undefined || raw.hostName === undefined || raw.selectedProfileId === undefined;
  if (needsSave) await chrome.storage.local.set(settings);
  return settings;
}

async function getSettings() {
  const raw = await chrome.storage.local.get(GLOBAL_DEFAULTS);
  const profiles = Array.isArray(raw.profiles) && raw.profiles.length
    ? raw.profiles.map(normalizeProfile)
    : [legacyProfileFromStorage(await chrome.storage.local.get(null))];
  return {
    enabled: Boolean(raw.enabled),
    hostName: String(raw.hostName || GLOBAL_DEFAULTS.hostName),
    profiles,
    selectedProfileId: String(raw.selectedProfileId || profiles[0]?.id || "")
  };
}

function resolveProfile(settings, project) {
  const profiles = settings.profiles.filter((profile) => profile.enabled);
  const normalized = normalizeProject(project);
  if (normalized?.id) {
    const byId = profiles.find((profile) => profile.projectId && profile.projectId === normalized.id);
    if (byId) return byId;
  }
  if (normalized?.name) {
    const wantedName = normalizeProjectName(normalized.name);
    const byName = profiles.find((profile) => profile.projectName && normalizeProjectName(profile.projectName) === wantedName);
    if (byName) return byName;
  }
  return profiles.find((profile) => profile.matchAnyProject) || null;
}

function getProfileById(settings, profileId) {
  return settings.profiles.find((profile) => profile.id === profileId) || null;
}

async function setStatus(patch) {
  lastStatus = { ...lastStatus, ...patch, updatedAt: new Date().toISOString() };
  await chrome.storage.session.set({ bridgeStatus: lastStatus });
}

function postNative(message, expectedPort = nativePort) {
  const port = expectedPort;
  if (!port || nativePort !== port) return false;
  try {
    port.postMessage(message);
    return true;
  } catch (error) {
    if (nativePort === port) {
      nativePort = null;
      activeTransfer = null;
      nativeConnectionEpoch += 1;
      nativeConnectInProgress = false;
      void setStatus({ nativeConnected: false, message: "Native host disconnected", lastError: String(error) });
      scheduleReconnect();
    }
    return false;
  }
}

function isChatGptUrl(url) {
  return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//i.test(String(url || ""));
}

async function getChatGptTabs() {
  return chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
}

const RUNTIME_VERSION_KEY = "bridgeRuntimeVersion";
let runtimeVersionCheck = null;

async function ensureRuntimeVersionAndReloadStaleTabs() {
  if (runtimeVersionCheck) return runtimeVersionCheck;
  runtimeVersionCheck = (async () => {
    const currentVersion = chrome.runtime.getManifest().version;
    const stored = await chrome.storage.local.get({ [RUNTIME_VERSION_KEY]: "" });
    const previousVersion = String(stored[RUNTIME_VERSION_KEY] || "");
    if (previousVersion === currentVersion) return { changed: false, currentVersion, previousVersion };

    await chrome.storage.local.set({ [RUNTIME_VERSION_KEY]: currentVersion });
    const tabs = await getChatGptTabs();
    await Promise.allSettled(tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) => chrome.tabs.reload(tab.id)));
    return { changed: true, currentVersion, previousVersion, reloadedTabs: tabs.length };
  })().finally(() => { runtimeVersionCheck = null; });
  return runtimeVersionCheck;
}

async function getActiveContentVersion() {
  const tab = await getActiveChatGptTab();
  if (!tab?.id) return { version: null, tabId: null, error: "No ChatGPT tab is open" };
  const expectedVersion = chrome.runtime.getManifest().version;
  try {
    const response = await sendToTab(tab.id, { type: "get_content_version" });
    const version = response?.version || null;
    if (version !== expectedVersion) {
      await chrome.tabs.reload(tab.id);
      return {
        version,
        tabId: tab.id,
        error: `Page script ${version || "unknown"} did not match extension ${expectedVersion}; the tab was reloaded`
      };
    }
    return { version, tabId: tab.id, error: response?.ok ? null : response?.error || null };
  } catch (error) {
    try { await chrome.tabs.reload(tab.id); } catch { /* tab may have closed */ }
    return { version: null, tabId: tab.id, error: `Page script check failed; the tab was reloaded: ${String(error?.message || error)}` };
  }
}


async function reinjectContentScriptsIntoOpenTabs() {
  const tabs = await getChatGptTabs();
  await Promise.allSettled(tabs
    .filter((tab) => Number.isInteger(tab.id))
    .map((tab) => injectContentScript(tab.id)));
}
async function getActiveChatGptTab() {
  const active = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"]
  });
  if (active.length) return active[0];
  const tabs = await getChatGptTabs();
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

function hasNoContentReceiver(error) {
  const message = String(error?.message || error || "");
  return /Receiving end does not exist|Could not establish connection/i.test(message);
}

async function injectContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content-script.js"] });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    if (hasNoContentReceiver(error)) {
      try {
        await injectContentScript(tabId);
        return await chrome.tabs.sendMessage(tabId, message);
      } catch (retryError) {
        throw new Error(`ChatGPT tab is not ready after content-script injection: ${retryError.message || retryError}`);
      }
    }
    throw new Error(`ChatGPT tab is not ready: ${error.message || error}`);
  }
}

async function getProjectForTab(tabId, { refresh = false } = {}) {
  if (!refresh && tabProjects.has(tabId)) return tabProjects.get(tabId);
  try {
    const response = await sendToTab(tabId, { type: "get_project" });
    const project = normalizeProject(response?.project);
    tabProjects.set(tabId, project);
    return project;
  } catch {
    return tabProjects.get(tabId) || null;
  }
}

async function getActiveContext() {
  const tab = await getActiveChatGptTab();
  if (!tab?.id) return { tab: null, project: null, profile: null, settings: await getSettings() };
  const settings = await getSettings();
  const project = await getProjectForTab(tab.id, { refresh: true });
  return { tab, project, profile: resolveProfile(settings, project), settings };
}

async function configureNative(expectedPort = nativePort, { force = false } = {}) {
  void force;
  const port = expectedPort;
  if (!port || nativePort !== port) return false;

  const settings = await getSettings();
  if (!port || nativePort !== port) return false;

  let activeProject = null;
  let activeProfile = null;
  try {
    const tab = await getActiveChatGptTab();
    if (tab?.id) {
      activeProject = await getProjectForTab(tab.id, { refresh: true });
      activeProfile = resolveProfile(settings, activeProject);
    }
  } catch {
    // Watching folders must not depend on the active page being ready.
  }

  currentNativeProfileId = activeProfile?.id || null;
  nativeReconfigurePending = false;

  const uploadProfiles = settings.profiles
    .filter((profile) => settings.enabled && profile.enabled && profile.uploadEnabled && String(profile.watchFolder || "").trim())
    .map((profile) => ({
      profileId: profile.id,
      profileName: profile.label || profile.projectName || profile.id,
      watchFolder: profile.watchFolder,
      uploadPattern: profile.uploadPattern || PROFILE_DEFAULTS.uploadPattern,
      recursive: Boolean(profile.recursive),
      includeExisting: Boolean(profile.includeExisting),
      stableSeconds: Number(profile.stableSeconds || PROFILE_DEFAULTS.stableSeconds),
      retrySeconds: Number(profile.retrySeconds || PROFILE_DEFAULTS.retrySeconds),
      maxFileBytes: Number(profile.maxFileBytes || PROFILE_DEFAULTS.maxFileBytes)
    }));

  const sent = postNative({
    type: "configure",
    config: {
      enabled: Boolean(settings.enabled && uploadProfiles.length),
      profiles: uploadProfiles
    }
  }, port);

  const watcherMessage = !settings.enabled
    ? "Folder watchers disabled"
    : uploadProfiles.length === 0
      ? "No enabled upload profiles have a watch folder"
      : uploadProfiles.length === 1
        ? `Watching 1 project folder (${uploadProfiles[0].profileName})`
        : `Watching ${uploadProfiles.length} project folders`;

  await setStatus({
    activeProject: activeProject?.name || activeProject?.id || null,
    activeProfile: activeProfile?.label || null,
    message: sent ? watcherMessage : lastStatus.message
  });
  return sent;
}

async function connectNative() {
  if (nativePort || nativeConnectInProgress) return;
  const attemptEpoch = nativeConnectionEpoch;
  nativeConnectInProgress = true;
  let port = null;
  try {
    const settings = await getSettings();
    if (nativePort || attemptEpoch !== nativeConnectionEpoch) return;
    port = chrome.runtime.connectNative(settings.hostName);
    nativePort = port;

    port.onMessage.addListener((message) => {
      if (nativePort !== port) return;
      nativeQueue = nativeQueue
        .then(() => handleNativeMessage(message, port))
        .catch((error) => setStatus({ lastError: String(error), message: "Native message failed" }));
    });

    port.onDisconnect.addListener(() => {
      if (nativePort !== port) return;
      const error = chrome.runtime.lastError?.message || "Native host disconnected";
      nativePort = null;
      activeTransfer = null;
      nativeConnectionEpoch += 1;
      nativeConnectInProgress = false;
      void setStatus({ nativeConnected: false, message: error, lastError: error });
      scheduleReconnect();
    });

    await setStatus({ nativeConnected: true, message: "Native host connected", lastError: null });
    await configureNative(port, { force: true });
  } catch (error) {
    if (!port || nativePort === port) nativePort = null;
    await setStatus({ nativeConnected: false, message: "Could not connect to native host", lastError: String(error) });
    scheduleReconnect();
  } finally {
    if (attemptEpoch === nativeConnectionEpoch) nativeConnectInProgress = false;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, 5000);
}

function scheduleQueueRetry(delayMs = 5000) {
  if (retryQueueTimer) return;
  retryQueueTimer = setTimeout(() => {
    retryQueueTimer = null;
    tryStartNextFile();
  }, delayMs);
}

async function findTabForProfile(settings, profileId) {
  const tabs = await getChatGptTabs();
  tabs.sort((a, b) => Number(Boolean(b.active)) - Number(Boolean(a.active)) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const tab of tabs) {
    if (!tab.id) continue;
    const project = await getProjectForTab(tab.id, { refresh: true });
    if (resolveProfile(settings, project)?.id === profileId) return { tab, project };
  }
  return null;
}

async function maybeApplyDeferredNativeProfile() {
  if (nativeReconfigurePending && !activeTransfer && !pendingFiles.length) {
    await configureNative();
  }
}

async function tryStartNextFile() {
  if (activeTransfer || !pendingFiles.length || !nativePort) return;
  const port = nativePort;
  const settings = await getSettings();
  if (!port || nativePort !== port || !settings.enabled) return;

  const metadata = pendingFiles.shift();
  const profile = getProfileById(settings, metadata.profileId || currentNativeProfileId);
  if (!profile?.enabled || !profile.uploadEnabled) {
    postNative({ type: "transfer_result", fileId: metadata.fileId, ok: false, reason: "The matching project profile is disabled" }, port);
    await setStatus({ message: `Skipped ${metadata.name}`, lastError: "The matching project profile is disabled or was removed" });
    await maybeApplyDeferredNativeProfile();
    return;
  }

  const target = await findTabForProfile(settings, profile.id);
  if (!target?.tab?.id) {
    pendingFiles.unshift(metadata);
    await setStatus({
      message: `A file is ready for ${profile.label}; open that ChatGPT project`,
      lastFile: metadata.name,
      lastError: null
    });
    scheduleQueueRetry(5000);
    return;
  }

  try {
    const probe = await sendToTab(target.tab.id, { type: "prepare_upload", metadata });
    if (!probe?.ready) throw new Error(probe?.error || "ChatGPT composer is not ready");
    activeTransfer = { fileId: metadata.fileId, tabId: target.tab.id, metadata, profileId: profile.id };
    if (!postNative({ type: "send_file", fileId: metadata.fileId }, port)) {
      throw new Error("Native host disconnected before the file transfer could start");
    }
    await setStatus({
      message: `Reading ${metadata.name} for ${profile.label}`,
      lastFile: metadata.name,
      lastError: null,
      activeProject: target.project?.name || target.project?.id || null,
      activeProfile: profile.label
    });
  } catch (error) {
    pendingFiles.unshift(metadata);
    postNative({ type: "transfer_result", fileId: metadata.fileId, ok: false, reason: String(error) }, port);
    await setStatus({ message: "Upload could not start", lastError: String(error) });
    activeTransfer = null;
    scheduleQueueRetry(Math.max(5000, Number(profile.retrySeconds) * 1000));
  }
}

async function handleNativeMessage(message, sourcePort) {
  if (!sourcePort || nativePort !== sourcePort || !message || typeof message.type !== "string") return;

  if (message.type === "status") {
    await setStatus({ message: message.message || "Native host status", lastError: message.error || null });
    return;
  }

  if (message.type === "file_available") {
    const metadata = { ...message, profileId: message.profileId || currentNativeProfileId || "" };
    if (!pendingFiles.some((item) => item.fileId === metadata.fileId) && activeTransfer?.fileId !== metadata.fileId) {
      pendingFiles.push(metadata);
    }
    const settings = await getSettings();
    const profile = getProfileById(settings, metadata.profileId);
    await setStatus({ message: `Queued ${metadata.name}${profile ? ` for ${profile.label}` : ""}`, lastFile: metadata.name });
    await tryStartNextFile();
    return;
  }

  if (!["file_start", "file_chunk", "file_end", "file_error"].includes(message.type)) return;
  if (!activeTransfer || activeTransfer.fileId !== message.fileId) {
    postNative({ type: "transfer_result", fileId: message.fileId, ok: false, reason: "No matching active browser transfer" }, sourcePort);
    return;
  }

  try {
    const response = await sendToTab(activeTransfer.tabId, { ...message, profileId: activeTransfer.profileId });
    if (message.type === "file_end") {
      const ok = Boolean(response?.ok);
      postNative({ type: "transfer_result", fileId: message.fileId, ok, reason: response?.error || null }, sourcePort);
      await setStatus({
        message: ok ? `Uploaded ${activeTransfer.metadata.name}` : `Upload failed: ${activeTransfer.metadata.name}`,
        lastFile: activeTransfer.metadata.name,
        lastError: ok ? null : response?.error || "Unknown upload failure"
      });
      activeTransfer = null;
      await tryStartNextFile();
      await maybeApplyDeferredNativeProfile();
    }
    if (message.type === "file_error") throw new Error(message.error || "Native host could not read the file");
  } catch (error) {
    postNative({ type: "transfer_result", fileId: message.fileId, ok: false, reason: String(error) }, sourcePort);
    await setStatus({ message: "Upload transfer failed", lastError: String(error) });
    activeTransfer = null;
    await tryStartNextFile();
    await maybeApplyDeferredNativeProfile();
  }
}

function safeFilenamePart(value) {
  return String(value || "download")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180) || "download";
}

function safeSubfolder(value) {
  return String(value || "")
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .map(safeFilenamePart)
    .join("/");
}

async function dispatchTrustedClick(tabId, point) {
  if (!Number.isInteger(tabId)) throw new Error("No ChatGPT tab was available for the download click");
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error("The matching download control did not have usable screen coordinates");
  }
  const target = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(target, "1.3");
    attached = true;
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target); } catch { /* tab may have navigated */ }
    }
  }
}

function rememberPendingDownload(name, profileId) {
  pendingDownloadProfiles.set(String(name || "").toLocaleLowerCase(), {
    profileId,
    expiresAt: Date.now() + 60_000
  });
}

async function profileForDownloadItem(settings, item, basename) {
  const pending = pendingDownloadProfiles.get(String(basename || "").toLocaleLowerCase());
  if (pending && pending.expiresAt > Date.now()) {
    const profile = getProfileById(settings, pending.profileId);
    if (profile) return profile;
  }
  if (Number.isInteger(item.tabId) && item.tabId >= 0) {
    const project = await getProjectForTab(item.tabId);
    const profile = resolveProfile(settings, project);
    if (profile) return profile;
  }
  const projectId = normalizeProjectId(`${item.url || ""} ${item.finalUrl || ""} ${item.referrer || ""}`);
  if (projectId) return resolveProfile(settings, { id: projectId });
  return null;
}

async function requestDownload(candidate, sender) {
  const settings = await getSettings();
  if (!settings.enabled) return { accepted: false };

  const project = normalizeProject(candidate.project) || (sender.tab?.id ? await getProjectForTab(sender.tab.id) : null);
  const profile = candidate.profileId
    ? getProfileById(settings, candidate.profileId)
    : resolveProfile(settings, project);
  if (!profile?.enabled || !profile.downloadEnabled) return { accepted: false, error: "Downloads are disabled for this project profile" };

  let regex;
  try { regex = new RegExp(profile.downloadPattern, "i"); }
  catch { return { accepted: false, error: "Invalid download pattern" }; }

  if (!regex.test(String(candidate.text || ""))) return { accepted: false };

  const fingerprint = `${profile.id}|${candidate.fingerprint || `${candidate.url || ""}|${candidate.suggestedName || ""}`}`;
  if (requestedDownloads.has(fingerprint)) return { accepted: true, duplicate: true };
  requestedDownloads.add(fingerprint);

  const name = safeFilenamePart(candidate.suggestedName || "chatgpt-download");
  const folder = safeSubfolder(profile.downloadSubfolder);
  const filename = folder ? `${folder}/${name}` : name;
  rememberPendingDownload(name, profile.id);

  if (/^https?:/i.test(candidate.url || "")) {
    try {
      const id = await chrome.downloads.download({ url: candidate.url, filename, conflictAction: "uniquify", saveAs: false });
      await setStatus({ message: `Downloading ${name} for ${profile.label}`, lastFile: name, lastError: null, activeProfile: profile.label });
      return { accepted: true, downloadId: id };
    } catch (error) {
      requestedDownloads.delete(fingerprint);
      return { accepted: true, clickInPage: true, error: String(error) };
    }
  }

  if (sender.tab?.id && candidate.clickPoint) {
    try {
      await setStatus({ message: `Starting download ${name} for ${profile.label}`, lastFile: name, lastError: null, activeProfile: profile.label });
      await dispatchTrustedClick(sender.tab.id, candidate.clickPoint);
      return { accepted: true, clickedByDebugger: true };
    } catch (error) {
      requestedDownloads.delete(fingerprint);
      await setStatus({
        message: `Could not start download ${name}`,
        lastFile: name,
        lastError: `Trusted click failed: ${String(error?.message || error)}. Close DevTools for this tab and try Scan result links again.`
      });
      return { accepted: false, error: String(error?.message || error) };
    }
  }

  if (sender.tab?.id) return { accepted: true, clickInPage: true };
  requestedDownloads.delete(fingerprint);
  return { accepted: false };
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    try {
      const settings = await getSettings();
      if (!settings.enabled) return suggest();
      const basename = String(item.filename || "download").split(/[\\/]/).pop();
      const fromChatGpt = /chatgpt\.com|chat\.openai\.com/i.test(`${item.url || ""} ${item.finalUrl || ""} ${item.referrer || ""}`);
      if (!fromChatGpt) return suggest();
      const pending = pendingDownloadProfiles.get(String(basename || "").toLocaleLowerCase());
      const requestedByMatchingButton = Boolean(pending && pending.expiresAt > Date.now());
      const profile = await profileForDownloadItem(settings, item, basename);
      if (!profile?.enabled || !profile.downloadEnabled) return suggest();
      if (!requestedByMatchingButton) return suggest();
      pendingDownloadProfiles.delete(String(basename || "").toLocaleLowerCase());
      const folder = safeSubfolder(profile.downloadSubfolder);
      const filename = folder ? `${folder}/${safeFilenamePart(basename)}` : safeFilenamePart(basename);
      suggest({ filename, conflictAction: "uniquify" });
    } catch { suggest(); }
  })();
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== "string") return sendResponse({ ok: false });

    if (message.type === "get_status") {
      const settings = await getSettings();
      const content = await getActiveContentVersion();
      return sendResponse({
        ok: true,
        settings,
        status: lastStatus,
        queueLength: pendingFiles.length,
        activeTransfer,
        currentNativeProfileId,
        extensionVersion: chrome.runtime.getManifest().version,
        contentVersion: content.version,
        contentVersionError: content.error
      });
    }

    if (message.type === "set_enabled") {
      await chrome.storage.local.set({ enabled: Boolean(message.enabled) });
      await configureNative();
      if (message.enabled) {
        connectNative();
        await tryStartNextFile();
      }
      return sendResponse({ ok: true });
    }

    if (message.type === "settings_changed") {
      await ensureSettings();
      await configureNative();
      return sendResponse({ ok: true });
    }

    if (message.type === "retry_connection") {
      const port = nativePort;
      nativePort = null;
      nativeConnectionEpoch += 1;
      nativeConnectInProgress = false;
      if (port) {
        try { port.disconnect(); } catch { /* already closed */ }
      }
      connectNative();
      return sendResponse({ ok: true });
    }

    if (message.type === "scan_downloads") {
      const tab = await getActiveChatGptTab();
      if (!tab?.id) return sendResponse({ ok: false, error: "No ChatGPT tab is open" });
      const response = await sendToTab(tab.id, { type: "scan_downloads" });
      return sendResponse({ ok: true, response });
    }

    if (message.type === "download_candidate") {
      return sendResponse(await requestDownload(message, sender));
    }

    if (message.type === "project_changed") {
      if (sender.tab?.id) {
        const project = normalizeProject(message.project);
        tabProjects.set(sender.tab.id, project);
        const settings = await getSettings();
        const profile = resolveProfile(settings, project);
        if (sender.tab.active) {
          await configureNative();
          await setStatus({
            activeProject: project?.name || project?.id || null,
            activeProfile: profile?.label || null,
            message: profile ? `Project ${project?.name || project?.id}: profile ${profile.label}` : "No matching project profile"
          });
        }
        return sendResponse({ ok: true, profile: profile ? { id: profile.id, label: profile.label } : null });
      }
      return sendResponse({ ok: false, error: "Project update did not come from a tab" });
    }

    if (message.type === "get_current_project") {
      const tab = await getActiveChatGptTab();
      if (!tab?.id) return sendResponse({ ok: false, error: "Open the ChatGPT project first" });
      const project = await getProjectForTab(tab.id, { refresh: true });
      if (!project) return sendResponse({ ok: false, error: "The active ChatGPT page is not inside a project" });
      const settings = await getSettings();
      const profile = resolveProfile(settings, project);
      return sendResponse({ ok: true, project, profile: profile ? { id: profile.id, label: profile.label } : null });
    }

    return sendResponse({ ok: false, error: "Unknown message" });
  })().catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && ["enabled", "hostName", "profiles"].some((key) => changes[key])) {
    configureNative();
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!isChatGptUrl(tab.url)) return;
    await getProjectForTab(tabId, { refresh: true });
    await configureNative();
    await tryStartNextFile();
  } catch { /* tab closed or not ready */ }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && isChatGptUrl(tab.url)) {
    await getProjectForTab(tabId, { refresh: true });
    if (tab.active) await configureNative();
    await tryStartNextFile();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => tabProjects.delete(tabId));

chrome.runtime.onInstalled.addListener(async () => {
  await ensureSettings();
  await ensureRuntimeVersionAndReloadStaleTabs();
  connectNative();
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSettings();
  connectNative();
});

ensureSettings().then(connectNative);


void ensureRuntimeVersionAndReloadStaleTabs().catch((error) => console.warn("Runtime version check failed", error));
