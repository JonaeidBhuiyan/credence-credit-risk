import os
import secrets
from contextlib import asynccontextmanager
from io import StringIO
from pathlib import Path
from typing import Literal

import joblib
import numpy as np
import pandas as pd
import shap
from fastapi import (
    FastAPI,
    File,
    Form,
    Header,
    HTTPException,
    Query,
    UploadFile,
)
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationError,
    field_validator,
    model_validator,
)
from scipy.special import expit
from xgboost import XGBClassifier


# ============================================================
# 1. PATHS AND CONFIGURATION
# ============================================================

BASE_DIR = Path(__file__).resolve().parent
EXPORT_DIR = BASE_DIR / "credit_risk_export"

CALIBRATION_PATH = EXPORT_DIR / "calibration_params.pkl"
PREPROCESSOR_PATHS = [EXPORT_DIR / f"preprocessor_{i}.pkl" for i in range(1, 6)]
XGBOOST_PATHS = [EXPORT_DIR / f"xgboost_{i}.json" for i in range(1, 6)]

N_FOLDS = 5
MAX_CSV_SIZE = 10 * 1024 * 1024
MAX_BATCH_ROWS = 10000
DEFAULT_THRESHOLD = 0.50

# Comma-separated list of allowed origins, e.g.
# ALLOWED_ORIGINS="https://my-site.netlify.app,http://localhost:5500"
ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")
    if o.strip()
]

# PUT /threshold changes global state, so it requires this token.
# If ADMIN_TOKEN is not set, the endpoint is disabled.
ADMIN_TOKEN = os.getenv("ADMIN_TOKEN")

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
    "cb_person_cred_hist_length",
]

RAW_INPUT_COLUMNS = [c for c in FEATURE_COLUMNS if c != "loan_percent_income"]


# ============================================================
# 2. GLOBAL MODEL STATE
# ============================================================

model = None
preprocessors = []
xgb_models = []
calibration_params = []
shap_explainers = []
shap_feature_names = []

current_threshold = DEFAULT_THRESHOLD


# ============================================================
# 3. PYDANTIC INPUT SCHEMAS
# ============================================================

class CreditRiskInput(BaseModel):

    model_config = ConfigDict(extra="forbid")

    person_age: int = Field(ge=18, le=100)
    person_income: float = Field(gt=0, allow_inf_nan=False)
    person_home_ownership: Literal["RENT", "OWN", "MORTGAGE", "OTHER"]
    person_emp_length: float = Field(ge=0, le=100, allow_inf_nan=False)
    loan_intent: Literal[
        "PERSONAL",
        "EDUCATION",
        "MEDICAL",
        "VENTURE",
        "HOMEIMPROVEMENT",
        "DEBTCONSOLIDATION",
    ]
    loan_grade: Literal["A", "B", "C", "D", "E", "F", "G"]
    loan_amnt: float = Field(gt=0, allow_inf_nan=False)
    loan_int_rate: float = Field(ge=0, le=100, allow_inf_nan=False)
    cb_person_default_on_file: Literal["Y", "N"]
    cb_person_cred_hist_length: float = Field(ge=0, le=100, allow_inf_nan=False)

    # Always computed server-side; any client value is overwritten.
    loan_percent_income: float | None = None

    @field_validator(
        "person_home_ownership",
        "loan_intent",
        "loan_grade",
        "cb_person_default_on_file",
        mode="before",
    )
    @classmethod
    def normalise_category(cls, value):
        # Accept " rent ", "a", "y" etc. from forms / CSV files.
        if isinstance(value, str):
            return value.strip().upper()
        return value

    @model_validator(mode="after")
    def validate_and_derive(self):

        if self.person_emp_length > self.person_age:
            raise ValueError(
                "person_emp_length cannot be greater than person_age."
            )

        if self.cb_person_cred_hist_length > self.person_age:
            raise ValueError(
                "cb_person_cred_hist_length cannot be greater than person_age."
            )

        self.loan_percent_income = self.loan_amnt / self.person_income

        return self


