const API_BASE = "http://127.0.0.1:8000";
const $ = (selector) => document.querySelector(selector);
const form = $("#creditForm");
let latestApplication = null;
let latestProbability = null;
let latestExplanation = [];
let currentThreshold = 0.50;
let selectedCsv = null;

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 3300);
}

function setApiStatus(online, message) {
  $("#apiDot").className = `status-dot ${online ? "online" : "offline"}`;
  $("#apiStatus").textContent = online ? "API connected" : "API unavailable";
  $("#apiMessage").textContent = message;
  $("#modelStatus").textContent = online ? "Online" : "Offline";
}

async function checkHealth() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    if (!response.ok) throw new Error("Health endpoint returned an error");
    const data = await response.json();
    setApiStatus(Boolean(data.model_loaded), data.model_loaded ? "Model loaded and ready" : "API reachable · model not loaded");
  } catch {
    setApiStatus(false, "Start the FastAPI backend");
  }
}

function readApplication() {
  const data = Object.fromEntries(new FormData(form).entries());
  data.person_age = Number(data.person_age);
  data.person_income = Number(data.person_income);
  data.person_emp_length = Number(data.person_emp_length);
  data.loan_amnt = Number(data.loan_amnt);
  data.loan_int_rate = Number(data.loan_int_rate);
  data.cb_person_cred_hist_length = Number(data.cb_person_cred_hist_length);
  if (data.person_age < 18) throw new Error("Applicant age must be at least 18.");
  if (data.person_income <= 0) throw new Error("Annual income must be greater than zero.");
  if (data.loan_amnt <= 0) throw new Error("Loan amount must be greater than zero.");
  if (data.person_emp_length < 0 || data.cb_person_cred_hist_length < 0) throw new Error("Employment and credit history lengths cannot be negative.");
  if (data.loan_int_rate < 0 || data.loan_int_rate > 100) throw new Error("Interest rate must be between 0 and 100.");
  return data;
}

function updateRatio() {
  const income = Number(form.elements.person_income.value);
  const amount = Number(form.elements.loan_amnt.value);
  $("#ratioValue").textContent = income > 0 && amount > 0 ? `${(amount / income).toFixed(3)} (${(amount / income * 100).toFixed(1)}%)` : "—";
}
form.addEventListener("input", updateRatio);

function getRisk(probability) {
  if (probability < 0.20) return "Low";
  if (probability < 0.50) return "Medium";
  return "High";
}

function getDecision(probability, threshold = currentThreshold) {
  return probability >= threshold ? "Reject" : "Approve";
}

function renderDecision(probability, threshold = currentThreshold) {
  const risk = getRisk(probability);
  const decision = getDecision(probability, threshold);
  $("#probabilityValue").textContent = (probability * 100).toFixed(1);
  $("#probabilityBar").style.width = `${Math.min(100, Math.max(0, probability * 100))}%`;
  $("#probabilityBar").style.background = risk === "High" ? "#bd5a55" : risk === "Medium" ? "#c38b37" : "#16816d";
  $("#riskBadge").textContent = `${risk.toUpperCase()} RISK`;
  $("#riskBadge").className = `risk-badge ${risk.toLowerCase()}`;
  $("#decisionValue").textContent = decision;
  $("#decisionMark").textContent = decision === "Approve" ? "✓" : "!";
  $("#decisionMark").className = `decision-mark ${decision === "Reject" ? "reject" : ""}`;
  $("#resultThresholdValue").textContent = `${Math.round(threshold * 100)}%`;
  $("#resultThreshold").value = Math.round(threshold * 100);
  $("#globalThreshold").value = Math.round(threshold * 100);
  $("#thresholdValue").textContent = Math.round(threshold * 100);
}

