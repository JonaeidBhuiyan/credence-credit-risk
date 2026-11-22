
/* ==================================================
   CREDENCE CREDIT RISK
   FRONTEND APPLICATION — REVISED VERSION
================================================== */


/* ==================================================
   1. API CONFIGURATION
================================================== */

const API_BASE = "https://credence-credit-risk-2.onrender.com"
    .replace(/\/+$/, "");


/* ==================================================
   2. HTML ELEMENT REFERENCES
================================================== */

// API status
const apiDot = document.getElementById("apiDot");
const apiStatus = document.getElementById("apiStatus");
const apiMessage = document.getElementById("apiMessage");
const modelStatus = document.getElementById("modelStatus");

// Form
const creditForm = document.getElementById("creditForm");
const predictBtn = document.getElementById("predictBtn");
const formError = document.getElementById("formError");

// Loan ratio
const loanAmountInput = document.getElementById("loanAmount");
const incomeInput = document.querySelector(
    'input[name="person_income"]'
);
const ratioValue = document.getElementById("ratioValue");

// Threshold
const globalThreshold = document.getElementById("globalThreshold");
const resultThreshold = document.getElementById("resultThreshold");
const thresholdValue = document.getElementById("thresholdValue");

// History
const historyBody = document.getElementById("historyBody");
const clearHistoryBtn = document.getElementById("clearHistory");

// Dashboard metrics
const totalAssessments = document.getElementById("totalAssessments");
const highRiskCount = document.getElementById("highRiskCount");
const approvalRate = document.getElementById("approvalRate");

// What-if
const whatIfAmount = document.getElementById("whatIfAmount");
const whatIfRate = document.getElementById("whatIfRate");
const whatIfBtn = document.getElementById("whatIfBtn");
const whatIfResult = document.getElementById("whatIfResult");

// Result panel
const emptyState = document.getElementById("emptyState");
const resultContent = document.getElementById("resultContent");
const probabilityValue = document.getElementById("probabilityValue");
const probabilityBar = document.getElementById("probabilityBar");
const riskBadge = document.getElementById("riskBadge");

// Prediction state
let latestPrediction = null;
let latestApplication = null;


/* ==================================================
   3. API HEALTH CHECK
================================================== */

async function checkApiHealth() {

    try {

        apiStatus.textContent = "Connecting";
        apiMessage.textContent = "Checking prediction service";

        const response = await fetch(`${API_BASE}/health`);

        if (!response.ok) {
            throw new Error(`HTTP Error: ${response.status}`);
        }

        const data = await response.json();

        if (
            data.status !== "healthy" ||
            data.model_loaded !== true ||
            data.folds_loaded !== 5
        ) {
            throw new Error("Model health check failed.");
        }

        apiDot.className = "status-dot online";
        apiStatus.textContent = "API Connected";
        apiMessage.textContent = "5-Fold model loaded successfully";
        modelStatus.textContent = "Online";

        console.log("Credence API health:", data);

    } catch (error) {

        apiDot.className = "status-dot offline";
        apiStatus.textContent = "API Offline";
        apiMessage.textContent = "Unable to connect to prediction service";
        modelStatus.textContent = "Offline";

        console.error("API connection error:", error);

    }

}


/* ==================================================
   4. LOAN-TO-INCOME RATIO
================================================== */

function calculateLoanRatio() {

    if (!loanAmountInput || !incomeInput || !ratioValue) {
        return;
    }

    const loanAmount = Number(loanAmountInput.value);
    const annualIncome = Number(incomeInput.value);

    if (
        loanAmountInput.value.trim() === "" ||
        incomeInput.value.trim() === "" ||
        !Number.isFinite(loanAmount) ||
        !Number.isFinite(annualIncome) ||
        loanAmount <= 0 ||
        annualIncome <= 0
    ) {

        ratioValue.textContent = "—";
        return;

    }

    const ratio = loanAmount / annualIncome;

    ratioValue.textContent =
        `${(ratio * 100).toFixed(2)}%`;

}