class PredictionRequest(BaseModel):
    application: CreditRiskInput
    threshold: float | None = Field(default=None, ge=0, le=1)


class ExplanationRequest(BaseModel):
    application: CreditRiskInput


class WhatIfRequest(BaseModel):
    application: CreditRiskInput
    loan_amnt: float | None = Field(default=None, gt=0, allow_inf_nan=False)
    loan_int_rate: float | None = Field(
        default=None, ge=0, le=100, allow_inf_nan=False
    )
    threshold: float | None = Field(default=None, ge=0, le=1)


# ============================================================
# 4. LOAD FIVE-FOLD MODEL ENSEMBLE
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):

    global model, preprocessors, xgb_models
    global calibration_params, shap_explainers, shap_feature_names

    required_paths = [CALIBRATION_PATH] + PREPROCESSOR_PATHS + XGBOOST_PATHS
    missing_paths = [str(p) for p in required_paths if not p.exists()]

    if missing_paths:
        raise FileNotFoundError(
            "Required model components not found: " + ", ".join(missing_paths)
        )

    loaded_calibration_params = joblib.load(CALIBRATION_PATH)

    if not isinstance(loaded_calibration_params, list):
        raise RuntimeError("Calibration parameters must be a list.")

    if len(loaded_calibration_params) != N_FOLDS:
        raise RuntimeError(
            f"Expected {N_FOLDS} calibration entries, "
            f"found {len(loaded_calibration_params)}."
        )

    for expected_fold, params in enumerate(loaded_calibration_params, start=1):

        if not isinstance(params, dict):
            raise RuntimeError(f"Calibration entry {expected_fold} is invalid.")

        if "a" not in params or "b" not in params:
            raise RuntimeError(
                f"Calibration entry {expected_fold} must contain a and b."
            )

        if int(params.get("fold", expected_fold)) != expected_fold:
            raise RuntimeError("Calibration fold order is incorrect.")

        params["a"] = float(params["a"])
        params["b"] = float(params["b"])

        if not (np.isfinite(params["a"]) and np.isfinite(params["b"])):
            raise RuntimeError(
                f"Invalid calibration values in fold {expected_fold}."
            )

    loaded_preprocessors = []
    loaded_xgb_models = []
    loaded_explainers = []
    loaded_feature_names = []

    for fold_number, (pre_path, xgb_path) in enumerate(
        zip(PREPROCESSOR_PATHS, XGBOOST_PATHS), start=1
    ):

        preprocessor = joblib.load(pre_path)

        if not hasattr(preprocessor, "transform"):
            raise RuntimeError(
                f"Fold {fold_number} preprocessor does not support transform()."
            )

        classifier = XGBClassifier()
        classifier.load_model(str(xgb_path))

        loaded_preprocessors.append(preprocessor)
        loaded_xgb_models.append(classifier)

        # Build SHAP explainers ONCE (they are expensive to construct),
        # not on every /explain request.
        loaded_explainers.append(shap.TreeExplainer(classifier))
        loaded_feature_names.append(
            [str(n) for n in preprocessor.get_feature_names_out()]
        )

        print(f"Successfully loaded fold {fold_number}")

    preprocessors = loaded_preprocessors
    xgb_models = loaded_xgb_models
    calibration_params = loaded_calibration_params
    shap_explainers = loaded_explainers
    shap_feature_names = loaded_feature_names

    model = "5-Fold Calibrated XGBoost Ensemble"

    print("=" * 55)
    print("CREDIT RISK ENSEMBLE LOADED SUCCESSFULLY")
    print("Model:", model)
    print("Folds:", len(xgb_models))
    print("=" * 55)

    yield

    model = None
    preprocessors = []
    xgb_models = []
    calibration_params = []
    shap_explainers = []
    shap_feature_names = []


# ============================================================
# 5. FASTAPI APPLICATION + CORS
# ============================================================

