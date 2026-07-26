(() => {
  const INSTANCE_KEY = "__chatgptFolderBridgeContentInstance";
  const previousInstance = globalThis[INSTANCE_KEY];
  if (previousInstance && typeof previousInstance.dispose === "function") {
    try { previousInstance.dispose("replaced by a newer content-script instance"); }
    catch { /* stale instances must never block reinjection */ }
  }

  const instance = {
    version: "0.4.0",
    disposed: false,
    dispose: null
  };
  globalThis[INSTANCE_KEY] = instance;
  try { document.documentElement.dataset.chatgptFolderBridgeVersion = instance.version; } catch { /* best effort */ }

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

const transferBuffers = new Map();
const seenDownloads = new Set();
let settings = null;
let activeProject = null;
let activeProfile = null;
let observedLocation = location.href;
let observedProjectKey = "";
let projectRefreshTimer = null;
let routePollTimer = null;
let downloadObserver = null;
let downloadScanTimer = null;
let pendingDownloadScanForce = false;
let initialDownloadPassPending = true;
let initialDownloadPassStartedAt = Date.now();
let initialDownloadLastSignature = null;
let initialDownloadStableSince = 0;
let downloadScanInProgress = false;
let downloadActivationInProgress = false;
let downloadBoundaryButton = null;
let suppressDownloadMutationsUntil = 0;
const INITIAL_DOWNLOAD_QUIET_MS = 15000;
const INITIAL_DOWNLOAD_MIN_WAIT_MS = 30000;
const INITIAL_DOWNLOAD_MAX_WAIT_MS = 180000;
const INITIAL_DOWNLOAD_POLL_MS = 1000;
const POST_DOWNLOAD_CLICK_SUPPRESS_MS = 3000;
let storageChangedListener = null;
let runtimeMessageListener = null;
let unhandledRejectionListener = null;
let windowErrorListener = null;

function isExtensionContextInvalidated(error) {
  const message = String(error?.message || error || "");
  return /Extension context invalidated|Cannot access a chrome(?:\.| )|context has been invalidated|Receiving end does not exist/i.test(message);
}

function isMissingChromeApiError(error) {
  const message = String(error?.message || error || "");
  return /Cannot read properties of undefined \(reading ['"](?:get|sendMessage|addListener|removeListener)['"]\)/i.test(message);
}

function isLifecycleError(error) {
  return isExtensionContextInvalidated(error) || isMissingChromeApiError(error);
}

function installLifecycleErrorGuards() {
  unhandledRejectionListener = (event) => {
    if (!isLifecycleError(event.reason)) return;
    event.preventDefault();
    disposeContentScript("extension context invalidated by an unhandled rejection");
  };
  windowErrorListener = (event) => {
    if (!isLifecycleError(event.error || event.message)) return;
    event.preventDefault();
    disposeContentScript("extension context invalidated by a window error");
  };
  window.addEventListener("unhandledrejection", unhandledRejectionListener);
  window.addEventListener("error", windowErrorListener);
}

function hasLiveExtensionContext() {
  if (instance.disposed) return false;
  try {
    return Boolean(globalThis.chrome?.runtime?.id && chrome.storage?.local && chrome.runtime?.sendMessage);
  } catch {
    return false;
  }
}

function ensureLiveExtensionContext(reason = "extension context unavailable") {
  if (hasLiveExtensionContext()) return true;
  disposeContentScript(reason);
  return false;
}

function disposeContentScript(_reason = "disposed") {
  if (instance.disposed) return;
  instance.disposed = true;

  try { downloadObserver?.disconnect(); } catch { /* best effort */ }
  downloadObserver = null;

  if (downloadScanTimer) clearTimeout(downloadScanTimer);
  downloadScanTimer = null;
  pendingDownloadScanForce = false;
  initialDownloadPassPending = false;
  initialDownloadLastSignature = null;
  initialDownloadStableSince = 0;
  downloadScanInProgress = false;
  downloadActivationInProgress = false;
  downloadBoundaryButton = null;
  suppressDownloadMutationsUntil = 0;

  if (projectRefreshTimer) clearTimeout(projectRefreshTimer);
  projectRefreshTimer = null;

  if (routePollTimer) clearInterval(routePollTimer);
  routePollTimer = null;

  try {
    if (storageChangedListener) chrome.storage.onChanged.removeListener(storageChangedListener);
  } catch { /* the Chrome API may already be invalid */ }

  try {
    if (runtimeMessageListener) chrome.runtime.onMessage.removeListener(runtimeMessageListener);
  } catch { /* the Chrome API may already be invalid */ }

  try {
    if (unhandledRejectionListener) window.removeEventListener("unhandledrejection", unhandledRejectionListener);
    if (windowErrorListener) window.removeEventListener("error", windowErrorListener);
  } catch { /* page may be unloading */ }
  unhandledRejectionListener = null;
  windowErrorListener = null;

  try {
    if (document.documentElement?.dataset?.chatgptFolderBridgeVersion === instance.version) {
      delete document.documentElement.dataset.chatgptFolderBridgeVersion;
    }
  } catch { /* page may be unloading */ }

  transferBuffers.clear();
  seenDownloads.clear();

  if (globalThis[INSTANCE_KEY] === instance) {
    try { delete globalThis[INSTANCE_KEY]; }
    catch { globalThis[INSTANCE_KEY] = null; }
  }
}

instance.dispose = disposeContentScript;
installLifecycleErrorGuards();

function handleAsyncError(error) {
  if (isLifecycleError(error)) {
    disposeContentScript("extension context invalidated");
    return;
  }
  console.warn("[ChatGPT Folder Bridge]", error);
}

function runSafely(promise) {
  Promise.resolve(promise).catch(handleAsyncError);
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

function normalizeProfile(profile, index = 0) {
  const value = { ...PROFILE_DEFAULTS, ...(profile && typeof profile === "object" ? profile : {}) };
  value.id = String(value.id || `profile-${index}`);
  value.label = String(value.label || value.projectName || `Project profile ${index + 1}`).trim();
  value.projectName = String(value.projectName || "").replace(/\s+/g, " ").trim();
  value.projectId = normalizeProjectId(value.projectId);
  value.matchAnyProject = Boolean(value.matchAnyProject);
  value.enabled = Boolean(value.enabled);
  value.uploadEnabled = Boolean(value.uploadEnabled);
  value.downloadEnabled = Boolean(value.downloadEnabled);
  value.autoSubmit = Boolean(value.autoSubmit);
  value.uploadDelayMs = Math.max(0, Number(value.uploadDelayMs) || 0);
  return value;
}

function projectNameFromAnchor(anchor) {
  if (!(anchor instanceof HTMLAnchorElement)) return "";
  const labelled = anchor.querySelector("span.text-token-text-primary")?.textContent?.trim();
  if (labelled) return labelled;
  const aria = anchor.getAttribute("aria-label") || "";
  const match = aria.match(/^Open\s+(.+?)\s+project$/i);
  return match?.[1]?.trim() || "";
}

function detectProject() {
  const pathId = normalizeProjectId(location.pathname);
  const anchors = [...document.querySelectorAll('a[href*="/g/g-p-"][href*="/project"]')]
    .filter((anchor) => anchor instanceof HTMLAnchorElement);

  let anchor = null;
  if (pathId) {
    anchor = anchors.find((candidate) => normalizeProjectId(candidate.getAttribute("href")) === pathId) || null;
  }

  if (!anchor) {
    const candidates = anchors
      .map((candidate) => {
        const rect = candidate.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0;
        const outsideNavigation = !candidate.closest("nav, aside");
        const nearTop = rect.top >= 0 && rect.top < 160;
        const score = Number(visible) * 4 + Number(outsideNavigation) * 3 + Number(nearTop) * 2;
        return { candidate, score };
      })
      .sort((a, b) => b.score - a.score);
    if (candidates[0]?.score >= 6) anchor = candidates[0].candidate;
  }

  const id = pathId || normalizeProjectId(anchor?.getAttribute("href") || "");
  const name = projectNameFromAnchor(anchor);
  if (!id && !name) return null;
  return {
    id,
    name,
    href: anchor?.getAttribute("href") || location.pathname,
    key: id || normalizeProjectName(name)
  };
}

function resolveProfile(profiles, project) {
  const enabledProfiles = profiles.filter((profile) => profile.enabled);
  if (project?.id) {
    const byId = enabledProfiles.find((profile) => profile.projectId && profile.projectId === project.id);
    if (byId) return byId;
  }
  if (project?.name) {
    const wantedName = normalizeProjectName(project.name);
    const byName = enabledProfiles.find((profile) => profile.projectName && normalizeProjectName(profile.projectName) === wantedName);
    if (byName) return byName;
  }
  return enabledProfiles.find((profile) => profile.matchAnyProject) || null;
}

function resolveStorageGet() {
  if (instance.disposed) return null;
  try {
    const chromeApi = globalThis.chrome;
    const runtime = chromeApi?.runtime;
    const localStorage = chromeApi?.storage?.local;
    const getMethod = localStorage?.get;
    if (!runtime?.id || typeof getMethod !== "function") return null;
    return {
      runtime,
      get: getMethod.bind(localStorage)
    };
  } catch {
    return null;
  }
}

function readLocalSettings() {
  return new Promise((resolve, reject) => {
    const api = resolveStorageGet();
    if (!api) {
      disposeContentScript("extension storage API is unavailable");
      resolve(null);
      return;
    }

    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    try {
      api.get({ enabled: false, profiles: [] }, (raw) => {
        if (instance.disposed) {
          finish(null);
          return;
        }

        let runtimeError = null;
        try {
          runtimeError = api.runtime?.lastError || null;
        } catch {
          disposeContentScript("extension context invalidated while reading settings");
          finish(null);
          return;
        }

        if (runtimeError) {
          if (isExtensionContextInvalidated(runtimeError)) {
            disposeContentScript("extension context invalidated while reading settings");
            finish(null);
          } else {
            reject(new Error(runtimeError.message || String(runtimeError)));
          }
          return;
        }

        if (!hasLiveExtensionContext()) {
          disposeContentScript("extension context invalidated after reading settings");
          finish(null);
          return;
        }
        finish(raw || { enabled: false, profiles: [] });
      });
    } catch (error) {
      if (isLifecycleError(error)) {
        disposeContentScript("extension context invalidated while starting a settings read");
        finish(null);
      } else {
        reject(error);
      }
    }
  });
}

async function loadSettings() {
  if (!ensureLiveExtensionContext("extension context invalidated before loading settings")) return null;

  let raw = null;
  try {
    raw = await readLocalSettings();
  } catch (error) {
    if (isLifecycleError(error)) {
      disposeContentScript("extension context invalidated while loading settings");
      return null;
    }
    throw error;
  }
  if (!raw || instance.disposed || !hasLiveExtensionContext()) return null;
  const profiles = Array.isArray(raw.profiles) ? raw.profiles.map(normalizeProfile) : [];
  activeProject = detectProject();
  activeProfile = resolveProfile(profiles, activeProject);
  settings = {
    enabled: Boolean(raw.enabled && activeProfile?.enabled),
    profile: activeProfile,
    project: activeProject,
    uploadEnabled: Boolean(activeProfile?.uploadEnabled),
    downloadEnabled: Boolean(activeProfile?.downloadEnabled),
    downloadPattern: activeProfile?.downloadPattern || PROFILE_DEFAULTS.downloadPattern,
    downloadLastOnReload: Boolean(activeProfile?.downloadLastOnReload),
    promptText: activeProfile?.promptText || "",
    autoSubmit: Boolean(activeProfile?.autoSubmit),
    uploadDelayMs: Math.max(0, Number(activeProfile?.uploadDelayMs) || 0)
  };
  return settings;
}

function resolveRuntimeMessaging() {
  if (instance.disposed) return null;
  try {
    const chromeApi = globalThis.chrome;
    const runtime = chromeApi?.runtime;
    const sendMessage = runtime?.sendMessage;
    if (!runtime?.id || typeof sendMessage !== "function") return null;
    return { runtime, sendMessage: sendMessage.bind(runtime) };
  } catch {
    return null;
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    const api = resolveRuntimeMessaging();
    if (!api) {
      disposeContentScript("extension messaging API is unavailable");
      resolve(null);
      return;
    }

    try {
      api.sendMessage(message, (response) => {
        if (instance.disposed) {
          resolve(null);
          return;
        }

        let runtimeError = null;
        try { runtimeError = api.runtime.lastError || null; }
        catch {
          disposeContentScript("extension context invalidated while reading message status");
          resolve(null);
          return;
        }

        if (runtimeError) {
          if (isLifecycleError(runtimeError)) {
            disposeContentScript("extension context invalidated while sending a message");
            resolve(null);
          } else {
            reject(new Error(runtimeError.message || String(runtimeError)));
          }
          return;
        }
        resolve(response);
      });
    } catch (error) {
      if (isLifecycleError(error)) {
        disposeContentScript("extension context invalidated while starting a message");
        resolve(null);
      } else {
        reject(error);
      }
    }
  });
}

async function notifyProjectChanged() {
  if (!ensureLiveExtensionContext("extension context invalidated before reporting the project")) return;
  try {
    await sendRuntimeMessage({ type: "project_changed", project: activeProject });
  } catch {
    // The service worker can restart between page events; the next poll retries.
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    if (instance.disposed) {
      resolve(false);
      return;
    }
    setTimeout(() => resolve(!instance.disposed && hasLiveExtensionContext()), ms);
  });
}

function isVisible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width >= 0 && rect.height >= 0;
}

function findComposer() {
  return document.querySelector("#prompt-textarea") ||
    document.querySelector('textarea[placeholder*="Message"]') ||
    document.querySelector('div[contenteditable="true"][role="textbox"]') ||
    document.querySelector('textarea[data-testid*="composer"]');
}

function findSendButton() {
  const selectors = [
    'button[data-testid="send-button"]',
    'button[data-testid="composer-submit-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label^="Send"]'
  ];
  for (const selector of selectors) {
    const button = [...document.querySelectorAll(selector)].find(isVisible);
    if (button) return button;
  }
  return null;
}

function findFileInput() {
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  return inputs.find((input) => !input.disabled && !input.closest('[aria-hidden="true"]')) ||
    inputs.find((input) => !input.disabled) || null;
}

function composerDropTarget() {
  const composer = findComposer();
  return composer?.closest("form") || composer?.parentElement || document.querySelector("main") || document.body;
}

async function waitFor(predicate, timeoutMs, intervalMs = 150) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    if (!await sleep(intervalMs)) return null;
  }
  return null;
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function buildFile(buffer) {
  return new File(buffer.chunks, buffer.name, {
    type: buffer.mime || "application/octet-stream",
    lastModified: buffer.modifiedMs || Date.now()
  });
}

async function attachViaInput(file) {
  const input = findFileInput();
  if (!input) return false;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return true;
}

async function attachViaDrop(file) {
  const target = composerDropTarget();
  const transfer = new DataTransfer();
  transfer.items.add(file);
  for (const type of ["dragenter", "dragover", "drop"]) {
    target.dispatchEvent(new DragEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      dataTransfer: transfer
    }));
    if (!await sleep(80)) return false;
  }
  return true;
}