loanAmountInput?.addEventListener(
    "input",
    calculateLoanRatio
);

incomeInput?.addEventListener(
    "input",
    calculateLoanRatio
);


/* ==================================================
   5. READ AND VALIDATE CREDIT APPLICATION
================================================== */

function readApplication() {

    const formData = new FormData(creditForm);

    const application = {};

    // Read form values
    for (const [key, value] of formData.entries()) {

        application[key] = String(value).trim();

    }

    // Numeric fields
    const numericFields = [
        "person_age",
        "person_income",
        "person_emp_length",
        "loan_amnt",
        "loan_int_rate",
        "cb_person_cred_hist_length"
    ];

    // Check required fields
    for (const field of numericFields) {

        if (
            application[field] === undefined ||
            application[field] === ""
        ) {
            throw new Error(`Please enter ${field.replaceAll("_", " ")}.`);
        }

        application[field] = Number(application[field]);

        if (!Number.isFinite(application[field])) {
            throw new Error(`Invalid value for ${field.replaceAll("_", " ")}.`);
        }

    }

    // Positive income is required for the ratio
    if (application.person_income <= 0) {
        throw new Error("Annual income must be greater than zero.");
    }

    if (application.loan_amnt <= 0) {
        throw new Error("Loan amount must be greater than zero.");
    }

    // Required categorical fields
    const categoricalFields = [
        "person_home_ownership",
        "loan_intent",
        "loan_grade",
        "cb_person_default_on_file"
    ];

    for (const field of categoricalFields) {

        if (
            !application[field] ||
            application[field].trim() === ""
        ) {
            throw new Error(`Please select ${field.replaceAll("_", " ")}.`);
        }

    }

    // Calculate loan-to-income ratio
    application.loan_percent_income =
        application.loan_amnt / application.person_income;

    return application;

}


/* ==================================================
   6. SEND PREDICTION REQUEST
================================================== */

async function requestPrediction(
    application,
    threshold = Number(globalThreshold.value) / 100
) {

    if (
        !Number.isFinite(threshold) ||
        threshold < 0 ||
        threshold > 1
    ) {
        throw new Error("Invalid decision threshold.");
    }

    const response = await fetch(`${API_BASE}/predict`, {

        method: "POST",

        headers: {
            "Content-Type": "application/json"
        },

        body: JSON.stringify({

            application: application,

            threshold: threshold

        })

    });


    // Read backend response
    let data;

    try {

        data = await response.json();

    } catch {

        throw new Error(
            "Backend returned an invalid response."
        );

    }


    // Handle HTTP errors
    if (!response.ok) {

        let errorMessage = "Prediction request failed.";

        if (typeof data.detail === "string") {

            errorMessage = data.detail;

        } else if (data.detail) {

            errorMessage = JSON.stringify(data.detail);

        }

        throw new Error(errorMessage);

    }


    // Validate probability
    const probability = Number(data.default_probability);

    if (
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1
    ) {
        throw new Error("Backend returned an invalid probability.");
    }


    // Validate threshold
    const responseThreshold = Number(data.threshold);

    if (
        !Number.isFinite(responseThreshold) ||
        responseThreshold < 0 ||
        responseThreshold > 1
    ) {
        throw new Error("Backend returned an invalid threshold.");
    }

    return data;

}


/* ==================================================
   7. HANDLE FORM SUBMISSION
================================================== */

creditForm?.addEventListener("submit", async function(event) {

    event.preventDefault();

    formError.textContent = "";

    predictBtn.disabled = true;
    predictBtn.textContent = "Analyzing...";

    try {

        // Read and validate application
        const application = readApplication();

        // Request prediction
        const result = await requestPrediction(application);

        // Save successful original application
        latestApplication = { ...application };

        // Display prediction
        renderPredictionResult(result);

        console.log("Prediction result:", result);

        // Save history separately.
        // History failure must not invalidate a successful prediction.
        try {

            addPredictionToHistory(application, result);

        } catch (historyError) {

            console.error("History error:", historyError);

            formError.textContent =
                "Prediction successful, but browser history could not be saved.";

        }

    } catch (error) {

        console.error("Prediction error:", error);

        formError.textContent = error.message;

    } finally {

        predictBtn.disabled = false;

        predictBtn.innerHTML =
            'Run risk assessment <span>→</span>';

    }

});


