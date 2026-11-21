const API_BASE = "https://credence-credit-risk-2.onrender.com";

// Render free instances can take ~30-60s to wake up.
const REQUEST_TIMEOUT_MS = 60000;

// ==========================================
// 1. DOM HELPERS + STATE
// ==========================================

const $ = (selector) => document.querySelector(selector);

let currentPrediction = null;
let currentExplanation = null;
let currentThreshold = 0.5;

// Fields the backend accepts (CreditRiskInput has extra="forbid",
// so anything else in the form must NOT be sent).
const NUMERIC_FIELDS = [
    "person_age",
    "person_income",
    "person_emp_length",
    "loan_amnt",
    "loan_int_rate",
    "cb_person_cred_hist_length"
];

const TEXT_FIELDS = [
    "person_home_ownership",
    "loan_intent",
    "loan_grade",
    "cb_person_default_on_file"
];


// ==========================================
// 2. ERROR FORMATTER
// ==========================================

function formatApiError(detail) {
    if (typeof detail === "string") {
        return detail;
    }

    if (Array.isArray(detail)) {
        return detail.map((item, index) => {
            if (typeof item === "string") return item;

            const location = Array.isArray(item.loc)
                ? item.loc.join(" → ")
                : "Unknown field";

            const message =
                item.msg ||
                item.message ||
                JSON.stringify(item);

            return `${index + 1}. ${location}: ${message}`;
        }).join("\n");
    }

    if (detail && typeof detail === "object") {
        return Object.entries(detail)
            .map(([key, value]) => {
                const formattedValue =
                    typeof value === "object"
                        ? JSON.stringify(value)
                        : String(value);

                return `${key}: ${formattedValue}`;
            })
            .join("\n");
    }

    return String(detail || "An unknown error occurred.");
}


// ==========================================
// 3. API STATUS / HEALTH CHECK
// ==========================================

function setApiStatus(isOnline, message = "") {
    const apiDot = $("#apiDot");
    const apiStatus = $("#apiStatus");
    const apiMessage = $("#apiMessage");
    const modelStatus = $("#modelStatus");

    if (apiDot) {
        apiDot.classList.toggle("online", isOnline);
        apiDot.classList.toggle("offline", !isOnline);
    }

    if (apiStatus) {
        apiStatus.textContent = isOnline
            ? "API Connected"
            : "API Unavailable";
    }

    if (apiMessage) {
        apiMessage.textContent = message;
    }

    if (modelStatus) {
        modelStatus.textContent = isOnline ? "Online" : "Offline";
    }
}


async function checkHealth() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        const response = await fetch(`${API_BASE}/health`, {
            signal: controller.signal
        });

        if (!response.ok) {
            throw new Error(`Health check failed: ${response.status}`);
        }

        const data = await response.json();

        const isOnline =
            data.status === "healthy" &&
            data.model_loaded === true;

        setApiStatus(
            isOnline,
            isOnline
                ? "Model loaded and ready"
                : "API reachable · model not loaded"
        );

    } catch (error) {
        console.error("Health check error:", error);

        const reason = error.name === "AbortError"
            ? "request timed out (server may be waking up)"
            : error.message;

        setApiStatus(false, `Connection failed: ${reason}`);

    } finally {
        clearTimeout(timer);
    }
}


// ==========================================
// 4. APPLICATION INPUTS
// ==========================================

function readApplication() {
    const form = $("#creditForm");

    if (!form) {
        throw new Error("Credit form not found.");
    }

    const formData = new FormData(form);
    const data = {};

    for (const field of NUMERIC_FIELDS) {
        const raw = String(formData.get(field) ?? "").trim();

        if (raw === "") {
            throw new Error(`Please complete the ${field} field.`);
        }

        const value = Number(raw);

        if (!Number.isFinite(value)) {
            throw new Error(`${field} must be a valid number.`);
        }

        data[field] = value;
    }

    for (const field of TEXT_FIELDS) {
        const raw = String(formData.get(field) ?? "").trim();

        if (raw === "") {
            throw new Error(`Please complete the ${field} field.`);
        }

        data[field] = raw;
    }

    // loan_percent_income is computed by the backend.
    return data;
}


// ==========================================
// 5. CREDIT UTILIZATION RATIO (optional UI)
// ==========================================

