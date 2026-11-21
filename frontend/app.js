
const API_BASE = "https://credence-credit-risk-2.onrender.com";

// ==========================================
// 1. DOM HELPERS
// ==========================================

const $ = (selector) => document.querySelector(selector);

let currentPrediction = null;
let currentExplanation = null;
let currentThreshold = 0.5;


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
        modelStatus.textContent = isOnline
            ? "Online"
            : "Offline";
    }
}


async function checkHealth() {
    try {
        const response = await fetch(`${API_BASE}/health`);

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

        setApiStatus(
            false,
            `Connection failed: ${error.message}`
        );
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

    for (const [key, value] of formData.entries()) {
        if (typeof value === "string" && value.trim() === "") {
            throw new Error(`Please complete the ${key} field.`);
        }

        const trimmedValue =
            typeof value === "string" ? value.trim() : value;

        const numericValue = Number(trimmedValue);

        data[key] =
            trimmedValue !== "" && !Number.isNaN(numericValue)
                ? numericValue
                : trimmedValue;
    }

    return data;
}


// ==========================================
// 5. CREDIT UTILIZATION RATIO
// ==========================================

function updateRatio() {
    const balance = Number($("#balance")?.value || 0);
    const limit = Number($("#limit")?.value || 0);

    const ratio = limit > 0
        ? (balance / limit) * 100
        : 0;

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

function getRisk(probability) {
    if (probability < 0.20) return "Low Risk";
    if (probability < 0.50) return "Moderate Risk";
    if (probability < 0.75) return "High Risk";

    return "Very High Risk";
}


function getDecision(probability, threshold = currentThreshold) {
    return probability >= threshold
        ? "Default Risk"
        : "Low Default Risk";
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

    const risk = getRisk(probability);
    const decision = getDecision(probability);

    const resultPanel = $("#resultPanel");

    if (resultPanel) {
        resultPanel.hidden = false;
        resultPanel.classList.add("visible");
    }

    const defaultElement = $("#defaultProbability");
    if (defaultElement) {
        defaultElement.textContent = `${defaultPercent.toFixed(2)}%`;
    }

    const nonDefaultElement = $("#nonDefaultProbability");
    if (nonDefaultElement) {
        nonDefaultElement.textContent = `${nonDefaultPercent.toFixed(2)}%`;
    }

    const riskElement = $("#riskLevel");
    if (riskElement) {
        riskElement.textContent = risk;
    }

    const decisionElement = $("#decision");
    if (decisionElement) {
        decisionElement.textContent = decision;
    }

    const gauge = $("#riskGauge");
    if (gauge) {
        gauge.style.setProperty("--risk", `${defaultPercent}%`);
    }

    const probabilityBar = $("#defaultBar");
    if (probabilityBar) {
        probabilityBar.style.width = `${defaultPercent}%`;
    }

    const nonDefaultBar = $("#nonDefaultBar");
    if (nonDefaultBar) {
        nonDefaultBar.style.width = `${nonDefaultPercent}%`;
    }

    const thresholdElement = $("#currentThreshold");
    if (thresholdElement) {
        thresholdElement.textContent =
            `${(currentThreshold * 100).toFixed(0)}%`;
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

    const factors =
        data.feature_importance ||
        data.top_features ||
        data.explanations ||
        [];

    if (!Array.isArray(factors) || factors.length === 0) {
        container.textContent = "No explanation available.";
        return;
    }

    factors.forEach((item) => {
        const name =
            item.feature ||
            item.name ||
            item.feature_name ||
            "Feature";

        const value =
            item.importance ??
            item.contribution ??
            item.value ??
            0;

        const row = document.createElement("div");
        row.className = "explanation-item";

        const nameElement = document.createElement("span");
        nameElement.textContent = String(name);

        const valueElement = document.createElement("span");
        valueElement.textContent =
            typeof value === "number"
                ? value.toFixed(4)
                : String(value);

        row.append(nameElement, valueElement);
        container.appendChild(row);
    });
}


// ==========================================
// 9. LOCAL STORAGE HISTORY
// ==========================================

function getHistory() {
    try {
        return JSON.parse(
            localStorage.getItem("credenceHistory") || "[]"
        );
    } catch {
        return [];
    }
}


function saveHistory(result) {
    const history = getHistory();

    history.unshift({
        probability: Number(result.default_probability),
        risk: getRisk(Number(result.default_probability)),
        date: new Date().toLocaleString()
    });

    localStorage.setItem(
        "credenceHistory",
        JSON.stringify(history.slice(0, 10))
    );

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
            `${(item.probability * 100).toFixed(2)}%`;

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
    let response;

    try {
        response = await fetch(`${API_BASE}${path}`, {
            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify(payload)
        });

    } catch (error) {
        throw new Error(
            `Could not connect to the backend: ${error.message}`
        );
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

        try {
            if (submitButton) {
                submitButton.disabled = true;
                submitButton.textContent = "Analyzing...";
            }

            const application = readApplication();

            console.log("Submitted application:", application);

            const result = await postJson(
                "/predict",
                application
            );

            console.log("Prediction response:", result);

            renderDecision(result);

            try {
                const explanation = await postJson(
                    "/explain",
                    application
                );

                console.log("Explanation response:", explanation);

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
                submitButton.textContent = "Analyze Credit Risk";
            }
        }
    });
}


// ==========================================
// 12. THRESHOLD CONTROL
// ==========================================

const thresholdSlider = $("#thresholdSlider");

if (thresholdSlider) {
    thresholdSlider.addEventListener("input", () => {
        currentThreshold =
            Number(thresholdSlider.value) / 100;

        const valueElement = $("#thresholdValue");

        if (valueElement) {
            valueElement.textContent =
                `${thresholdSlider.value}%`;
        }

        if (currentPrediction) {
            const decision = getDecision(
                Number(currentPrediction.default_probability),
                currentThreshold
            );

            const decisionElement = $("#decision");

            if (decisionElement) {
                decisionElement.textContent = decision;
            }
        }
    });
}


// ==========================================
// 13. WHAT-IF ANALYSIS
// ==========================================

const whatIfButton = $("#whatIfButton");

if (whatIfButton) {
    whatIfButton.addEventListener("click", async () => {
        try {
            whatIfButton.disabled = true;

            const application = readApplication();

            const result = await postJson(
                "/what-if",
                application
            );

            const container = $("#whatIfResult");

            if (container) {
                container.textContent =
                    JSON.stringify(result, null, 2);
            }

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

        const button = batchForm.querySelector(
            'button[type="submit"]'
        );

        try {
            if (button) {
                button.disabled = true;
                button.textContent = "Processing...";
            }

            const response = await fetch(
                `${API_BASE}/predict-batch`,
                {
                    method: "POST",
                    body: formData
                }
            );

            if (!response.ok) {
                const responseText = await response.text();

                let errorData;

                try {
                    errorData = JSON.parse(responseText);
                } catch {
                    errorData = responseText;
                }

                const detail =
                    typeof errorData === "object"
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
            alert(error.message);

        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = "Run Batch Prediction";
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
        localStorage.removeItem("credenceHistory");
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