/* ==================================================
   8. DISPLAY PREDICTION RESULT
================================================== */

function renderPredictionResult(result) {

    const probability = Number(result.default_probability);
    const threshold = Number(result.threshold);

    if (
        !Number.isFinite(probability) ||
        probability < 0 ||
        probability > 1
    ) {
        throw new Error("Invalid prediction probability received.");
    }

    if (
        !Number.isFinite(threshold) ||
        threshold < 0 ||
        threshold > 1
    ) {
        throw new Error("Invalid threshold received.");
    }

    // Save latest prediction
    latestPrediction = result;

    const probabilityPercent = probability * 100;

    // Show result panel
    emptyState?.classList.add("hidden");
    resultContent?.classList.remove("hidden");

    // Default probability
    probabilityValue.textContent =
        probabilityPercent.toFixed(2);

    // Probability bar
    probabilityBar.style.width =
        `${probabilityPercent}%`;

    // Risk badge
    const risk = String(result.risk_band || "Unknown").toLowerCase();

    riskBadge.textContent = result.risk_band || "Unknown";
    riskBadge.className = "risk-badge";

    if (["low", "medium", "high"].includes(risk)) {
        riskBadge.classList.add(risk);
    }

    // Synchronize threshold sliders
    const thresholdPercent = Math.round(threshold * 100);

    globalThreshold.value = thresholdPercent;
    resultThreshold.value = thresholdPercent;
    thresholdValue.textContent = thresholdPercent;

    // Update decision
    updateDecision(probability, threshold);

    console.log(
        "Non-default probability:",
        result.non_default_probability
    );

    // Scroll to result
    document.getElementById("results")?.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });

}


/* ==================================================
   9. UPDATE APPROVE / REJECT DECISION
================================================== */

function updateDecision(probability, threshold) {

    const decisionValue =
        document.getElementById("decisionValue");

    const decisionMark =
        document.getElementById("decisionMark");

    const thresholdLabel =
        document.getElementById("resultThresholdValue");

    const isRejected = probability >= threshold;

    // Decision text
    decisionValue.textContent = isRejected
        ? "Reject"
        : "Approve";

    // Decision icon
    decisionMark.textContent = isRejected
        ? "×"
        : "✓";

    // Decision styling
    decisionMark.className = isRejected
        ? "decision-mark reject"
        : "decision-mark";

    // Threshold label
    thresholdLabel.textContent =
        `${(threshold * 100).toFixed(0)}%`;

    // Synchronize sliders
    resultThreshold.value = Math.round(threshold * 100);
    globalThreshold.value = Math.round(threshold * 100);
    thresholdValue.textContent = Math.round(threshold * 100);

}


/* ==================================================
   10. THRESHOLD SLIDER SYNCHRONIZATION
================================================== */

function handleThresholdChange(value) {

    const thresholdPercent = Number(value);
    const threshold = thresholdPercent / 100;

    // Synchronize both sliders
    globalThreshold.value = thresholdPercent;
    resultThreshold.value = thresholdPercent;

    // Update label
    thresholdValue.textContent = thresholdPercent;

    // Recalculate decision using existing probability
    if (latestPrediction) {

        updateDecision(
            Number(latestPrediction.default_probability),
            threshold
        );

    }

}


globalThreshold?.addEventListener("input", function() {

    handleThresholdChange(this.value);

});


resultThreshold?.addEventListener("input", function() {

    handleThresholdChange(this.value);

});


/* ==================================================
   11. PREDICTION HISTORY
================================================== */

const HISTORY_KEY = "credence_prediction_history";


// Load history
function getPredictionHistory() {

    try {

        const storedHistory = localStorage.getItem(HISTORY_KEY);

        if (!storedHistory) {
            return [];
        }

        const history = JSON.parse(storedHistory);

        return Array.isArray(history) ? history : [];

    } catch (error) {

        console.error("History loading error:", error);

        return [];

    }

}


