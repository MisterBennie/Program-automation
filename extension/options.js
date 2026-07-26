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

const PROFILE_FIELDS = [
  "label", "projectName", "projectId", "matchAnyProject", "profileEnabled",
  "uploadEnabled", "watchFolder", "uploadPattern", "stableSeconds", "retrySeconds",
  "maxFileMb", "uploadDelayMs", "promptText", "autoSubmit", "recursive",
  "includeExisting", "downloadEnabled", "downloadPattern", "downloadSubfolder", "downloadLastOnReload"
];

let model = {
  enabled: false,
  hostName: "com.local.chatgpt_folder_bridge",
  profiles: [],
  selectedProfileId: ""
};

function makeProfileId() {
  return crypto.randomUUID ? `profile-${crypto.randomUUID()}` : `profile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeProjectId(value) {
  const text = String(value || "").trim();
  const match = text.match(/(?:^|\/)(g-p-[^/?#]+)/i);
  if (match?.[1]) return match[1].toLowerCase();
  return /^g-p-[^/?#]+$/i.test(text) ? text.toLowerCase() : "";
}

function normalizeProfile(profile, index = 0) {
  const value = { ...PROFILE_DEFAULTS, ...(profile && typeof profile === "object" ? profile : {}) };
  value.id = String(value.id || makeProfileId());
  value.label = String(value.label || value.projectName || `Project profile ${index + 1}`).trim();
  value.projectName = String(value.projectName || "").replace(/\s+/g, " ").trim();
  value.projectId = normalizeProjectId(value.projectId);
  value.matchAnyProject = Boolean(value.matchAnyProject);
  value.enabled = Boolean(value.enabled);
  value.watchFolder = String(value.watchFolder || "").trim();
  value.uploadEnabled = Boolean(value.uploadEnabled);
  // Migrate v0.3.0 draft profiles that were created with uploads enabled
  // before a folder had been configured. This prevents unrelated profiles
  // from blocking Save.
  if (value.uploadEnabled && !value.watchFolder) value.uploadEnabled = false;
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

function showStatus(text, error = false) {
  const status = document.querySelector("#status");
  status.textContent = text;
  status.classList.toggle("error", error);
  setTimeout(() => {
    if (status.textContent === text) status.textContent = "";
  }, 7000);
}

function validateRegex(value, fieldName) {
  try { new RegExp(value, "i"); }
  catch (error) { throw new Error(`${fieldName}: ${error.message}`); }
}

function selectedProfile() {
  return model.profiles.find((profile) => profile.id === model.selectedProfileId) || model.profiles[0] || null;
}

function readCheckbox(id) {
  return Boolean(document.getElementById(id).checked);
}

function captureProfileForm() {
  const profile = selectedProfile();
  if (!profile) return;
  profile.label = document.getElementById("label").value.trim();
  profile.projectName = document.getElementById("projectName").value.replace(/\s+/g, " ").trim();
  profile.projectId = normalizeProjectId(document.getElementById("projectId").value);
  profile.matchAnyProject = readCheckbox("matchAnyProject");
  profile.enabled = readCheckbox("profileEnabled");
  profile.uploadEnabled = readCheckbox("uploadEnabled");
  profile.watchFolder = document.getElementById("watchFolder").value.trim();
  profile.uploadPattern = document.getElementById("uploadPattern").value;
  profile.stableSeconds = Number(document.getElementById("stableSeconds").value);
  profile.retrySeconds = Number(document.getElementById("retrySeconds").value);
  profile.maxFileBytes = Number(document.getElementById("maxFileMb").value) * 1024 * 1024;
  profile.uploadDelayMs = Number(document.getElementById("uploadDelayMs").value);
  profile.promptText = document.getElementById("promptText").value;
  profile.autoSubmit = readCheckbox("autoSubmit");
  profile.recursive = readCheckbox("recursive");
  profile.includeExisting = readCheckbox("includeExisting");
  profile.downloadEnabled = readCheckbox("downloadEnabled");
  profile.downloadPattern = document.getElementById("downloadPattern").value;
  profile.downloadSubfolder = document.getElementById("downloadSubfolder").value.trim();
  profile.downloadLastOnReload = readCheckbox("downloadLastOnReload");
}

function setValue(id, value) {
  const element = document.getElementById(id);
  if (element.type === "checkbox") element.checked = Boolean(value);
  else element.value = value ?? "";
}

function renderProfileSelect() {
  const select = document.getElementById("profileSelect");
  select.textContent = "";
  for (const profile of model.profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    const matcher = profile.matchAnyProject ? "all projects" : (profile.projectName || profile.projectId || "unmatched");
    option.textContent = `${profile.label || "Unnamed profile"} — ${matcher}`;
    select.append(option);
  }
  select.value = model.selectedProfileId;
  document.getElementById("delete-profile").disabled = model.profiles.length <= 1;
}

function renderProfile() {
  const profile = selectedProfile();
  if (!profile) return;
  setValue("label", profile.label);
  setValue("projectName", profile.projectName);
  setValue("projectId", profile.projectId);
  setValue("matchAnyProject", profile.matchAnyProject);
  setValue("profileEnabled", profile.enabled);
  setValue("uploadEnabled", profile.uploadEnabled);
  setValue("watchFolder", profile.watchFolder);
  setValue("uploadPattern", profile.uploadPattern);
  setValue("stableSeconds", profile.stableSeconds);
  setValue("retrySeconds", profile.retrySeconds);
  setValue("maxFileMb", Math.max(1, Math.round(profile.maxFileBytes / 1024 / 1024)));
  setValue("uploadDelayMs", profile.uploadDelayMs);
  setValue("promptText", profile.promptText);
  setValue("autoSubmit", profile.autoSubmit);
  setValue("recursive", profile.recursive);
  setValue("includeExisting", profile.includeExisting);
  setValue("downloadEnabled", profile.downloadEnabled);
  setValue("downloadPattern", profile.downloadPattern);
  setValue("downloadSubfolder", profile.downloadSubfolder);
  setValue("downloadLastOnReload", profile.downloadLastOnReload);
  renderProfileSelect();
}

function newProfile(overrides = {}) {
  return normalizeProfile({
    ...PROFILE_DEFAULTS,
    id: makeProfileId(),
    label: "New project",
    uploadEnabled: false,
    downloadEnabled: false,
    downloadSubfolder: "ChatGPT",
    ...overrides
  }, model.profiles.length);
}

async function restore() {
  const data = await chrome.storage.local.get({
    enabled: false,
    hostName: "com.local.chatgpt_folder_bridge",
    profiles: [],
    selectedProfileId: ""
  });
  model.enabled = Boolean(data.enabled);
  model.hostName = String(data.hostName || "com.local.chatgpt_folder_bridge");
  model.profiles = Array.isArray(data.profiles) && data.profiles.length
    ? data.profiles.map(normalizeProfile)
    : [newProfile({ label: "Default (all projects)", matchAnyProject: true })];
  model.selectedProfileId = model.profiles.some((profile) => profile.id === data.selectedProfileId)
    ? data.selectedProfileId
    : model.profiles[0].id;
  setValue("enabled", model.enabled);
  setValue("hostName", model.hostName);
  renderProfile();
}

function validateModel() {
  if (!model.hostName.trim()) throw new Error("Native host name is required");
  const fallbackProfiles = model.profiles.filter((profile) => profile.enabled && profile.matchAnyProject);
  if (fallbackProfiles.length > 1) throw new Error("Only one enabled all-projects fallback profile is allowed");

  for (const profile of model.profiles) {
    if (!profile.label) throw new Error("Every profile needs a label");

    // Disabled profiles may be kept as incomplete drafts without blocking Save.
    if (!profile.enabled) continue;

    if (!profile.matchAnyProject && !profile.projectId && !profile.projectName) {
      throw new Error(`${profile.label}: enter a project name/ID or enable the fallback option`);
    }
    if (profile.uploadEnabled) {
      if (!profile.watchFolder) throw new Error(`${profile.label}: folder to watch is required while uploads are enabled`);
      validateRegex(profile.uploadPattern, `${profile.label} upload pattern`);
    }
    if (profile.downloadEnabled) validateRegex(profile.downloadPattern, `${profile.label} download pattern`);
  }
}

for (const field of PROFILE_FIELDS) {
  document.getElementById(field)?.addEventListener("change", () => {
    captureProfileForm();
    renderProfileSelect();
  });
}

document.getElementById("profileSelect").addEventListener("change", (event) => {
  captureProfileForm();
  model.selectedProfileId = event.target.value;
  renderProfile();
});

document.getElementById("add-profile").addEventListener("click", () => {
  captureProfileForm();
  const profile = newProfile();
  model.profiles.push(profile);
  model.selectedProfileId = profile.id;
  renderProfile();
});

document.getElementById("add-current").addEventListener("click", async () => {
  try {
    captureProfileForm();
    const response = await chrome.runtime.sendMessage({ type: "get_current_project" });
    if (!response?.ok || !response.project) throw new Error(response?.error || "Could not detect the current project");
    const projectId = normalizeProjectId(response.project.id || response.project.href);
    const projectName = String(response.project.name || "").trim();
    const existing = model.profiles.find((profile) =>
      (projectId && profile.projectId === projectId) ||
      (projectName && profile.projectName.toLocaleLowerCase() === projectName.toLocaleLowerCase())
    );
    if (existing) {
      model.selectedProfileId = existing.id;
      renderProfile();
      showStatus(`Selected existing profile ${existing.label}`);
      return;
    }
    const profile = newProfile({
      label: projectName || projectId || "Current project",
      projectName,
      projectId,
      matchAnyProject: false,
      downloadSubfolder: projectName ? `ChatGPT/${projectName}` : "ChatGPT"
    });
    model.profiles.push(profile);
    model.selectedProfileId = profile.id;
    renderProfile();
    showStatus(`Added ${projectName || projectId}`);
  } catch (error) {
    showStatus(String(error?.message || error), true);
  }
});

document.getElementById("delete-profile").addEventListener("click", () => {
  if (model.profiles.length <= 1) return;
  const profile = selectedProfile();
  if (!profile || !confirm(`Delete profile “${profile.label}”?`)) return;
  const index = model.profiles.findIndex((item) => item.id === profile.id);
  model.profiles.splice(index, 1);
  model.selectedProfileId = model.profiles[Math.max(0, index - 1)]?.id || model.profiles[0].id;
  renderProfile();
});

document.getElementById("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    captureProfileForm();
    model.enabled = readCheckbox("enabled");
    model.hostName = document.getElementById("hostName").value.trim();
    model.profiles = model.profiles.map(normalizeProfile);
    validateModel();
    await chrome.storage.local.set({
      enabled: model.enabled,
      hostName: model.hostName,
      profiles: model.profiles,
      selectedProfileId: model.selectedProfileId
    });
    await chrome.runtime.sendMessage({ type: "settings_changed" });
    renderProfile();
    showStatus("Saved project profiles");
  } catch (error) {
    showStatus(String(error?.message || error), true);
  }
});

document.getElementById("test").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "retry_connection" });
  showStatus(response?.ok ? "Reconnect requested" : response?.error || "Reconnect failed", !response?.ok);
});

restore().catch((error) => showStatus(String(error?.message || error), true));
