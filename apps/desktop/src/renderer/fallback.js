/* global window, document */
const bridge = window.ballast;
const phase = document.getElementById("phase");
const version = document.getElementById("version");
const pid = document.getElementById("pid");
const url = document.getElementById("url");
const data = document.getElementById("data");
const summary = document.getElementById("summary");
const error = document.getElementById("error");

const text = (element, value) => {
  if (element) element.textContent = value === null || value === undefined ? "—" : String(value);
};

function render(status) {
  text(phase, status.phase);
  text(version, status.runningVersion ?? status.builtVersion);
  text(pid, status.pid);
  text(url, status.url);
  text(data, status.paths ? status.paths.dataDir : null);
  if (summary) {
    summary.textContent = status.running
      ? "Service is running. Opening the Ballast UI…"
      : status.phase === "starting" || status.phase === "updating" || status.phase === "restarting"
        ? "Starting the background service…"
        : "The background service is not running.";
  }
  if (error) {
    error.hidden = !status.lastError;
    error.textContent = status.lastError ?? "";
  }
}

async function refresh() {
  if (!bridge) {
    if (summary) summary.textContent = "The desktop bridge is unavailable.";
    return;
  }
  try {
    const status = await bridge.service.status();
    render(status);
    if (status.running) await bridge.app.openUi();
  } catch (cause) {
    if (error) {
      error.hidden = false;
      error.textContent = cause instanceof Error ? cause.message : String(cause);
    }
  }
}

document.getElementById("retry")?.addEventListener("click", () => {
  void refresh();
});
document.getElementById("logs")?.addEventListener("click", () => {
  if (bridge) void bridge.app.showLogs();
});

if (bridge) {
  bridge.events.onServiceStatus(render);
  void refresh();
  setInterval(() => {
    void refresh();
  }, 2000);
}
