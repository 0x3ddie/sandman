const form = document.querySelector("#probe-form");
const runButton = document.querySelector("#run-button");
const formError = document.querySelector("#form-error");
const runState = document.querySelector("#run-state");
const emptyState = document.querySelector("#empty-state");
const laneGrid = document.querySelector("#lane-grid");
const verdict = document.querySelector("#verdict");
let selectedRuntime = "demo";
let currentInvestigationId = null;
let currentReport = null;
let currentHotfixId = null;

const demoValues = {
  repository: "https://github.com/0x3ddie/sandman-demo",
  "known-good-ref": "v1.4.2",
  "current-ref": "main",
  "candidate-ref": "sandman/currency-validation",
  method: "POST",
  path: "/api/checkout/quote",
  "expected-status": "200",
  "json-body": JSON.stringify({ items: [{ sku: "dream-01", quantity: 2 }], currency: "USD" }, null, 2),
};

function resetDemo() {
  Object.entries(demoValues).forEach(([id, value]) => {
    document.querySelector(`#${id}`).value = value;
  });
  formError.textContent = "";
}

document.querySelector("#demo-button").addEventListener("click", resetDemo);
document.querySelectorAll(".runtime").forEach((button) => {
  button.addEventListener("click", () => {
    selectedRuntime = button.dataset.runtime;
    document.querySelectorAll(".runtime").forEach((candidate) => candidate.classList.remove("active"));
    button.classList.add("active");
  });
});

function buildRequest() {
  let jsonBody = null;
  const bodyText = document.querySelector("#json-body").value.trim();
  if (bodyText) jsonBody = JSON.parse(bodyText);
  const startupCommand = JSON.parse(document.querySelector("#startup-command").value);
  if (!Array.isArray(startupCommand) || startupCommand.some((argument) => typeof argument !== "string")) {
    throw new TypeError("Startup command must be a JSON array of strings.");
  }
  const revision = (lane, field, shaField, label) => {
    const commitSha = document.querySelector(`#${shaField}`).value.trim();
    return {
      lane,
      git_ref: document.querySelector(`#${field}`).value.trim(),
      commit_sha: commitSha || null,
      label,
    };
  };
  return {
    repository_url: document.querySelector("#repository").value.trim(),
    revisions: [
      revision("known_good", "known-good-ref", "known-good-sha", "Known good"),
      revision("current", "current-ref", "current-sha", "Current"),
      revision("candidate", "candidate-ref", "candidate-sha", "Candidate"),
    ],
    startup_command: startupCommand,
    service_port: Number(document.querySelector("#service-port").value),
    health_path: document.querySelector("#health-path").value.trim(),
    container_image: document.querySelector("#container-image").value.trim(),
    runtime: selectedRuntime,
    probe: {
      method: document.querySelector("#method").value,
      path: document.querySelector("#path").value.trim(),
      json_body: jsonBody,
      expected_status: Number(document.querySelector("#expected-status").value),
    },
  };
}