function attachmentVisible(filename) {
  const escaped = CSS.escape(filename);
  if (document.querySelector(`[title="${escaped}"], [aria-label*="${escaped}"]`)) return true;
  const composer = findComposer();
  const scope = composer?.closest("form") || document.querySelector("main") || document.body;
  return (scope.innerText || "").includes(filename);
}

function setNativeTextareaValue(textarea, value) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
  descriptor?.set?.call(textarea, value);
  textarea.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  textarea.dispatchEvent(new Event("change", { bubbles: true }));
}

function setComposerText(text) {
  if (!text) return;
  const composer = findComposer();
  if (!composer) throw new Error("Could not find the ChatGPT prompt box");
  const existing = composer instanceof HTMLTextAreaElement ? composer.value : composer.innerText;
  const value = existing?.trim() ? `${existing.trim()}\n${text}` : text;
  composer.focus();
  if (composer instanceof HTMLTextAreaElement) {
    setNativeTextareaValue(composer, value);
  } else {
    composer.textContent = value;
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertText",
      data: text
    }));
  }
}

function profileMismatch(profileId) {
  return Boolean(profileId && activeProfile?.id !== profileId);
}

async function attachAndSubmit(file, profileId) {
  if (!await loadSettings()) throw new Error("The extension was reloaded; retry after the content script reconnects");
  if (!settings.enabled || !settings.uploadEnabled) throw new Error("Uploads are disabled for the active project profile");
  if (profileMismatch(profileId)) {
    throw new Error(`This file belongs to another project profile; active project is ${activeProject?.name || "not detected"}`);
  }

  const composer = await waitFor(findComposer, 10000);
  if (!composer) throw new Error("ChatGPT prompt box was not found");

  let attached = await attachViaInput(file);
  if (!attached) attached = await attachViaDrop(file);
  if (!attached) throw new Error("No ChatGPT file input or drop target was found");

  let shown = await waitFor(() => attachmentVisible(file.name), 8000);
  if (!shown) {
    await attachViaDrop(file);
    shown = await waitFor(() => attachmentVisible(file.name), 8000);
  }
  if (!shown) throw new Error("ChatGPT did not show the attached file");

  setComposerText(settings.promptText || "");
  if (!settings.autoSubmit) return { ok: true, submitted: false };

  if (!await sleep(settings.uploadDelayMs)) {
    throw new Error("The extension was reloaded before submission");
  }
  const button = await waitFor(() => {
    const candidate = findSendButton();
    return candidate && !candidate.disabled && candidate.getAttribute("aria-disabled") !== "true" ? candidate : null;
  }, 30000, 250);
  if (!button) throw new Error("The send button never became ready; the file may still be uploading");
  button.click();
  return { ok: true, submitted: true };
}

