# Credence — Credit Risk Frontend

A responsive frontend built with vanilla HTML, CSS, and JavaScript for the Credit Risk FastAPI project.

## Project Structure

```text
frontend/
├── index.html
├── style.css
├── app.js
└── README.md
```

- `index.html` — Page structure and applicant input form.
- `style.css` — Responsive styling and visual design.
- `app.js` — API integration, form validation, threshold controls, what-if analysis, CSV upload, and browser history.

## Getting Started

### 1. Start the FastAPI Backend

Open a terminal in your `Credit Risk` backend project directory and activate your Python environment.

Start the backend:

```powershell
uvicorn main:app --reload
```

By default, the API will run at:

```text
http://127.0.0.1:8000
```

### 2. Run the Frontend

Keep all four frontend files in the same folder.

Open `index.html` directly in your browser, or use the **Live Server** extension in Visual Studio Code.

The frontend is configured to communicate with:

```javascript
const API_BASE = "http://127.0.0.1:8000";
```

If your backend runs at a different address or port, update `API_BASE` at the top of `app.js`.

## API Endpoints

The frontend uses the following FastAPI endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Check backend and model status |
| POST | `/predict` | Predict an applicant's default risk |
| POST | `/explain` | Generate SHAP-based feature explanations |
| POST | `/what-if` | Compare predictions after changing loan amount or interest rate |
| POST | `/predict-batch` | Upload a CSV file and download scored results |

## Input Features

The frontend sends the model input features expected by the FastAPI backend.

The `loan_percent_income` feature is calculated by the backend:

```python
loan_percent_income = loan_amnt / person_income
```

It is not an editable field in the frontend form.

### Dropdown Values

| Feature | Accepted Values |
|---|---|
| Home Ownership | `RENT`, `OWN`, `MORTGAGE`, `OTHER` |
| Loan Intent | `PERSONAL`, `EDUCATION`, `MEDICAL`, `VENTURE`, `HOMEIMPROVEMENT`, `DEBTCONSOLIDATION` |
| Loan Grade | `A`, `B`, `C`, `D`, `E`, `F`, `G` |
| Previous Default | `Y`, `N` |

## Dashboard Data

The dashboard calculates prediction totals, high-risk counts, approval rates, and prediction history using browser `localStorage`.

**Important:** This information is stored locally in the current browser. It is not synchronized across different browsers or devices.

The dashboard does not display dataset distributions or model evaluation metrics such as ROC-AUC, confusion matrix, precision, or recall because the current backend does not expose endpoints for these statistics.

No placeholder or invented values should be interpreted as actual model performance.

## Threshold Controls

- The threshold slider updates the displayed approval or rejection decision using the latest prediction probability.
- The selected threshold is also sent with new predictions.
- The frontend does not require the backend `/threshold` endpoint.

## Batch CSV Prediction

The batch prediction feature accepts a CSV file containing all required model input columns except:

- `loan_percent_income` — calculated by the backend.
- The target column — must not be included as an input feature.

Make sure the CSV column names and values match the backend's expected input schema.

## CORS Configuration

The FastAPI backend must allow browser requests from the frontend origin through Cross-Origin Resource Sharing (CORS).

If the frontend cannot communicate with the API, check the backend CORS configuration and browser console for errors.

## Important Disclaimer

Credence is a credit risk prediction and decision-support demonstration project. It is not an automated lending decision system.

Before using this system in a real lending environment, thoroughly validate:

- Model performance and reliability.
- Prediction calibration.
- Fairness and potential bias.
- Data privacy and security.
- Applicable financial regulations and legal requirements.

**Predictions should not be used as the sole basis for real-world lending decisions.**