function setRunning(running) {
  runButton.disabled = running;
  runButton.querySelector("span:first-child").textContent = running ? "Running probes…" : "Run comparison";
  runState.textContent = running ? "Running" : "Idle";
  runState.className = running ? "run-state running" : "run-state idle";
  if (running) {
    emptyState.classList.add("hidden");
    laneGrid.classList.remove("hidden");
    verdict.classList.add("hidden");
    laneGrid.innerHTML = ["Known good", "Current", "Candidate"]
      .map((name) => `
        <article class="lane-card">
          <span class="lane-signal"></span>
          <div><p class="lane-name">${name}</p><span class="lane-ref">starting sandbox</span></div>
          <div><span class="metric-label">Probe</span><br /><span class="metric">waiting</span></div>
          <span class="result-badge">PENDING</span>
        </article>`)
      .join("");
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderReport(report) {
  currentReport = report;
  laneGrid.innerHTML = report.results.map((result) => {
    const observation = result.observation;
    const state = observation.passed ? "pass" : "fail";
    const status = observation.status_code ?? "ERR";
    return `
      <article class="lane-card ${state}">
        <span class="lane-signal"></span>
        <div>
          <p class="lane-name">${escapeHtml(result.revision.label)}</p>
          <span class="lane-ref">${escapeHtml(result.revision.git_ref)}</span>
        </div>
        <div><span class="metric-label">HTTP / latency</span><br /><span class="metric">${status} · ${observation.duration_ms} ms</span></div>
        <span class="result-badge">${state.toUpperCase()}</span>
      </article>`;
  }).join("");
  document.querySelector("#verdict-headline").textContent = report.verdict.headline;
  document.querySelector("#verdict-detail").textContent = report.verdict.detail;
  verdict.classList.remove("hidden");
  document.querySelector("#review-actions").classList.toggle("hidden", !report.verdict.safe_to_review);
  document.querySelector("#pr-status").textContent = "";
  runState.textContent = "Complete";
  runState.className = "run-state complete";
}

document.querySelector("#create-pr-button").addEventListener("click", async () => {
  const button = document.querySelector("#create-pr-button");
  const status = document.querySelector("#pr-status");
  const repositoryUrl = currentReport?.request?.repository_url || "";
  const match = repositoryUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match || !currentInvestigationId) {
    status.textContent = "GitHub repository URL required";
    return;
  }
  const candidate = currentReport.request.revisions.find((revision) => revision.lane === "candidate");
  const current = currentReport.request.revisions.find((revision) => revision.lane === "current");
  button.disabled = true;
  status.textContent = "Creating draft…";
  try {
    const response = await fetch(`/api/investigations/${currentInvestigationId}/pull-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        owner: match[1],
        repository: match[2],
        head: candidate.git_ref,
        base: current.git_ref,
        title: `fix: ${currentReport.verdict.headline.toLowerCase()}`,
        draft: true,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || "GitHub rejected the request");
    status.innerHTML = `<a href="${escapeHtml(body.url)}" target="_blank" rel="noreferrer">Draft PR #${body.number} created ↗</a>`;
  } catch (error) {
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function waitForInvestigation(id) {
  for (;;) {
    const response = await fetch(`/api/investigations/${id}`);
    if (!response.ok) throw new Error("Could not read investigation status");
    const record = await response.json();
    if (record.state === "completed") return record.report;
    if (record.state === "failed") throw new Error(record.error || "Investigation failed");
    await new Promise((resolve) => window.setTimeout(resolve, 350));
  }
}

function buildHotfixRequest() {
  const currentSha = document.querySelector("#current-sha").value.trim();
  if (!/^[0-9a-fA-F]{40}$/.test(currentSha)) {
    throw new Error("Enter the current revision's full 40-character commit SHA first.");
  }
  if (!document.querySelector("#redaction-confirmed").checked) {
    throw new Error("Confirm that the incident evidence has been sanitized.");
  }
  const requestBody = document.querySelector("#json-body").value.trim();
  const observedBody = document.querySelector("#observed-json").value.trim();
  const logLines = document.querySelector("#incident-logs").value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const testGuidance = document.querySelector("#test-guidance").value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    repository_url: document.querySelector("#repository").value.trim(),
    base_ref: document.querySelector("#current-ref").value.trim(),
    base_commit_sha: currentSha,
    branch_name: document.querySelector("#candidate-ref").value.trim(),
    trace: {
      trace_id: document.querySelector("#trace-id").value.trim(),
      redacted: true,
      method: document.querySelector("#method").value,
      path: document.querySelector("#path").value.trim(),
      json_body: requestBody ? JSON.parse(requestBody) : null,
      observed: {
        status_code: Number(document.querySelector("#observed-status").value),
        json_body: observedBody ? JSON.parse(observedBody) : null,
      },
      expected_status: Number(document.querySelector("#expected-status").value),
      logs: logLines,
    },
    test_guidance: testGuidance,
  };
}

async function waitForHotfix(id) {
  for (;;) {
    const response = await fetch(`/api/hotfixes/${id}`);
    if (!response.ok) throw new Error("Could not read hotfix status");
    const record = await response.json();
    if (record.state === "completed") return record;
    if (record.state === "failed") throw new Error(record.error || "Hotfix generation failed");
    await new Promise((resolve) => window.setTimeout(resolve, 500));
  }
}

function renderHotfix(record) {
  const artifact = record.artifact;
  document.querySelector("#hotfix-placeholder").classList.add("hidden");
  document.querySelector("#hotfix-result").classList.remove("hidden");
  document.querySelector("#hotfix-output").classList.remove("empty");
  document.querySelector("#hotfix-summary").textContent = artifact.summary.summary;
  document.querySelector("#changed-files").innerHTML = artifact.changed_files
    .map((path) => `<div class="changed-file">${escapeHtml(path)}</div>`)
    .join("");
  document.querySelector("#hotfix-state").textContent = "Generated";
  document.querySelector("#hotfix-state").className = "run-state complete";
}

document.querySelector("#generate-hotfix-button").addEventListener("click", async () => {
  const button = document.querySelector("#generate-hotfix-button");
  const errorOutput = document.querySelector("#hotfix-error");
  let generationStarted = false;
  errorOutput.textContent = "";
  try {
    const request = buildHotfixRequest();
    button.disabled = true;
    button.querySelector("span:first-child").textContent = "Codex is generating…";
    document.querySelector("#hotfix-state").textContent = "Generating";
    document.querySelector("#hotfix-state").className = "run-state running";
    generationStarted = true;
    const response = await fetch("/api/hotfixes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail?.[0]?.msg || body.detail || "Could not start Codex");
    currentHotfixId = body.hotfix_id;
    renderHotfix(await waitForHotfix(currentHotfixId));
  } catch (error) {
    errorOutput.textContent = error instanceof SyntaxError ? "An incident JSON field is invalid." : error.message;
    document.querySelector("#hotfix-state").textContent = generationStarted ? "Failed" : "Ready";
    document.querySelector("#hotfix-state").className = generationStarted ? "run-state" : "run-state idle";
  } finally {
    button.disabled = false;
    button.querySelector("span:first-child").textContent = "Generate candidate patch";
  }
});

document.querySelector("#publish-hotfix-button").addEventListener("click", async () => {
  const button = document.querySelector("#publish-hotfix-button");
  const status = document.querySelector("#publish-status");
  if (!currentHotfixId) return;
  button.disabled = true;
  status.textContent = "Publishing…";
  try {
    const response = await fetch(`/api/hotfixes/${currentHotfixId}/publish`, { method: "POST" });
    const body = await response.json();
    if (!response.ok) throw new Error(body.detail || "Could not publish branch");
    document.querySelector("#candidate-sha").value = body.artifact.published_commit_sha;
    document.querySelector("#candidate-ref").value = body.artifact.branch_name;
    status.textContent = "Published · candidate SHA filled above";
    button.textContent = "Branch published";
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  formError.textContent = "";
  try {
    const request = buildRequest();
    setRunning(true);
    const response = await fetch("/api/investigations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.detail?.[0]?.msg || body.detail || "Could not start investigation");
    }
    const record = await response.json();
    currentInvestigationId = record.investigation_id;
    const report = await waitForInvestigation(record.investigation_id);
    renderReport(report);
  } catch (error) {
    formError.textContent = error instanceof SyntaxError ? "A JSON field is not valid JSON." : error.message;
    runState.textContent = "Failed";
    runState.className = "run-state";
  } finally {
    runButton.disabled = false;
    runButton.querySelector("span:first-child").textContent = "Run comparison";
  }
});

resetDemo();
