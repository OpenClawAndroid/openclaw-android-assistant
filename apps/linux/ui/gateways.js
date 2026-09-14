const { invoke } = window.__TAURI__.core;
const elements = Object.fromEntries([
  "add-gateway", "gateway-status", "gateway-error", "retry-load", "profiles", "gateway-editor",
  "editor-title", "gateway-name", "gateway-transport", "direct-fields", "gateway-url", "ssh-fields",
  "gateway-ssh", "gateway-port", "gateway-fingerprint", "gateway-auth", "credential-hint",
  "gateway-token", "gateway-password", "cancel-edit", "save-gateway", "remove-dialog",
  "remove-description", "cancel-remove", "confirm-remove",
].map((id) => [id, document.getElementById(id)]));
let profiles = [];
let editingId;
let removingId;
let busy = false;
let profilesReady = false;
let recoveryId;
let refreshPending = false;

const request = (message) => invoke("gateway_profile_request", { message });
const showError = (error) => {
  elements["gateway-error"].textContent = String(error);
  elements["gateway-error"].hidden = false;
};
const clearError = () => { elements["gateway-error"].hidden = true; };
const setBusy = (value) => {
  busy = value;
  for (const control of document.querySelectorAll(".gateways-panel :is(button, input, select), #remove-dialog button")) control.disabled = value;
  elements.profiles.setAttribute("aria-busy", String(value));
  if (!value) {
    syncTransport();
    if (refreshPending) void perform(load);
    else applyRecovery();
  }
};
const perform = async (action) => {
  if (busy) return;
  clearError();
  setBusy(true);
  try { await action(); }
  catch (error) { showError(error); }
  finally { setBusy(false); }
};
const syncTransport = () => {
  const ssh = elements["gateway-transport"].value === "ssh";
  elements["direct-fields"].hidden = ssh;
  elements["ssh-fields"].hidden = !ssh;
  elements["gateway-url"].required = !ssh;
  elements["gateway-ssh"].required = ssh;
  elements["gateway-port"].required = ssh;
  elements["gateway-url"].disabled = ssh;
  for (const id of ["gateway-ssh", "gateway-port", "gateway-fingerprint"]) elements[id].disabled = !ssh;
};
const resetEditor = () => {
  elements["gateway-editor"].reset();
  elements["gateway-name"].setCustomValidity("");
  elements["gateway-password"].setCustomValidity("");
};
const closeEditor = () => {
  resetEditor();
  elements["gateway-editor"].hidden = true;
  editingId = undefined;
};
const editProfile = (profile) => {
  clearError();
  resetEditor();
  editingId = profile?.id;
  elements["editor-title"].textContent = profile ? "Edit Gateway" : "Add Gateway";
  elements["gateway-name"].value = profile?.name ?? "";
  elements["gateway-transport"].value = profile?.transport ?? "direct";
  elements["gateway-url"].value = profile?.url ?? "";
  elements["gateway-ssh"].value = profile?.sshTarget ?? "";
  elements["gateway-port"].value = profile?.remotePort ?? 18789;
  elements["gateway-fingerprint"].value = profile?.tlsFingerprint ?? "";
  elements["gateway-auth"].open = false;
  elements["credential-hint"].textContent = profile?.hasToken || profile?.hasPassword
    ? "Saved credentials stay hidden. Leave both fields blank to keep them for the same connection. Enter a token or password to replace them."
    : "Enter a token or password if the Gateway requires one.";
  syncTransport();
  elements["gateway-editor"].hidden = false;
  elements["gateway-name"].focus();
};
const applyRecovery = () => {
  if (busy || !profilesReady) return;
  const recovery = window.__OPENCLAW_GATEWAY_RECOVERY__;
  if (!recovery) return;
  delete window.__OPENCLAW_GATEWAY_RECOVERY__;
  if (elements["gateway-editor"].hidden) {
    const profile = profiles.find((entry) => entry.id === recovery.id);
    if (profile) editProfile(profile);
  }
  recoveryId = recovery.id;
  if (recovery.error.trim()) showError(recovery.error);
  else clearError();
};
const refreshProfiles = () => {
  refreshPending = true;
  if (!busy) void perform(load);
};
window.addEventListener("openclaw:gateway-recovery", (event) => {
  window.__OPENCLAW_GATEWAY_RECOVERY__ = event.detail;
  refreshProfiles();
});
window.addEventListener("openclaw:gateway-profiles-changed", (event) => {
  const { previousId, id } = event.detail;
  if (previousId) {
    if (editingId === previousId && id) editingId = id;
    if (recoveryId === previousId) recoveryId = id;
    if (window.__OPENCLAW_GATEWAY_RECOVERY__?.id === previousId) {
      delete window.__OPENCLAW_GATEWAY_RECOVERY__;
    }
    if (removingId === previousId) elements["remove-dialog"].close();
  }
  refreshProfiles();
});
const modalState = (open) => window.dispatchEvent(new CustomEvent("openclaw:native-modal-state", { detail: { open } }));
const renderProfiles = (selectedId) => {
  elements.profiles.replaceChildren();
  for (const profile of profiles) {
    const row = document.createElement("li");
    row.className = "gateway-profile";
    const copy = document.createElement("div");
    copy.className = "gateway-copy";
    const name = document.createElement("strong");
    name.className = "gateway-name";
    name.textContent = profile.name;
    const endpoint = document.createElement("span");
    endpoint.className = "gateway-endpoint";
    endpoint.textContent = profile.transport === "ssh"
      ? `${profile.sshTarget} · SSH · port ${profile.remotePort ?? 18789}`
      : profile.url;
    copy.append(name, endpoint);
    if (profile.id === selectedId) {
      const current = document.createElement("span");
      current.className = "hint";
      current.textContent = "Selected Gateway";
      copy.append(current);
    }
    const actions = document.createElement("div");
    actions.className = "gateway-profile-actions";
    for (const [label, action] of [
      ["Open", () => void perform(async () => {
        await request({ action: "open", id: profile.id });
        elements["gateway-status"].textContent = `Opened ${profile.name} in a separate window.`;
      })],
      ["Edit", () => editProfile(profile)],
      ["Remove", () => {
        removingId = profile.id;
        elements["remove-description"].textContent = `Remove “${profile.name}” from this computer? Its Gateway will keep running.`;
        elements["remove-dialog"].showModal();
        modalState(true);
      }],
    ]) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.setAttribute("aria-label", `${label} ${profile.name}`);
      button.addEventListener("click", action);
      actions.append(button);
    }
    row.append(copy, actions);
    elements.profiles.append(row);
  }
};
const load = async () => {
  refreshPending = false;
  profilesReady = false;
  elements["retry-load"].hidden = true;
  try {
    const result = await request({ action: "list" });
    // A newer notification may already have rebound drafts to different IDs.
    if (refreshPending) return;
    profiles = result.profiles;
    renderProfiles(result.selectedId);
    elements["gateway-status"].textContent = profiles.length
      ? `${profiles.length} saved ${profiles.length === 1 ? "Gateway" : "Gateways"}`
      : "No saved Gateways yet. Add a connection to get started.";
    const recovery = window.__OPENCLAW_GATEWAY_RECOVERY__;
    if (recovery && recoveryId && editingId === recoveryId) editingId = recovery.id;
    if (editingId && !profiles.some((profile) => profile.id === editingId)) {
      editingId = undefined;
      elements["editor-title"].textContent = "Add Gateway";
      elements["credential-hint"].textContent = "Enter a token or password if the Gateway requires one.";
      elements["gateway-status"].textContent = "This saved Gateway was removed elsewhere. Your draft is preserved; Save adds it again.";
    }
    profilesReady = true;
  } catch (error) {
    elements["gateway-status"].textContent = "Could not load saved Gateways.";
    elements["retry-load"].hidden = false;
    throw error;
  }
};
elements["add-gateway"].addEventListener("click", () => editProfile());
elements["retry-load"].addEventListener("click", () => void perform(load));
elements["cancel-edit"].addEventListener("click", () => {
  closeEditor();
  elements["add-gateway"].focus();
});
elements["gateway-transport"].addEventListener("change", syncTransport);
elements["gateway-name"].addEventListener("input", () => elements["gateway-name"].setCustomValidity(""));
for (const id of ["gateway-token", "gateway-password"]) {
  elements[id].addEventListener("input", () => elements["gateway-password"].setCustomValidity(""));
}
elements["gateway-editor"].addEventListener("submit", (event) => {
  event.preventDefault();
  const name = elements["gateway-name"].value.trim();
  elements["gateway-name"].setCustomValidity(name ? "" : "Enter a Gateway name.");
  const token = elements["gateway-token"].value.trim();
  const password = elements["gateway-password"].value;
  elements["gateway-password"].setCustomValidity(token && password ? "Use either a token or a password." : "");
  if (!elements["gateway-editor"].reportValidity()) return;
  const ssh = elements["gateway-transport"].value === "ssh";
  const connection = {
    transport: ssh ? "ssh" : "direct",
    ...(ssh ? {
      sshTarget: elements["gateway-ssh"].value.trim(),
      remotePort: Number(elements["gateway-port"].value),
      tlsFingerprint: elements["gateway-fingerprint"].value.trim() || null,
    } : { url: elements["gateway-url"].value.trim() }),
    token: token || null,
    password: password || null,
  };
  void perform(async () => {
    await request({ action: "save", id: editingId, name, connection });
    closeEditor();
    await load();
    elements["gateway-status"].textContent = `Saved ${name}.`;
  });
});
elements["cancel-remove"].addEventListener("click", () => elements["remove-dialog"].close());
elements["remove-dialog"].addEventListener("close", () => {
  removingId = undefined;
  modalState(false);
});
elements["confirm-remove"].addEventListener("click", () => {
  const id = removingId;
  elements["remove-dialog"].close();
  void perform(async () => {
    await request({ action: "remove", id });
    if (editingId === id) closeEditor();
    await load();
  });
});
void perform(load);