function filenameFromButtonText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const withoutAction = text.replace(/^(?:download|save|open)\s+/i, "");
  const filenameMatch = withoutAction.match(/[\w .()+-]+\.[A-Za-z0-9]{1,10}\b/);
  return filenameMatch?.[0]?.trim() || "chatgpt-download";
}

function isAssistantDownloadButton(element) {
  if (!(element instanceof HTMLButtonElement)) return false;
  const roleContainer = element.closest('[data-message-author-role]');
  if (roleContainer) return roleContainer.getAttribute("data-message-author-role") === "assistant";
  return Boolean(element.closest('article, [data-testid^="conversation-turn"]'));
}

function buttonFingerprint(element, text) {
  const turn = element.closest('[data-message-id], [data-testid^="conversation-turn"], [data-message-author-role]');
  const turnId = turn?.getAttribute("data-message-id") || turn?.getAttribute("data-testid") || "";
  return `${activeProfile?.id || "none"}|${turnId}|${text}`;
}

async function inspectDownloadButton(button, { force = false } = {}) {
  if (downloadActivationInProgress) return false;
  if (!isAssistantDownloadButton(button)) return false;
  if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;

  if (!await loadSettings()) return false;
  if (!settings.enabled || !settings.downloadEnabled || !activeProfile) return false;

  let regex;
  try { regex = new RegExp(settings.downloadPattern, "i"); }
  catch { return false; }

  const text = (button.textContent || "").replace(/\s+/g, " ").trim();
  regex.lastIndex = 0;
  if (!regex.test(text)) return false;

  const fingerprint = buttonFingerprint(button, text);
  if (seenDownloads.has(fingerprint) && !force) return false;
  seenDownloads.add(fingerprint);

  // A trusted click scrolls and mutates the ChatGPT DOM. Suppress observer-driven
  // scans around that operation so one selected button cannot cascade into older
  // or lazily rendered buttons being clicked one after another.
  downloadActivationInProgress = true;
  suppressDownloadMutationsUntil = Date.now() + POST_DOWNLOAD_CLICK_SUPPRESS_MS;

  try {
    button.scrollIntoView({ block: "center", inline: "nearest" });
    if (!await sleep(350)) {
      seenDownloads.delete(fingerprint);
      return false;
    }
    if (!button.isConnected) {
      seenDownloads.delete(fingerprint);
      return false;
    }

    const rect = button.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) {
      seenDownloads.delete(fingerprint);
      return false;
    }

    const clickPoint = {
      x: Math.max(0, Math.min(window.innerWidth - 1, rect.left + rect.width / 2)),
      y: Math.max(0, Math.min(window.innerHeight - 1, rect.top + rect.height / 2))
    };

    const response = await sendRuntimeMessage({
      type: "download_candidate",
      url: "",
      suggestedName: filenameFromButtonText(text),
      text,
      fingerprint,
      elementType: "button",
      clickPoint,
      profileId: activeProfile.id,
      project: activeProject
    });
    if (!response?.accepted) {
      seenDownloads.delete(fingerprint);
      return false;
    }
    return true;
  } catch {
    seenDownloads.delete(fingerprint);
    return false;
  } finally {
    downloadActivationInProgress = false;
    suppressDownloadMutationsUntil = Math.max(
      suppressDownloadMutationsUntil,
      Date.now() + POST_DOWNLOAD_CLICK_SUPPRESS_MS
    );
  }
}

