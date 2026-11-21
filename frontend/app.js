
const API_BASE = "https://credence-credit-risk-2.onrender.com";

// ==========================================
// 1. DOM HELPERS
// ==========================================

const $ = (selector) => document.querySelector(selector);

let currentPrediction = null;
let currentExplanation = null;
let currentThreshold = 0.5;


// ==========================================
// 2. API STATUS / HEALTH CHECK
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
// 3. APPLICATION INPUTS
// ==========================================

function readApplication() {
    const form = $("#creditForm");

    if (!form) {
        throw new Error("Credit form not found.");
    }

    const formData = new FormData(form);
    const data = {};

    for (const [key, value] of formData.entries()) {
        if (value.trim() === "") {
            throw new Error(`Please complete the ${key} field.`);
        }

        const numericValue = Number(value);

        data[key] = Number.isNaN(numericValue)
            ? value
            : numericValue;
    }

    return data;
}


// ==========================================
// 4. CREDIT UTILIZATION RATIO
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
// 5. RISK CLASSIFICATION
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
// 6. PREDICTION RESULT
// ==========================================

function renderDecision(result) {
    currentPrediction = result;

    const probability = Number(result.default_probability);
    const nonDefaultProbability = Number(result.non_default_probability);

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
// 7. EXPLANATION
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
        nameElement.textContent = name;

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
// 8. HTML ESCAPING
// ==========================================

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => {
        const entities = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#039;"
        };

        return entities[char];
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
    const response = await fetch(`${API_BASE}${path}`, {
        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
        throw new Error(
            data.detail || `Request failed: ${response.status}`
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

            const result = await postJson(
                "/predict",
                application
            );

            renderDecision(result);

            try {
                const explanation = await postJson(
                    "/explain",
                    application
                );

                renderExplanation(explanation);

            } catch (error) {
                console.error("Explanation error:", error);
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
                const errorData = await response.json();

                throw new Error(
                    errorData.detail || "Batch prediction failed."
                );
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

document.addEventListener("DOMContentLoaded", () => {
    renderHistory();
    updateRatio();
    checkHealth();

    setInterval(checkHealth, 30000);
});