// Save history
function savePredictionHistory(history) {

    try {

        localStorage.setItem(
            HISTORY_KEY,
            JSON.stringify(history)
        );

    } catch (error) {

        console.error("History saving error:", error);

        throw new Error(
            "Unable to save prediction history in this browser."
        );

    }

}


// Add prediction to history
function addPredictionToHistory(application, result) {

    const history = getPredictionHistory();

    const record = {

        id: Date.now(),

        date: new Date().toLocaleString(),

        applicantAge: application.person_age,

        income: application.person_income,

        loanAmount: application.loan_amnt,

        probability: result.default_probability,

        riskBand: result.risk_band,

        decision: result.decision

    };

    // Newest record first
    history.unshift(record);

    // Keep latest 50 records
    const limitedHistory = history.slice(0, 50);

    savePredictionHistory(limitedHistory);

    renderPredictionHistory();

}


// Render history table
function renderPredictionHistory() {

    if (!historyBody) {
        console.error("History table element not found.");
        return;
    }

    const history = getPredictionHistory();

    historyBody.innerHTML = "";

    // Empty state
    if (history.length === 0) {

        const row = document.createElement("tr");
        const cell = document.createElement("td");

        cell.colSpan = 6;
        cell.className = "table-empty";

        cell.textContent =
            "No predictions yet. Your completed assessments will appear here.";

        row.appendChild(cell);
        historyBody.appendChild(row);

        updateDashboardMetrics(history);

        return;

    }


    // Render records
    history.forEach(record => {

        const row = document.createElement("tr");

        const values = [
            record.date,
            record.applicantAge,
            `$${Number(record.loanAmount).toLocaleString()}`,
            `${(Number(record.probability) * 100).toFixed(2)}%`,
            record.riskBand,
            record.decision
        ];

        values.forEach((value, index) => {

            const cell = document.createElement("td");

            // Risk cell
            if (index === 4) {

                const risk = String(value).toLowerCase();

                const riskElement = document.createElement("span");

                riskElement.className = `table-risk ${risk}`;

                riskElement.textContent = String(value);

                // Ensure only one risk label is inserted
                cell.replaceChildren(riskElement);

            }

            // Decision cell
            else if (index === 5) {

                cell.className =
                    String(value).toLowerCase() === "approve"
                        ? "decision-approved"
                        : "decision-rejected";

                cell.textContent = String(value);

            }

            // Normal cells
            else {

                cell.textContent = String(value);

            }

            row.appendChild(cell);

        });

        historyBody.appendChild(row);

    });

    updateDashboardMetrics(history);

}


/* ==================================================
   12. DASHBOARD METRICS
================================================== */

function updateDashboardMetrics(history) {

    if (totalAssessments) {

        totalAssessments.textContent = history.length;

    }

    if (highRiskCount) {

        const highCount = history.filter(record =>

            String(record.riskBand).toLowerCase() === "high"

        ).length;

        highRiskCount.textContent = highCount;

    }

    if (approvalRate) {

        if (history.length === 0) {

            approvalRate.textContent = "—";

        } else {

            const approvedCount = history.filter(record =>

                String(record.decision).toLowerCase() === "approve"

            ).length;

            const rate = (approvedCount / history.length) * 100;

            approvalRate.textContent = `${rate.toFixed(1)}%`;

        }

    }

}


/* ==================================================
   13. CLEAR HISTORY
================================================== */

clearHistoryBtn?.addEventListener("click", function() {

    try {

        localStorage.removeItem(HISTORY_KEY);

        renderPredictionHistory();

        console.log("Prediction history cleared.");

    } catch (error) {

        console.error("History clearing error:", error);

    }

});


/* ==================================================
   14. WHAT-IF ANALYSIS
================================================== */