function renderExplanation(items) {
  const container = $("#explanationList");
  if (!Array.isArray(items) || !items.length) {
    container.innerHTML = '<p class="muted tiny">No feature explanation was returned by the API.</p>';
    return;
  }
  const max = Math.max(...items.map(item => Math.abs(Number(item.impact) || 0)), 0.000001);
  container.innerHTML = items.slice(0, 10).map(item => {
    const impact = Number(item.impact) || 0;
    const width = Math.max(3, Math.abs(impact) / max * 100);
    const positive = impact > 0;
    const direction = item.direction || (positive ? "Increases risk" : "Decreases risk");
    return `<div class="explanation-item"><div><div class="explanation-name">${escapeHtml(item.feature)}</div><div class="explanation-direction">${escapeHtml(direction)} · ${impact.toFixed(4)}</div></div><div class="impact-track"><span class="${positive ? "positive" : "negative"}" style="width:${width}%"></span></div></div>`;
  }).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}

function getHistory() {
  try { return JSON.parse(localStorage.getItem("credence_history") || "[]"); }
  catch { return []; }
}

function saveHistory(application, result) {
  const history = getHistory();
  history.unshift({
    date: new Date().toISOString(),
    applicant: `Age ${application.person_age}`,
    loan: application.loan_amnt,
    probability: result.default_probability,
    risk: getRisk(result.default_probability),
    decision: getDecision(result.default_probability)
  });
  localStorage.setItem("credence_history", JSON.stringify(history.slice(0, 100)));
  renderHistory();
}

function renderHistory() {
  const history = getHistory();
  $("#totalAssessments").textContent = history.length;
  $("#highRiskCount").textContent = history.filter(item => item.risk === "High").length;
  $("#approvalRate").textContent = history.length ? `${Math.round(history.filter(item => item.decision === "Approve").length / history.length * 100)}%` : "—";
  $("#historyBody").innerHTML = history.length ? history.map(item => `
    <tr>
      <td>${new Date(item.date).toLocaleString()}</td>
      <td>${escapeHtml(item.applicant)}</td>
      <td>$${Number(item.loan).toLocaleString()}</td>
      <td>${(Number(item.probability) * 100).toFixed(1)}%</td>
      <td><span class="table-risk ${item.risk.toLowerCase()}">${item.risk}</span></td>
      <td class="${item.decision === "Approve" ? "decision-approved" : "decision-rejected"}">${item.decision}</td>
    </tr>`).join("") : '<tr><td colspan="6" class="table-empty">No predictions yet. Your completed assessments will appear here.</td></tr>';
}

async function postJson(path, body) {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = typeof data.detail === "string" ? data.detail : JSON.stringify(data.detail || data);
    throw new Error(detail || `Request failed (${response.status})`);
  }
  return data;
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  $("#formError").textContent = "";
  let application;
  try { application = readApplication(); }
  catch (error) { $("#formError").textContent = error.message; return; }

  const button = $("#predictBtn");
  button.disabled = true;
  button.textContent = "Assessing applicant…";
  try {
    currentThreshold = Number($("#globalThreshold").value) / 100;
    const result = await postJson("/predict", {application, threshold: currentThreshold});
    latestApplication = application;
    latestProbability = Number(result.default_probability);
    $("#emptyState").classList.add("hidden");
    $("#resultContent").classList.remove("hidden");
    renderDecision(latestProbability, currentThreshold);
    saveHistory(application, result);
    $("#whatIfResult").classList.add("hidden");
    $("#whatIfAmount").value = "";
    $("#whatIfRate").value = "";
    try {
      const explanation = await postJson("/explain", {application, threshold: currentThreshold});
      latestExplanation = explanation.explanation || [];
      renderExplanation(latestExplanation);
    } catch (error) {
      latestExplanation = [];
      renderExplanation([]);
      showToast(`Prediction succeeded; explanation unavailable: ${error.message}`);
    }
    $("#results").scrollIntoView({behavior:"smooth", block:"start"});
  } catch (error) {
    $("#formError").textContent = error.message;
    showToast("Prediction request failed. Check the API connection.");
  } finally {
    button.disabled = false;
    button.innerHTML = 'Run risk assessment <span>→</span>';
  }
});