function buttonsWithin(root = document) {
  if (root instanceof HTMLButtonElement) return [root];
  return [...(root.querySelectorAll?.("button") || [])];
}

function pageHasActiveGeneration() {
  const selectors = [
    'button[data-testid="stop-button"]',
    'button[aria-label*="Stop generating" i]',
    'button[aria-label*="Stop streaming" i]',
    'button[aria-label*="Stop response" i]'
  ];
  return selectors.some((selector) => [...document.querySelectorAll(selector)].some(isVisible));
}

async function getInitialDownloadSnapshot() {
  if (!await loadSettings()) return { ready: false, signature: "", count: 0 };
  if (!settings.enabled || !settings.downloadEnabled || !activeProfile) {
    return { ready: true, signature: "disabled", count: 0 };
  }

  let regex;
  try { regex = new RegExp(settings.downloadPattern, "i"); }
  catch { return { ready: true, signature: "invalid-pattern", count: 0 };
  }

  const fingerprints = [];
  for (const button of buttonsWithin(document)) {
    if (!isAssistantDownloadButton(button)) continue;
    if (button.disabled || button.getAttribute("aria-disabled") === "true") continue;

    const text = (button.textContent || "").replace(/\s+/g, " ").trim();
    regex.lastIndex = 0;
    if (!regex.test(text)) continue;
    fingerprints.push(buttonFingerprint(button, text));
  }

  // Include order and duplicate position. The stability clock resets whenever a
  // later conversation turn or download button is hydrated into the page.
  return {
    ready: true,
    signature: fingerprints.map((value, index) => `${index}|${value}`).join("\n"),
    count: fingerprints.length
  };
}

