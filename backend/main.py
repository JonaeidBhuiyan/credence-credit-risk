
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

import joblib
import numpy as np
import pandas as pd

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    model_validator
)

from scipy.special import expit
from xgboost import XGBClassifier


# ==========================================
# 1. PROJECT PATH
# ==========================================

BASE_DIR = Path(__file__).resolve().parent

MODEL_DIR = BASE_DIR / "credit_risk_export"


# ==========================================
# 2. CREDIT APPLICATION VALIDATION
# ==========================================

class CreditRiskInput(BaseModel):

    model_config = ConfigDict(extra="forbid")

    person_age: int = Field(
        ge=18,
        le=100
    )

    person_income: float = Field(
        gt=0,
        allow_inf_nan=False
    )

    person_home_ownership: Literal[
        "RENT",
        "OWN",
        "MORTGAGE",
        "OTHER"
    ]

    person_emp_length: float = Field(
        ge=0,
        le=100,
        allow_inf_nan=False
    )

    loan_intent: Literal[
        "PERSONAL",
        "EDUCATION",
        "MEDICAL",
        "VENTURE",
        "HOMEIMPROVEMENT",
        "DEBTCONSOLIDATION"
    ]

    loan_grade: Literal[
        "A", "B", "C", "D", "E", "F", "G"
    ]

    loan_amnt: float = Field(
        gt=0,
        allow_inf_nan=False
    )

    loan_int_rate: float = Field(
        ge=0,
        le=100,
        allow_inf_nan=False
    )

    cb_person_default_on_file: Literal["Y", "N"]

    cb_person_cred_hist_length: float = Field(
        ge=0,
        le=100,
        allow_inf_nan=False
    )

    loan_percent_income: float | None = None

    @model_validator(mode="after")
    def calculate_loan_ratio(self):

        self.loan_percent_income = (
            self.loan_amnt / self.person_income
        )

        return self


# ==========================================
# 3. PREDICTION REQUEST
# ==========================================

class PredictionRequest(BaseModel):

    application: CreditRiskInput

    threshold: float = Field(
        default=0.5,
        ge=0.01,
        le=0.99,
        allow_inf_nan=False
    )


# ==========================================
# 4. MODEL VARIABLES
# ==========================================

preprocessors = []
xgb_models = []
calibration_params = []

model_loaded = False


# ==========================================
# 5. LOAD MODEL ARTIFACTS
# ==========================================

def load_models():

    global preprocessors
    global xgb_models
    global calibration_params
    global model_loaded

    loaded_preprocessors = []
    loaded_models = []

    # Load five preprocessing pipelines
    for i in range(1, 6):

        path = MODEL_DIR / f"preprocessor_{i}.pkl"

        preprocessor = joblib.load(path)

        loaded_preprocessors.append(preprocessor)

    # Load five XGBoost models
    for i in range(1, 6):

        path = MODEL_DIR / f"xgboost_{i}.json"

        model = XGBClassifier()

        model.load_model(str(path))

        loaded_models.append(model)

    # Load calibration parameters
    calibration_path = (
        MODEL_DIR / "calibration_params.pkl"
    )

    loaded_calibration = joblib.load(
        calibration_path
    )

    # Validate artifacts
    if len(loaded_preprocessors) != 5:
        raise RuntimeError(
            "Expected five preprocessors."
        )

    if len(loaded_models) != 5:
        raise RuntimeError(
            "Expected five XGBoost models."
        )

    if len(loaded_calibration) != 5:
        raise RuntimeError(
            "Expected five calibration entries."
        )

    for i, params in enumerate(
        loaded_calibration,
        start=1
    ):

        if not isinstance(params, dict):
            raise RuntimeError(
                f"Invalid calibration parameters in fold {i}."
            )

        if "a" not in params or "b" not in params:
            raise RuntimeError(
                f"Missing calibration values in fold {i}."
            )

        if not np.isfinite(params["a"]) or not np.isfinite(params["b"]):
            raise RuntimeError(
                f"Non-finite calibration values in fold {i}."
            )

    # Assign only after all artifacts load successfully
    preprocessors = loaded_preprocessors
    xgb_models = loaded_models
    calibration_params = loaded_calibration

    model_loaded = True

    print(
        "All model artifacts loaded successfully."
    )


