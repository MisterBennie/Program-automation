const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function refresh() {
  const messageElement = document.getElementById("message");
  const errorElement = document.getElementById("error");

  try {
    const response = await chrome.runtime.sendMessage({ type: "get_status" });
    if (!response?.ok) {
      throw new Error(response?.error || "Could not read extension status");
    }

    document.getElementById("enabled").checked = Boolean(response.settings.enabled);
    messageElement.textContent = response.status.message || "Ready";
    document.getElementById("project").textContent = response.status.activeProject || "—";
    document.getElementById("profile").textContent = response.status.activeProfile || "—";
    document.getElementById("helper").textContent = response.status.nativeConnected ? "Connected" : "Disconnected";
    document.getElementById("queue").textContent = String(response.queueLength || 0);
    document.getElementById("lastFile").textContent = response.status.lastFile || "—";
    document.getElementById("extensionVersion").textContent = response.extensionVersion || "—";
    document.getElementById("contentVersion").textContent = response.contentVersion || "not loaded";
    const displayedError = response.status.lastError || response.contentVersionError || "";
    errorElement.hidden = !displayedError;
    errorElement.textContent = displayedError;
    return response;
  } catch (error) {
    document.getElementById("project").textContent = "—";
    document.getElementById("profile").textContent = "—";
    document.getElementById("helper").textContent = "Disconnected";
    document.getElementById("extensionVersion").textContent = "—";
    document.getElementById("contentVersion").textContent = "—";
    messageElement.textContent = "Could not read bridge status";
    errorElement.hidden = false;
    errorElement.textContent = error?.message || String(error);
    return null;
  }
}

document.getElementById("enabled").addEventListener("change", async (event) => {
  await chrome.runtime.sendMessage({ type: "set_enabled", enabled: event.target.checked });
  await refresh();
});

document.getElementById("reconnect").addEventListener("click", async () => {
  const button = document.getElementById("reconnect");
  const messageElement = document.getElementById("message");
  const errorElement = document.getElementById("error");

  button.disabled = true;
  button.textContent = "Reconnecting…";
  messageElement.textContent = "Reconnecting native helper…";
  errorElement.hidden = true;
  errorElement.textContent = "";

  try {
    const response = await chrome.runtime.sendMessage({ type: "retry_connection" });
    if (!response?.ok) {
      throw new Error(response?.error || "Reconnect request failed");
    }

    // Native host startup and its first status message are asynchronous.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await sleep(500);
      const status = await refresh();
      if (status?.status?.nativeConnected) break;
    }
  } catch (error) {
    messageElement.textContent = "Reconnect failed";
    errorElement.hidden = false;
    errorElement.textContent = error?.message || String(error);
  } finally {
    button.disabled = false;
    button.textContent = "Reconnect helper";
    await refresh();
  }
});

document.getElementById("scan").addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage({ type: "scan_downloads" });
  document.getElementById("message").textContent = response?.ok ? "Result buttons scanned" : response?.error || "Scan failed";
});

document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
refresh();