async function scanDownloadButtons(root = document, { force = false, establishBoundary = false, activate = true } = {}) {
  const buttons = buttonsWithin(root);
  if (downloadScanInProgress || downloadActivationInProgress) {
    return { inspected: buttons.length, matched: 0, activated: 0, busy: true };
  }

  downloadScanInProgress = true;
  try {
    if (!await loadSettings()) {
      return { inspected: buttons.length, matched: 0, activated: 0 };
    }
    if (!settings.enabled || !settings.downloadEnabled || !activeProfile) {
      return { inspected: buttons.length, matched: 0, activated: 0 };
    }

    let regex;
    try { regex = new RegExp(settings.downloadPattern, "i"); }
    catch { return { inspected: buttons.length, matched: 0, activated: 0 }; }

    const matches = [];
    for (const button of buttons) {
      if (!isAssistantDownloadButton(button)) continue;
      if (button.disabled || button.getAttribute("aria-disabled") === "true") continue;

      const text = (button.textContent || "").replace(/\s+/g, " ").trim();
      regex.lastIndex = 0;
      if (!regex.test(text)) continue;

      const fingerprint = buttonFingerprint(button, text);
      matches.push({ button, text, fingerprint });
    }

    // One scan makes exactly one decision: all current matches become seen and
    // only the final eligible match in DOM order can be activated. After the
    // initial page pass, ignore lazily rendered controls inserted before the
    // established bottom-most matching button.
    const isAfterBoundary = (button) => {
      if (!downloadBoundaryButton || !downloadBoundaryButton.isConnected) return true;
      if (button === downloadBoundaryButton) return false;
      return Boolean(downloadBoundaryButton.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    const candidates = force
      ? matches
      : matches.filter((item) => !seenDownloads.has(item.fingerprint) && (establishBoundary || isAfterBoundary(item.button)));
    for (const item of matches) seenDownloads.add(item.fingerprint);

    const target = candidates.length ? candidates[candidates.length - 1] : null;
    const activated = activate && target
      ? await inspectDownloadButton(target.button, { force: true })
      : false;

    if (establishBoundary) {
      downloadBoundaryButton = target?.button || matches[matches.length - 1]?.button || null;
    } else if (activated && target?.button) {
      downloadBoundaryButton = target.button;
    }

    return {
      inspected: buttons.length,
      matched: matches.length,
      activated: activated ? 1 : 0,
      selectedText: activated ? target?.text || "" : ""
    };
  } finally {
    downloadScanInProgress = false;
  }
}

function cancelDownloadScanTimer() {
  if (downloadScanTimer) clearTimeout(downloadScanTimer);
  downloadScanTimer = null;
  pendingDownloadScanForce = false;
}

function beginInitialDownloadPass() {
  if (instance.disposed) return;
  cancelDownloadScanTimer();
  initialDownloadPassPending = true;
  initialDownloadPassStartedAt = Date.now();
  initialDownloadLastSignature = null;
  initialDownloadStableSince = 0;
  downloadBoundaryButton = null;
  suppressDownloadMutationsUntil = 0;
  scheduleInitialDownloadPass();
}

async function checkInitialDownloadPass() {
  if (!ensureLiveExtensionContext("extension context invalidated during the initial download scan") || !initialDownloadPassPending) return;
  if (downloadActivationInProgress) {
    scheduleInitialDownloadPass();
    return;
  }

  const now = Date.now();
  const elapsed = now - initialDownloadPassStartedAt;
  const snapshot = await getInitialDownloadSnapshot();
  if (!snapshot.ready || instance.disposed || !initialDownloadPassPending) {
    scheduleInitialDownloadPass();
    return;
  }

  if (snapshot.signature !== initialDownloadLastSignature) {
    initialDownloadLastSignature = snapshot.signature;
    initialDownloadStableSince = now;
  } else if (!initialDownloadStableSince) {
    initialDownloadStableSince = now;
  }

  const stableFor = now - initialDownloadStableSince;
  const timedOut = elapsed >= INITIAL_DOWNLOAD_MAX_WAIT_MS;
  const settled = elapsed >= INITIAL_DOWNLOAD_MIN_WAIT_MS &&
    stableFor >= INITIAL_DOWNLOAD_QUIET_MS &&
    !pageHasActiveGeneration();

  if (!timedOut && !settled) {
    scheduleInitialDownloadPass();
    return;
  }

  initialDownloadPassPending = false;
  // Existing buttons are a baseline by default. A project profile may explicitly
  // opt in to downloading the final matching button after a reload.
  const activateLast = Boolean(settings?.downloadLastOnReload);
  await scanDownloadButtons(document, {
    force: activateLast,
    establishBoundary: true,
    activate: activateLast
  });
}

function scheduleInitialDownloadPass() {
  if (!ensureLiveExtensionContext("extension context invalidated while scheduling the initial download scan") || !initialDownloadPassPending) return;
  if (downloadScanTimer) clearTimeout(downloadScanTimer);
  downloadScanTimer = setTimeout(() => {
    downloadScanTimer = null;
    runSafely(checkInitialDownloadPass());
  }, INITIAL_DOWNLOAD_POLL_MS);
}

function scheduleDownloadScan({ force = false, delay = 900 } = {}) {
  if (!ensureLiveExtensionContext("extension context invalidated while scheduling a download scan")) return;
  if (downloadActivationInProgress || Date.now() < suppressDownloadMutationsUntil) return;

  // During initial page hydration, keep extending one quiet-period timer. This
  // guarantees that a reload produces one selection from the final DOM instead
  // of one selection for each incrementally rendered batch.
  if (initialDownloadPassPending && !force) {
    scheduleInitialDownloadPass();
    return;
  }

  pendingDownloadScanForce = pendingDownloadScanForce || force;
  if (downloadScanTimer) clearTimeout(downloadScanTimer);

  downloadScanTimer = setTimeout(() => {
    downloadScanTimer = null;
    if (instance.disposed || downloadActivationInProgress || Date.now() < suppressDownloadMutationsUntil) {
      pendingDownloadScanForce = false;
      return;
    }
    const forceNow = pendingDownloadScanForce;
    pendingDownloadScanForce = false;
    runSafely(scanDownloadButtons(document, { force: forceNow }));
  }, delay);
}

downloadObserver = new MutationObserver((mutations) => {
  if (instance.disposed) return;
  if (location.href !== observedLocation) {
    observedLocation = location.href;
    seenDownloads.clear();
    beginInitialDownloadPass();
    runSafely(refreshProjectContext({ forceNotify: true }));
    return;
  }

  let projectRelevantMutation = false;
  let downloadRelevantMutation = false;
  for (const mutation of mutations) {
    if (mutation.type === "childList") {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLButtonElement) {
          downloadRelevantMutation = true;
        } else if (node instanceof Element && node.querySelector("button")) {
          downloadRelevantMutation = true;
        } else if (node.parentElement?.closest("button")) {
          downloadRelevantMutation = true;
        }
      }
      projectRelevantMutation = true;
    } else if (mutation.type === "characterData") {
      if (mutation.target.parentElement?.closest("button")) downloadRelevantMutation = true;
    } else if (mutation.target instanceof HTMLButtonElement) {
      downloadRelevantMutation = true;
    }
  }

  if (downloadRelevantMutation) {
    if (initialDownloadPassPending) {
      scheduleInitialDownloadPass();
    } else if (!downloadActivationInProgress && Date.now() >= suppressDownloadMutationsUntil) {
      scheduleDownloadScan();
    }
  }
  if (projectRelevantMutation) scheduleProjectRefresh();
});