# ==========================================
# 6. FASTAPI LIFESPAN
# ==========================================

@asynccontextmanager
async def lifespan(app: FastAPI):

    print(
        "Loading Credence Credit Risk model..."
    )

    load_models()

    yield

    print(
        "Credence API shutting down."
    )


# ==========================================
# 7. CREATE FASTAPI APP
# ==========================================

app = FastAPI(
    title="Credence Credit Risk API",
    description="Credit default risk prediction API",
    version="2.0.0",
    lifespan=lifespan
)


# ==========================================
# 8. CORS
# ==========================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"]
)


# ==========================================
# 9. PREDICTION ENGINE
# ==========================================

FEATURE_COLUMNS = [
    "person_age",
    "person_income",
    "person_home_ownership",
    "person_emp_length",
    "loan_intent",
    "loan_grade",
    "loan_amnt",
    "loan_int_rate",
    "loan_percent_income",
    "cb_person_default_on_file",
    "cb_person_cred_hist_length"
]


def check_model():

    if not model_loaded:
        raise RuntimeError(
            "Credit risk model is not loaded."
        )

    if not (
        len(preprocessors) == 5
        and len(xgb_models) == 5
        and len(calibration_params) == 5
    ):
        raise RuntimeError(
            "Model artifacts are incomplete."
        )


def prepare_input(input_data: dict):

    input_df = pd.DataFrame(
        [input_data],
        columns=FEATURE_COLUMNS
    )

    return input_df


def predict_default_probabilities(input_data: dict):

    check_model()

    input_df = prepare_input(input_data)

    calibrated_probabilities = []

    for preprocessor, classifier, params in zip(
        preprocessors,
        xgb_models,
        calibration_params
    ):

        transformed_data = preprocessor.transform(
            input_df
        )

        raw_default_probability = classifier.predict_proba(
            transformed_data
        )[:, 1]

        calibrated_probability = expit(
            -(
                params["a"] * raw_default_probability
                + params["b"]
            )
        )

        calibrated_probabilities.append(
            calibrated_probability
        )

    final_probability = np.clip(
        np.mean(
            calibrated_probabilities,
            axis=0
        ),
        0.0,
        1.0
    )

    return final_probability


# ==========================================
# 10. HOME ENDPOINT
# ==========================================

@app.get("/")
def home():

    return {
        "message": "Welcome to Credence Credit Risk API",
        "status": "running"
    }


# ==========================================
# 11. HEALTH ENDPOINT
# ==========================================

@app.get("/health")
def health():

    return {
        "status": (
            "healthy" if model_loaded else "unhealthy"
        ),
        "model_loaded": model_loaded,
        "model_name": "5-Fold Calibrated XGBoost Ensemble",
        "folds_loaded": len(xgb_models),
        "preprocessors_loaded": len(preprocessors),
        "calibration_entries_loaded": len(calibration_params)
    }


# ==========================================
# 12. PREDICTION ENDPOINT
# ==========================================

@app.post("/predict")
def predict(request: PredictionRequest):

    try:

        application = request.application.model_dump()

        threshold = request.threshold

        probabilities = predict_default_probabilities(
            application
        )

        default_probability = float(
            probabilities[0]
        )

        non_default_probability = (
            1.0 - default_probability
        )

        # Risk classification
        if default_probability < 0.20:

            risk_band = "Low"

        elif default_probability < 0.50:

            risk_band = "Medium"

        else:

            risk_band = "High"

        # Decision classification
        decision = (
            "Reject"
            if default_probability >= threshold
            else "Approve"
        )

        return {
            "default_probability": default_probability,
            "non_default_probability": non_default_probability,
            "risk_band": risk_band,
            "decision": decision,
            "threshold": threshold
        }

    except Exception as error:

        raise HTTPException(
            status_code=500,
            detail=str(error)
        )
