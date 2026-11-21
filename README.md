# Credence — Credit Risk Prediction System

A full-stack credit risk prediction and decision-support application built with **Python, FastAPI, Scikit-learn, XGBoost, HTML, CSS, and JavaScript**.

Credence analyzes applicant and loan information to estimate the probability of loan default. It combines a machine learning backend with an interactive frontend dashboard for individual predictions, feature explanations, what-if analysis, and batch CSV scoring.

## Project Overview

Credence is designed to demonstrate how a machine learning model can be integrated into a practical full-stack application.

**Key capabilities:**
- Individual credit risk prediction
- Five-fold calibrated XGBoost ensemble
- SHAP-based feature explanations
- What-if analysis for loan amount and interest rate
- Batch predictions using CSV uploads
- Adjustable decision threshold
- Prediction history and dashboard statistics
- Responsive frontend interface

## Project Architecture

```text
credence-credit-risk/
│
├── backend/
│   ├── main.py
│   ├── requirements.txt
│   ├── Credit_Risk.ipynb
│   ├── check_components.py
│   ├── verify_prediction.py
│   │
│   └── credit_risk_export/
│       ├── calibration_params.pkl
│       ├── preprocessor_1.pkl
│       ├── preprocessor_2.pkl
│       ├── preprocessor_3.pkl
│       ├── preprocessor_4.pkl
│       ├── preprocessor_5.pkl
│       ├── xgboost_1.json
│       ├── xgboost_2.json
│       ├── xgboost_3.json
│       ├── xgboost_4.json
│       └── xgboost_5.json
│
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
│
├── .gitignore
└── README.md
```

## Machine Learning Architecture

Credence uses a **five-fold calibrated XGBoost ensemble**.

The exported model components include:
- Five preprocessing pipelines
- Five XGBoost models
- Calibration parameters

Each fold processes the applicant's input and produces a probability estimate. The calibrated probabilities are combined to generate the final default-risk probability.

This architecture allows the application to serve the reconstructed ensemble without depending on the original monolithic model file.

## Technology Stack

| Component | Technologies |
|---|---|
| Frontend | HTML5, CSS3, JavaScript |
| Backend | Python, FastAPI |
| Machine Learning | XGBoost, Scikit-learn |
| Model Processing | NumPy, SciPy |
| Model Explainability | SHAP |
| Model Serialization | Joblib |
| API Communication | REST API |
| Local Prediction History | Browser localStorage |

## Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/JonaeidBhuiyan/credence-credit-risk.git
cd credence-credit-risk
```

### 2. Create a Virtual Environment

```powershell
python -m venv .venv
```

Activate it on Windows:

```powershell
.\.venv\Scripts\Activate.ps1
```

### 3. Install Backend Dependencies

```powershell
cd backend
pip install -r requirements.txt
```

### 4. Start the FastAPI Backend

```powershell
uvicorn main:app --reload
```

The API will run at:

```text
http://127.0.0.1:8000
```

FastAPI interactive documentation:

```text
http://127.0.0.1:8000/docs
```

### 5. Run the Frontend

Open the `frontend` directory and launch `index.html` using the Visual Studio Code Live Server extension.

The frontend communicates with the local API through the `API_BASE` configuration in `app.js`.

```javascript
const API_BASE = "http://127.0.0.1:8000";
```

For a deployed application, configure this value to point to the deployed backend URL.

## API Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Check backend and model status |
| POST | `/predict` | Predict an applicant's default risk |
| POST | `/explain` | Generate SHAP-based feature explanations |
| POST | `/what-if` | Compare predictions after changing loan amount or interest rate |
| POST | `/predict-batch` | Upload a CSV file and download scored results |

## Input Features

The frontend collects applicant and loan information expected by the backend.

The `loan_percent_income` feature is calculated by the backend:

```python
loan_percent_income = loan_amnt / person_income
```

It is not an editable frontend field.

### Accepted Dropdown Values

| Feature | Accepted Values |
|---|---|
| Home Ownership | `RENT`, `OWN`, `MORTGAGE`, `OTHER` |
| Loan Intent | `PERSONAL`, `EDUCATION`, `MEDICAL`, `VENTURE`, `HOMEIMPROVEMENT`, `DEBTCONSOLIDATION` |
| Loan Grade | `A`, `B`, `C`, `D`, `E`, `F`, `G` |
| Previous Default | `Y`, `N` |

## Frontend Features

### Individual Prediction
Submit applicant information and receive a predicted default-risk probability.

### Risk Threshold Controls
Adjust the decision threshold to update the displayed approval or rejection classification.

### What-If Analysis
Compare predictions after changing loan amount or interest rate.

### Batch CSV Prediction
Upload a CSV containing the required input features and download scored results.

The CSV must not contain:
- `loan_percent_income` — calculated by the backend.
- The target column — not used as an input feature.

### Dashboard and Prediction History
The dashboard tracks prediction totals, high-risk counts, approval rates, and prediction history using browser `localStorage`.

This information is stored locally in the current browser and is not synchronized across devices.

## Important Notes

- The backend must be running before the frontend can communicate with it.
- Configure CORS correctly for the frontend origin.
- CSV column names and values must match the backend's expected input schema.
- Dashboard statistics represent locally recorded predictions, not model evaluation metrics.
- Model evaluation metrics such as ROC-AUC, precision, recall, and confusion matrix are not presented as live dashboard statistics.

## Disclaimer

Credence is an educational credit risk prediction and decision-support demonstration project.

It is not an automated lending decision system.

Before using this system in a real lending environment, thoroughly validate:

- Model performance and reliability
- Probability calibration
- Fairness and potential bias
- Data privacy and security
- Applicable financial regulations and legal requirements

**Predictions should not be used as the sole basis for real-world lending decisions.**

## Author

**Jonaeid Bhuiyan**

GitHub: [@JonaeidBhuiyan](https://github.com/JonaeidBhuiyan)

---

Built as a machine learning engineering project demonstrating model development, ensemble inference, API integration, and full-stack deployment.