if (ensureLiveExtensionContext("extension context invalidated before starting the page observer")) {
  downloadObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["disabled", "aria-disabled"]
  });
}

async function refreshProjectContext({ forceNotify = false } = {}) {
  if (instance.disposed) return false;
  const previousKey = observedProjectKey;
  if (!await loadSettings()) return false;
  observedProjectKey = activeProject?.key || "";
  const changed = previousKey !== observedProjectKey;
  if (changed) {
    seenDownloads.clear();
    beginInitialDownloadPass();
  }
  if (changed || forceNotify) await notifyProjectChanged();
  return true;
}

function scheduleProjectRefresh() {
  if (!ensureLiveExtensionContext("extension context invalidated while scheduling a project refresh")) return;
  if (projectRefreshTimer) clearTimeout(projectRefreshTimer);
  projectRefreshTimer = setTimeout(() => {
    projectRefreshTimer = null;
    runSafely(refreshProjectContext());
  }, 200);
}

routePollTimer = setInterval(() => {
  if (!ensureLiveExtensionContext("extension context invalidated during route polling")) return;
  const routeChanged = location.href !== observedLocation;
  const projectKey = detectProject()?.key || "";
  if (routeChanged || projectKey !== observedProjectKey) {
    observedLocation = location.href;
    if (routeChanged) {
      seenDownloads.clear();
      beginInitialDownloadPass();
    }
    runSafely(refreshProjectContext({ forceNotify: true }));
  }
}, 500);