function updateThreshold(value) {
  currentThreshold = Number(value) / 100;
  $("#thresholdValue").textContent = value;
  $("#resultThresholdValue").textContent = `${value}%`;
  if (latestProbability !== null) renderDecision(latestProbability, currentThreshold);
  const history = getHistory();
  if (history.length) {
    history[0].decision = getDecision(history[0].probability, currentThreshold);
    localStorage.setItem("credence_history", JSON.stringify(history));
    renderHistory();
  }
}
$("#globalThreshold").addEventListener("input", event => {
  $("#resultThreshold").value = event.target.value;
  updateThreshold(event.target.value);
});
$("#resultThreshold").addEventListener("input", event => {
  $("#globalThreshold").value = event.target.value;
  updateThreshold(event.target.value);
});

$("#whatIfBtn").addEventListener("click", async () => {
  if (!latestApplication) return showToast("Run an assessment first.");
  const amountValue = $("#whatIfAmount").value;
  const rateValue = $("#whatIfRate").value;
  if (!amountValue && !rateValue) return showToast("Enter a new loan amount or interest rate.");
  const payload = {application: latestApplication, threshold: currentThreshold};
  if (amountValue) payload.loan_amnt = Number(amountValue);
  if (rateValue) payload.loan_int_rate = Number(rateValue);
  if ((payload.loan_amnt && payload.loan_amnt <= 0) || (payload.loan_int_rate !== undefined && (payload.loan_int_rate < 0 || payload.loan_int_rate > 100))) return showToast("Check the what-if values.");
  const button = $("#whatIfBtn");
  button.disabled = true;
  button.textContent = "Comparing…";
  try {
    const result = await postJson("/what-if", payload);
    const original = result.original_prediction;
    const scenario = result.what_if_prediction;
    const delta = Number(result.probability_difference);
    $("#whatIfResult").classList.remove("hidden");
    $("#whatIfResult").innerHTML = `<strong>Scenario result: ${(scenario.default_probability * 100).toFixed(1)}% default probability · ${escapeHtml(getDecision(scenario.default_probability))}</strong><br>Original: ${(original.default_probability * 100).toFixed(1)}% · Change: ${delta > 0 ? "+" : ""}${(delta * 100).toFixed(2)} percentage points.`;
  } catch (error) {
    showToast(`What-if failed: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Compare scenario →";
  }
});

$("#csvFile").addEventListener("change", event => {
  selectedCsv = event.target.files[0] || null;
  $("#batchBtn").disabled = !selectedCsv;
  $("#batchFileName").classList.toggle("hidden", !selectedCsv);
  $("#batchFileName").textContent = selectedCsv ? `Selected: ${selectedCsv.name} · ${(selectedCsv.size / 1024).toFixed(1)} KB` : "";
  $("#batchMessage").textContent = selectedCsv ? "Ready to upload this CSV for scoring." : "Your downloaded file will include a prediction for each row.";
});

$("#batchBtn").addEventListener("click", async () => {
  if (!selectedCsv) return;
  if (selectedCsv.size > 10 * 1024 * 1024) return showToast("CSV must be 10 MB or smaller.");
  const button = $("#batchBtn");
  button.disabled = true;
  button.textContent = "Processing…";
  try {
    const data = new FormData();
    data.append("file", selectedCsv);
    data.append("threshold", String(currentThreshold));
    const response = await fetch(`${API_BASE}/predict-batch`, {method:"POST", body:data});
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(typeof errorData.detail === "string" ? errorData.detail : JSON.stringify(errorData.detail || "Batch request failed"));
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "credit_risk_predictions.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    $("#batchMessage").textContent = "Batch predictions downloaded successfully.";
    showToast("Batch prediction file downloaded.");
  } catch (error) {
    showToast(`Batch prediction failed: ${error.message}`);
    $("#batchMessage").textContent = "Upload failed. Check the CSV columns and API.";
  } finally {
    button.disabled = !selectedCsv;
    button.textContent = "Run batch prediction →";
  }
});

$("#clearHistory").addEventListener("click", () => {
  if (!confirm("Clear all prediction history saved in this browser?")) return;
  localStorage.removeItem("credence_history");
  renderHistory();
});

renderHistory();
checkHealth();
setInterval(checkHealth, 30000);