function updateRatio() {
    const balance = Number($("#balance")?.value || 0);
    const limit = Number($("#limit")?.value || 0);

    const ratio = limit > 0 ? (balance / limit) * 100 : 0;

    const ratioElement = $("#utilizationRatio");

    if (ratioElement) {
        ratioElement.textContent = `${ratio.toFixed(1)}%`;
    }

    const progress = $("#utilizationProgress");

    if (progress) {
        progress.style.width = `${Math.min(ratio, 100)}%`;
    }
}


// ==========================================
// 6. RISK CLASSIFICATION
// ==========================================

// Uses the same bands as the backend (Low / Medium / High).
function getRisk(probability, riskBand) {
    if (riskBand) return `${riskBand} Risk`;

    if (probability < 0.20) return "Low Risk";
    if (probability < 0.50) return "Medium Risk";

    return "High Risk";
}


// Same wording as the backend: Reject / Approve.
function getDecision(probability, threshold = currentThreshold) {
    return probability >= threshold ? "Reject" : "Approve";
}


// ==========================================
// 7. PREDICTION RESULT
// ==========================================

function renderDecision(result) {
    const probability = Number(result.default_probability);
    const nonDefaultProbability = Number(result.non_default_probability);

    if (
        !Number.isFinite(probability) ||
        !Number.isFinite(nonDefaultProbability)
    ) {
        throw new Error(
            "Invalid prediction response. Check the backend response format."
        );
    }

    currentPrediction = result;

    const defaultPercent = probability * 100;
    const nonDefaultPercent = nonDefaultProbability * 100;

    const risk = getRisk(probability, result.risk_band);
    const decision = getDecision(probability);

    const resultPanel = $("#resultPanel");

    if (resultPanel) {
        resultPanel.hidden = false;
        resultPanel.classList.add("visible");
    }

    const setText = (selector, text) => {
        const element = $(selector);
        if (element) element.textContent = text;
    };

    setText("#defaultProbability", `${defaultPercent.toFixed(2)}%`);
    setText("#nonDefaultProbability", `${nonDefaultPercent.toFixed(2)}%`);
    setText("#riskLevel", risk);
    setText("#decision", decision);
    setText("#currentThreshold", `${(currentThreshold * 100).toFixed(0)}%`);

    const gauge = $("#riskGauge");
    if (gauge) {
        gauge.style.setProperty("--risk", `${defaultPercent}%`);
    }

    const defaultBar = $("#defaultBar");
    if (defaultBar) {
        defaultBar.style.width = `${defaultPercent}%`;
    }

    const nonDefaultBar = $("#nonDefaultBar");
    if (nonDefaultBar) {
        nonDefaultBar.style.width = `${nonDefaultPercent}%`;
    }

    saveHistory(result);
}


// ==========================================
// 8. EXPLANATION
// ==========================================

function renderExplanation(data) {
    currentExplanation = data;

    const container = $("#explanation");

    if (!container) return;

    container.innerHTML = "";

    // Backend returns "explanation" / "explanations" with
    // { feature, impact, direction }.
    const factors =
        data.explanations ||
        data.explanation ||
        data.feature_importance ||
        data.top_features ||
        [];

    if (!Array.isArray(factors) || factors.length === 0) {
        container.textContent = "No explanation available.";
        return;
    }

    factors.slice(0, 10).forEach((item) => {
        const name =
            item.feature ||
            item.name ||
            item.feature_name ||
            "Feature";

        const value =
            item.impact ??
            item.importance ??
            item.contribution ??
            item.value ??
            0;

        const row = document.createElement("div");
        row.className = "explanation-item";

        const nameElement = document.createElement("span");
        nameElement.textContent = String(name);

        const valueElement = document.createElement("span");

        if (typeof value === "number") {
            const sign = value > 0 ? "+" : "";
            valueElement.textContent = `${sign}${value.toFixed(4)}`;
            valueElement.classList.add(
                value > 0 ? "increases-risk" : "decreases-risk"
            );
        } else {
            valueElement.textContent = String(value);
        }

        if (item.direction) {
            row.title = item.direction;
        }

        row.append(nameElement, valueElement);
        container.appendChild(row);
    });
}


// ==========================================
// 9. LOCAL STORAGE HISTORY
// ==========================================