storageChangedListener = (changes, area) => {
  if (instance.disposed) return;
  if (area === "local" && (changes.enabled || changes.profiles)) {
    runSafely(refreshProjectContext({ forceNotify: true }));
  }
};
if (ensureLiveExtensionContext("extension context invalidated before registering storage changes")) {
  try {
    const changedEvent = globalThis.chrome?.storage?.onChanged;
    const addListener = changedEvent?.addListener;
    if (typeof addListener === "function") addListener.call(changedEvent, storageChangedListener);
    else disposeContentScript("storage change API unavailable");
  } catch (error) {
    if (isLifecycleError(error)) disposeContentScript("extension context invalidated while registering storage changes");
    else throw error;
  }
}

runtimeMessageListener = (message, _sender, sendResponse) => {
  (async () => {
    if (!message || typeof message.type !== "string") return sendResponse({ ok: false });

    if (message.type === "get_content_version") {
      return sendResponse({ ok: true, version: instance.version, disposed: instance.disposed });
    }

    if (message.type === "get_project") {
      if (!await loadSettings()) return sendResponse({ ok: false, error: "Extension context was reloaded" });
      return sendResponse({
        ok: true,
        project: activeProject,
        profile: activeProfile ? { id: activeProfile.id, label: activeProfile.label } : null
      });
    }

    if (message.type === "prepare_upload") {
      if (!await loadSettings()) return sendResponse({ ready: false, error: "Extension context was reloaded" });
      if (!settings.enabled || !settings.uploadEnabled) {
        return sendResponse({ ready: false, error: "Uploads are disabled for this project profile" });
      }
      if (profileMismatch(message.metadata?.profileId)) {
        return sendResponse({
          ready: false,
          error: `Open the ChatGPT project for profile ${message.metadata?.profileName || message.metadata?.profileId}`
        });
      }
      const composer = findComposer();
      return sendResponse({
        ready: Boolean(composer),
        project: activeProject,
        profileId: activeProfile?.id || null,
        error: composer ? null : "Open a normal ChatGPT conversation with the prompt box visible"
      });
    }

    if (message.type === "file_start") {
      transferBuffers.set(message.fileId, {
        name: message.name,
        mime: message.mime,
        size: message.size,
        modifiedMs: message.modifiedMs,
        profileId: message.profileId,
        chunks: []
      });
      return sendResponse({ ok: true });
    }

    if (message.type === "file_chunk") {
      const buffer = transferBuffers.get(message.fileId);
      if (!buffer) return sendResponse({ ok: false, error: "Received a file chunk before file_start" });
      if (message.index !== buffer.chunks.length) {
        transferBuffers.delete(message.fileId);
        return sendResponse({ ok: false, error: `Out-of-order file chunk ${message.index}` });
      }
      buffer.chunks.push(decodeBase64(message.data));
      return sendResponse({ ok: true });
    }

    if (message.type === "file_end") {
      const buffer = transferBuffers.get(message.fileId);
      if (!buffer) return sendResponse({ ok: false, error: "Received file_end without a transfer" });
      try {
        const file = buildFile(buffer);
        if (file.size !== buffer.size) throw new Error(`File size mismatch: expected ${buffer.size}, got ${file.size}`);
        const result = await attachAndSubmit(file, buffer.profileId);
        transferBuffers.delete(message.fileId);
        return sendResponse(result);
      } catch (error) {
        transferBuffers.delete(message.fileId);
        return sendResponse({ ok: false, error: String(error.message || error) });
      }
    }

    if (message.type === "file_error") {
      transferBuffers.delete(message.fileId);
      return sendResponse({ ok: false, error: message.error || "File transfer failed" });
    }

    if (message.type === "scan_downloads") {
      if (!await loadSettings()) return sendResponse({ ok: false, error: "Extension context was reloaded" });
      cancelDownloadScanTimer();
      initialDownloadPassPending = false;
      const result = await scanDownloadButtons(document, { force: true, establishBoundary: true, activate: true });
      return sendResponse({
        ok: true,
        ...result,
        project: activeProject,
        profile: activeProfile ? { id: activeProfile.id, label: activeProfile.label } : null
      });
    }

    return sendResponse({ ok: false, error: "Unknown content message" });
  })().catch((error) => {
    if (isLifecycleError(error)) disposeContentScript("extension context invalidated while handling a message");
    try { sendResponse({ ok: false, error: String(error?.message || error) }); }
    catch { /* sender may have gone away during an extension reload */ }
  });
  return true;
};
if (ensureLiveExtensionContext("extension context invalidated before registering messages")) {
  try {
    const messageEvent = globalThis.chrome?.runtime?.onMessage;
    const addListener = messageEvent?.addListener;
    if (typeof addListener === "function") addListener.call(messageEvent, runtimeMessageListener);
    else disposeContentScript("runtime message API unavailable");
  } catch (error) {
    if (isLifecycleError(error)) disposeContentScript("extension context invalidated while registering messages");
    else throw error;
  }

  runSafely((async () => {
    await refreshProjectContext({ forceNotify: true });
    if (!instance.disposed && initialDownloadPassPending && !downloadScanTimer) scheduleInitialDownloadPass();
  })());
}

})();