async function runWhatIfAnalysis() {

    if (!latestPrediction || !latestApplication) {

        showWhatIfMessage(
            "Please run an original assessment first."
        );

        return;

    }

    const newAmount = whatIfAmount.value.trim();
    const newRate = whatIfRate.value.trim();

    // Require at least one change
    if (!newAmount && !newRate) {

        showWhatIfMessage(
            "Enter a new loan amount or interest rate."
        );

        return;

    }

    // Copy original application
    const scenarioApplication = {
        ...latestApplication
    };


    // Update loan amount
    if (newAmount !== "") {

        const amount = Number(newAmount);

        if (!Number.isFinite(amount) || amount <= 0) {

            showWhatIfMessage(
                "Enter a valid loan amount greater than zero."
            );

            return;

        }

        scenarioApplication.loan_amnt = amount;

    }


    // Update interest rate
    if (newRate !== "") {

        const rate = Number(newRate);

        if (
            !Number.isFinite(rate) ||
            rate < 0 ||
            rate > 100
        ) {

            showWhatIfMessage(
                "Interest rate must be between 0 and 100."
            );

            return;

        }

        scenarioApplication.loan_int_rate = rate;

    }


    // Recalculate loan-to-income ratio
    scenarioApplication.loan_percent_income =
        scenarioApplication.loan_amnt /
        scenarioApplication.person_income;


    // Use the current decision threshold
    const currentThreshold =
        Number(globalThreshold.value) / 100;


    // Loading state
    whatIfBtn.disabled = true;
    whatIfBtn.textContent = "Analyzing scenario...";

    whatIfResult.classList.remove("hidden");

    whatIfResult.textContent =
        "Running scenario through the credit risk model...";


    try {

        // Request scenario prediction
        const scenarioResult = await requestPrediction(
            scenarioApplication,
            currentThreshold
        );

        const originalProbability =
            Number(latestPrediction.default_probability);

        const newProbability =
            Number(scenarioResult.default_probability);

        if (
            !Number.isFinite(originalProbability) ||
            !Number.isFinite(newProbability)
        ) {

            throw new Error(
                "Backend returned an invalid probability."
            );

        }


        // Calculate difference in percentage points
        const difference =
            (newProbability - originalProbability) * 100;

        let comparison;

        if (difference > 0) {

            comparison =
                `Default probability increased by ${difference.toFixed(2)} percentage points.`;

        } else if (difference < 0) {

            comparison =
                `Default probability decreased by ${Math.abs(difference).toFixed(2)} percentage points.`;

        } else {

            comparison =
                "Default probability remained unchanged.";

        }


        // Calculate scenario decision
        const decision =
            newProbability >= currentThreshold
                ? "Reject"
                : "Approve";


        // Safely render scenario result
        whatIfResult.replaceChildren();

        const heading = document.createElement("strong");
        heading.textContent = "Scenario comparison";

        const original = document.createElement("p");
        original.textContent =
            `Original default probability: ${(originalProbability * 100).toFixed(2)}%`;

        const updated = document.createElement("p");
        updated.textContent =
            `New default probability: ${(newProbability * 100).toFixed(2)}%`;

        const change = document.createElement("p");
        change.textContent = comparison;

        const decisionText = document.createElement("p");
        decisionText.textContent =
            `New decision: ${decision}`;

        whatIfResult.append(
            heading,
            original,
            updated,
            change,
            decisionText
        );

        console.log("What-if scenario result:", scenarioResult);

    } catch (error) {

        console.error("What-if analysis error:", error);

        showWhatIfMessage(error.message);

    } finally {

        whatIfBtn.disabled = false;

        whatIfBtn.textContent = "Compare scenario →";

    }

}


// Display What-if messages
function showWhatIfMessage(message) {

    whatIfResult.classList.remove("hidden");

    whatIfResult.textContent = message;

}


// Connect What-if button
whatIfBtn?.addEventListener(
    "click",
    runWhatIfAnalysis
);


/* ==================================================
   15. INITIALIZE APPLICATION
================================================== */

checkApiHealth();

renderPredictionHistory();

calculateLoanRatio();

console.log(
    "Credence Credit Risk frontend initialized successfully."
);