function getHistory() {
    try {
        const parsed = JSON.parse(
            localStorage.getItem("credenceHistory") || "[]"
        );

        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}


function saveHistory(result) {
    const probability = Number(result.default_probability);

    const history = getHistory();

    history.unshift({
        probability,
        risk: getRisk(probability, result.risk_band),
        date: new Date().toLocaleString()
    });

    try {
        localStorage.setItem(
            "credenceHistory",
            JSON.stringify(history.slice(0, 10))
        );
    } catch (error) {
        // Storage can be full or blocked (private mode); not fatal.
        console.warn("Could not save history:", error);
    }

    renderHistory();
}


function renderHistory() {
    const container = $("#historyList");

    if (!container) return;

    const history = getHistory();

    if (history.length === 0) {
        container.textContent = "No prediction history yet.";
        return;
    }

    container.innerHTML = "";

    history.forEach((item) => {
        const row = document.createElement("div");
        row.className = "history-item";

        const risk = document.createElement("span");
        risk.textContent = item.risk;

        const probability = document.createElement("span");
        probability.textContent =
            `${(Number(item.probability) * 100).toFixed(2)}%`;

        const date = document.createElement("small");
        date.textContent = item.date;

        row.append(risk, probability, date);
        container.appendChild(row);
    });
}


// ==========================================
// 10. API REQUEST HELPER
// ==========================================

async function postJson(path, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response;

    try {
        response = await fetch(`${API_BASE}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

    } catch (error) {
        if (error.name === "AbortError") {
            throw new Error(
                "The server took too long to respond. " +
                "It may be waking up; please try again."
            );
        }

        throw new Error(
            `Could not connect to the backend: ${error.message}`
        );

    } finally {
        clearTimeout(timer);
    }

    const responseText = await response.text();

    let data;

    try {
        data = responseText ? JSON.parse(responseText) : {};
    } catch {
        throw new Error(
            `Backend returned an invalid response (HTTP ${response.status}).`
        );
    }

    if (!response.ok) {
        const detail = data.detail ?? data.message ?? data;

        throw new Error(
            `HTTP ${response.status}: ${formatApiError(detail)}`
        );
    }

    return data;
}


// ==========================================
// 11. MAIN PREDICTION
// ==========================================

const creditForm = $("#creditForm");

if (creditForm) {
    creditForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        const submitButton = creditForm.querySelector(
            'button[type="submit"]'
        );

        const originalLabel = submitButton
            ? submitButton.textContent
            : "";

        try {
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.textContent = "Analyzing...";
            }

            const application = readApplication();

            // The backend expects { application, threshold }.
            const result = await postJson("/predict", {
                application,
                threshold: currentThreshold
            });

            renderDecision(result);

            try {
                const explanation = await postJson("/explain", {
                    application
                });

                renderExplanation(explanation);

            } catch (error) {
                console.error("Explanation error:", error);

                const container = $("#explanation");

                if (container) {
                    container.textContent =
                        `Explanation unavailable: ${error.message}`;
                }
            }

        } catch (error) {
            console.error("Prediction error:", error);
            alert(error.message);

        } finally {
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.textContent =
                    originalLabel || "Analyze Credit Risk";
            }
        }
    });
}


// ==========================================
// 12. THRESHOLD CONTROL
// ==========================================

const thresholdSlider = $("#thresholdSlider");

function applyThreshold() {
    if (!thresholdSlider) return;

    currentThreshold = Number(thresholdSlider.value) / 100;

    const valueElement = $("#thresholdValue");

    if (valueElement) {
        valueElement.textContent = `${thresholdSlider.value}%`;
    }

    const currentElement = $("#currentThreshold");

    if (currentElement) {
        currentElement.textContent = `${thresholdSlider.value}%`;
    }

    if (currentPrediction) {
        const decisionElement = $("#decision");

        if (decisionElement) {
            decisionElement.textContent = getDecision(
                Number(currentPrediction.default_probability),
                currentThreshold
            );
        }
    }
}

if (thresholdSlider) {
    // Sync state with whatever value the slider starts on.
    applyThreshold();
    thresholdSlider.addEventListener("input", applyThreshold);
}


// ==========================================
// 13. WHAT-IF ANALYSIS
// ==========================================

function renderWhatIf(result) {
    const container = $("#whatIfResult");

    if (!container) return;

    const original = result.original_prediction;
    const modified = result.what_if_prediction;

    const pct = (value) => `${(Number(value) * 100).toFixed(2)}%`;
    const diff = Number(result.probability_difference) * 100;
    const sign = diff > 0 ? "+" : "";

    container.textContent = [
        `Original default probability: ${pct(original.default_probability)} (${original.decision})`,
        `What-if default probability:  ${pct(modified.default_probability)} (${modified.decision})`,
        `Change: ${sign}${diff.toFixed(2)} percentage points — ${result.change}`
    ].join("\n");
}

const whatIfButton = $("#whatIfButton");

if (whatIfButton) {
    whatIfButton.addEventListener("click", async () => {
        try {
            whatIfButton.disabled = true;

            const application = readApplication();

            // Optional override inputs for the scenario.
            const amountRaw = $("#whatIfLoanAmnt")?.value?.trim() ?? "";
            const rateRaw = $("#whatIfLoanRate")?.value?.trim() ?? "";

            const payload = { application, threshold: currentThreshold };

            if (amountRaw !== "") {
                const amount = Number(amountRaw);

                if (!Number.isFinite(amount) || amount <= 0) {
                    throw new Error("What-if loan amount must be greater than 0.");
                }

                payload.loan_amnt = amount;
            }

            if (rateRaw !== "") {
                const rate = Number(rateRaw);

                if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
                    throw new Error("What-if interest rate must be between 0 and 100.");
                }

                payload.loan_int_rate = rate;
            }

            if (
                payload.loan_amnt === undefined &&
                payload.loan_int_rate === undefined
            ) {
                throw new Error(
                    "Enter a new loan amount and/or interest rate to compare."
                );
            }

            const result = await postJson("/what-if", payload);

            renderWhatIf(result);

        } catch (error) {
            console.error("What-if error:", error);
            alert(error.message);

        } finally {
            whatIfButton.disabled = false;
        }
    });
}


// ==========================================
// 14. BATCH PREDICTION
// ==========================================

const batchForm = $("#batchForm");

if (batchForm) {
    batchForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        const fileInput = $("#batchFile");

        if (!fileInput || !fileInput.files.length) {
            alert("Please select a CSV file.");
            return;
        }

        const formData = new FormData();
        formData.append("file", fileInput.files[0]);
        formData.append("threshold", String(currentThreshold));

        const button = batchForm.querySelector('button[type="submit"]');
        const originalLabel = button ? button.textContent : "";

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS * 2);

        try {
            if (button) {
                button.disabled = true;
                button.textContent = "Processing...";
            }

            const response = await fetch(`${API_BASE}/predict-batch`, {
                method: "POST",
                body: formData,
                signal: controller.signal
            });

            if (!response.ok) {
                const responseText = await response.text();

                let errorData;

                try {
                    errorData = JSON.parse(responseText);
                } catch {
                    errorData = responseText;
                }

                const detail =
                    errorData && typeof errorData === "object"
                        ? errorData.detail ?? errorData
                        : errorData;

                throw new Error(formatApiError(detail));
            }

            const blob = await response.blob();
            const downloadUrl = URL.createObjectURL(blob);

            const link = document.createElement("a");
            link.href = downloadUrl;
            link.download = "credence_predictions.csv";

            document.body.appendChild(link);
            link.click();
            link.remove();

            URL.revokeObjectURL(downloadUrl);

        } catch (error) {
            console.error("Batch error:", error);

            alert(
                error.name === "AbortError"
                    ? "The batch request timed out. Please try again."
                    : error.message
            );

        } finally {
            clearTimeout(timer);

            if (button) {
                button.disabled = false;
                button.textContent = originalLabel || "Run Batch Prediction";
            }
        }
    });
}


// ==========================================
// 15. CLEAR HISTORY
// ==========================================

const clearHistoryButton = $("#clearHistory");

if (clearHistoryButton) {
    clearHistoryButton.addEventListener("click", () => {
        try {
            localStorage.removeItem("credenceHistory");
        } catch (error) {
            console.warn("Could not clear history:", error);
        }

        renderHistory();
    });
}


// ==========================================
// 16. INPUT LISTENERS
// ==========================================

["#balance", "#limit"].forEach((selector) => {
    const element = $(selector);

    if (element) {
        element.addEventListener("input", updateRatio);
    }
});


// ==========================================
// 17. INITIALIZATION
// ==========================================

renderHistory();
updateRatio();
checkHealth();

setInterval(checkHealth, 30000);