app = FastAPI(
    title="AI Credit Risk Prediction API",
    description=(
        "Credit Default Risk Prediction System "
        "using a five-fold calibrated XGBoost ensemble."
    ),
    version="3.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ============================================================
# 6. HELPER FUNCTIONS
# ============================================================

def model_is_loaded() -> bool:
    return (
        model is not None
        and len(preprocessors) == N_FOLDS
        and len(xgb_models) == N_FOLDS
        and len(calibration_params) == N_FOLDS
        and len(shap_explainers) == N_FOLDS
    )


def check_model():
    if not model_is_loaded():
        # 503 = server not ready, not a client error and not a bug.
        raise HTTPException(
            status_code=503,
            detail="The five-fold credit risk model is not fully loaded.",
        )


def prepare_input(data: dict) -> pd.DataFrame:
    return pd.DataFrame([data], columns=FEATURE_COLUMNS)


def get_threshold(threshold):
    if threshold is None:
        return float(current_threshold)
    return float(threshold)


def classify_risk(probability: float) -> str:
    if probability < 0.20:
        return "Low"
    if probability < 0.50:
        return "Medium"
    return "High"


def decide(probability: float, threshold: float) -> str:
    return "Reject" if probability >= threshold else "Approve"


def get_default_probability(probabilities, classes) -> np.ndarray:

    probabilities = np.asarray(probabilities)

    try:
        classes = list(classes)
    except Exception:
        classes = [0, 1]

    if 1 not in classes:
        raise RuntimeError("Default class 1 was not found.")

    return probabilities[:, classes.index(1)]


def format_validation_error(error: ValidationError) -> str:
    return "; ".join(
        f"{'.'.join(str(p) for p in item['loc'])}: {item['msg']}"
        for item in error.errors()
    )


def sanitize_csv_cell(value):
    """Prevent spreadsheet formula injection in echoed-back CSV text."""
    if isinstance(value, str) and value[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + value
    return value


# ============================================================
# 7. FIVE-FOLD CALIBRATED PREDICTION
# ============================================================

def predict_default_probabilities(input_df: pd.DataFrame) -> np.ndarray:

    check_model()

    if input_df.empty:
        return np.array([], dtype=float)

    fold_probabilities = []

    for preprocessor, classifier, params in zip(
        preprocessors, xgb_models, calibration_params
    ):
        transformed = preprocessor.transform(input_df)

        raw_probabilities = classifier.predict_proba(transformed)

        raw_default = get_default_probability(
            raw_probabilities, getattr(classifier, "classes_", [0, 1])
        )

        # NOTE: this assumes the calibration (a, b) was fitted in exactly
        # this form on the raw XGBoost probability: sigmoid(-(a*p + b)).
        # It must match your training notebook.
        fold_probabilities.append(
            expit(-(params["a"] * raw_default + params["b"]))
        )

    ensemble = np.mean(np.vstack(fold_probabilities), axis=0)

    return np.clip(ensemble, 0.0, 1.0)


# ============================================================
# 8. SINGLE PREDICTION
# ============================================================

def make_prediction(input_data: dict, threshold: float | None = None) -> dict:

    check_model()

    threshold = get_threshold(threshold)

    probability = float(
        predict_default_probabilities(prepare_input(input_data))[0]
    )

    return {
        "default_probability": round(probability, 6),
        "non_default_probability": round(1 - probability, 6),
        "risk_band": classify_risk(probability),
        "decision": decide(probability, threshold),
        "threshold": threshold,
    }


# ============================================================
# 9. SHAP EXPLANATION
# ============================================================

def calculate_shap(input_data: dict) -> list[dict]:

    check_model()

    input_df = prepare_input(input_data)

    fold_values = []
    feature_names = shap_feature_names[0]

    for preprocessor, explainer, names in zip(
        preprocessors, shap_explainers, shap_feature_names
    ):
        transformed = preprocessor.transform(input_df)

        shap_values = explainer.shap_values(transformed)

        if isinstance(shap_values, list):
            shap_values = shap_values[1] if len(shap_values) > 1 else shap_values[0]

        shap_values = np.asarray(shap_values)

        if shap_values.ndim == 3:
            shap_values = shap_values[:, :, -1]

        if shap_values.ndim != 2:
            raise RuntimeError("Unexpected SHAP output dimensions.")

        if shap_values.shape[1] != len(names):
            raise RuntimeError(
                "SHAP feature count does not match preprocessor output."
            )

        if names != feature_names:
            raise RuntimeError(
                "Feature names differ between folds; cannot average SHAP values."
            )

        fold_values.append(shap_values[0])

    average = np.mean(np.vstack(fold_values), axis=0)

    explanations = []

    for feature, impact in zip(feature_names, average):
        impact = float(impact)

        if impact > 0:
            direction = "Increases default risk"
        elif impact < 0:
            direction = "Decreases default risk"
        else:
            direction = "No impact"

        explanations.append(
            {
                "feature": feature,
                "impact": round(impact, 6),
                "direction": direction,
            }
        )

    explanations.sort(key=lambda item: abs(item["impact"]), reverse=True)

    return explanations


# ============================================================
# 10. HOME + HEALTH
# ============================================================

@app.get("/")
def home():
    return {
        "message": "AI Credit Risk Prediction API",
        "status": "running",
        "documentation": "/docs",
        "model": model,
        "endpoints": [
            "/health",
            "/predict",
            "/explain",
            "/what-if",
            "/predict-batch",
            "/threshold",
        ],
    }


@app.get("/health")
def health_check():

    is_loaded = model_is_loaded()

    return {
        "status": "healthy" if is_loaded else "unhealthy",
        "model_loaded": is_loaded,
        "model_name": model,
        "folds_loaded": len(xgb_models),
        "preprocessors_loaded": len(preprocessors),
        "calibration_entries_loaded": len(calibration_params),
    }


# ============================================================
# 11. PREDICT / EXPLAIN / WHAT-IF
# ============================================================

@app.post("/predict")
def predict(request: PredictionRequest):

    try:
        result = make_prediction(
            request.application.model_dump(), request.threshold
        )

        return {"success": True, **result, "prediction": result}

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/explain")
def explain(request: ExplanationRequest):

    try:
        explanations = calculate_shap(request.application.model_dump())

        return {
            "success": True,
            "explanation": explanations,
            "explanations": explanations,
            "note": (
                "Feature contributions are averaged across five XGBoost "
                "folds (log-odds scale). They explain the tree-model output, "
                "not the exact calibrated ensemble probability."
            ),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@app.post("/what-if")
def what_if(request: WhatIfRequest):

    if request.loan_amnt is None and request.loan_int_rate is None:
        raise HTTPException(
            status_code=422,
            detail="Provide loan_amnt and/or loan_int_rate to compare.",
        )

    try:
        threshold = get_threshold(request.threshold)

        original_data = request.application.model_dump()
        original_result = make_prediction(original_data, threshold)

        modified_data = original_data.copy()

        if request.loan_amnt is not None:
            modified_data["loan_amnt"] = request.loan_amnt

        if request.loan_int_rate is not None:
            modified_data["loan_int_rate"] = request.loan_int_rate

        modified_data["loan_percent_income"] = (
            modified_data["loan_amnt"] / modified_data["person_income"]
        )

        new_result = make_prediction(modified_data, threshold)

        difference = (
            new_result["default_probability"]
            - original_result["default_probability"]
        )

        return {
            "success": True,
            "original_prediction": original_result,
            "what_if_prediction": new_result,
            "probability_difference": round(difference, 6),
            "change": (
                "Risk increased"
                if difference > 0
                else "Risk decreased"
                if difference < 0
                else "No change"
            ),
        }

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


# ============================================================
# 12. BATCH CSV PREDICTION
# ============================================================

@app.post("/predict-batch")
async def predict_batch(
    file: UploadFile = File(...),
    threshold: float | None = Form(default=None, ge=0, le=1),
):

    try:

        if not file.filename or not file.filename.lower().endswith(".csv"):
            raise HTTPException(
                status_code=400, detail="Only CSV files are accepted."
            )

        # Read one byte past the limit so oversize files are detected
        # without loading an arbitrarily large upload.
        contents = await file.read(MAX_CSV_SIZE + 1)

        if len(contents) > MAX_CSV_SIZE:
            raise HTTPException(status_code=413, detail="CSV file exceeds 10 MB.")

        try:
            df = pd.read_csv(StringIO(contents.decode("utf-8-sig")))
        except Exception as e:
            raise HTTPException(
                status_code=400, detail="Could not read CSV file as UTF-8."
            ) from e

        if df.empty:
            raise HTTPException(status_code=400, detail="CSV file is empty.")

        if len(df) > MAX_BATCH_ROWS:
            raise HTTPException(
                status_code=400,
                detail=f"Maximum {MAX_BATCH_ROWS} rows are allowed.",
            )

        df.columns = [str(c).strip() for c in df.columns]

        missing_columns = [c for c in RAW_INPUT_COLUMNS if c not in df.columns]

        if missing_columns:
            raise HTTPException(
                status_code=400,
                detail={
                    "message": "Missing required columns.",
                    "missing_columns": missing_columns,
                },
            )

        validated_rows = []
        errors = []

        records = df[RAW_INPUT_COLUMNS].to_dict("records")

        for row_number, record in enumerate(records, start=2):

            try:
                row_data = {
                    key: (value.item() if isinstance(value, np.generic) else value)
                    for key, value in record.items()
                }

                validated_rows.append(CreditRiskInput(**row_data).model_dump())

            except ValidationError as e:
                errors.append(
                    {"row": row_number, "error": format_validation_error(e)}
                )
            except Exception as e:
                errors.append({"row": row_number, "error": str(e)})

        if errors:
            raise HTTPException(
                status_code=422,
                detail={
                    "message": "CSV validation failed.",
                    "errors": errors[:20],
                    "total_invalid_rows": len(errors),
                },
            )

        check_model()

        X = pd.DataFrame(validated_rows, columns=FEATURE_COLUMNS)

        # Run CPU-heavy inference off the event loop.
        default_probabilities = await run_in_threadpool(
            predict_default_probabilities, X
        )

        effective_threshold = get_threshold(threshold)

        result_df = df.copy()

        # Stop spreadsheet formula injection from echoed-back text columns.
        for column in result_df.select_dtypes(include="object").columns:
            result_df[column] = result_df[column].map(sanitize_csv_cell)

        # Write back the normalised values the model actually used.
        for column in RAW_INPUT_COLUMNS:
            result_df[column] = X[column].to_numpy()

        result_df["loan_percent_income"] = X["loan_percent_income"].to_numpy()

        # Percent columns are named explicitly: /predict returns fractions.
        result_df["default_probability_pct"] = (
            default_probabilities * 100
        ).round(2)
        result_df["non_default_probability_pct"] = (
            (1 - default_probabilities) * 100
        ).round(2)

        result_df["risk_band"] = [
            classify_risk(float(p)) for p in default_probabilities
        ]
        result_df["decision"] = [
            decide(float(p), effective_threshold) for p in default_probabilities
        ]

        output = StringIO()
        result_df.to_csv(output, index=False)

        return StreamingResponse(
            iter([output.getvalue()]),
            media_type="text/csv",
            headers={
                "Content-Disposition": (
                    'attachment; filename="credit_risk_predictions.csv"'
                )
            },
        )

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    finally:
        await file.close()


# ============================================================
# 13. THRESHOLD ENDPOINTS
# ============================================================

@app.get("/threshold")
def read_threshold():
    return {"threshold": current_threshold}


@app.put("/threshold")
def update_threshold(
    threshold: float = Query(..., ge=0, le=1),
    x_admin_token: str | None = Header(default=None),
):
    """Changes the server-wide default threshold, so it is protected."""

    global current_threshold

    if not ADMIN_TOKEN:
        raise HTTPException(
            status_code=403,
            detail="Threshold updates are disabled (ADMIN_TOKEN not set).",
        )

    if not x_admin_token or not secrets.compare_digest(
        x_admin_token, ADMIN_TOKEN
    ):
        raise HTTPException(status_code=401, detail="Invalid admin token.")

    current_threshold = float(threshold)

    return {
        "message": "Threshold updated successfully.",
        "threshold": current_threshold,
    }
