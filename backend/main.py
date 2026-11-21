from contextlib import asynccontextmanager
from pathlib import Path
from io import StringIO

import joblib
import numpy as np
import pandas as pd
import shap

from scipy.special import expit
from xgboost import XGBClassifier

from fastapi import (
    FastAPI,
    HTTPException,
    UploadFile,
    File,
    Form,
    Query,
)

from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware

from pydantic import (
    BaseModel,
    Field,
    model_validator,
    ConfigDict,
)

from typing import Literal


# ============================================================
# 1. PATHS AND CONFIGURATION
# ============================================================

BASE_DIR = Path(__file__).resolve().parent

EXPORT_DIR = BASE_DIR / "credit_risk_export"

CALIBRATION_PATH = EXPORT_DIR / "calibration_params.pkl"

PREPROCESSOR_PATHS = [
    EXPORT_DIR / f"preprocessor_{i}.pkl"
    for i in range(1, 6)
]

XGBOOST_PATHS = [
    EXPORT_DIR / f"xgboost_{i}.json"
    for i in range(1, 6)
]

N_FOLDS = 5

MAX_CSV_SIZE = 10 * 1024 * 1024
MAX_BATCH_ROWS = 10000

DEFAULT_THRESHOLD = 0.50


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


# ============================================================
# 2. GLOBAL MODEL VARIABLES
# ============================================================

model = None

preprocessors = []

xgb_models = []

calibration_params = []

current_threshold = DEFAULT_THRESHOLD


# ============================================================
# 3. PYDANTIC INPUT SCHEMAS
# ============================================================

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

    cb_person_default_on_file: Literal[
        "Y", "N"
    ]

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


class PredictionRequest(BaseModel):

    application: CreditRiskInput

    threshold: float | None = Field(
        default=None,
        ge=0,
        le=1
    )


class ExplanationRequest(BaseModel):

    application: CreditRiskInput


class WhatIfRequest(BaseModel):

    application: CreditRiskInput

    loan_amnt: float | None = Field(
        default=None,
        gt=0,
        allow_inf_nan=False
    )

    loan_int_rate: float | None = Field(
        default=None,
        ge=0,
        le=100,
        allow_inf_nan=False
    )

    threshold: float | None = Field(
        default=None,
        ge=0,
        le=1
    )


# ============================================================
# 4. LOAD FIVE-FOLD MODEL ENSEMBLE
# ============================================================

@asynccontextmanager
async def lifespan(app: FastAPI):

    global model
    global preprocessors
    global xgb_models
    global calibration_params

    required_paths = (
        [CALIBRATION_PATH]
        + PREPROCESSOR_PATHS
        + XGBOOST_PATHS
    )

    missing_paths = [
        str(path)
        for path in required_paths
        if not path.exists()
    ]

    if missing_paths:

        raise FileNotFoundError(
            "Required model components not found: "
            + ", ".join(missing_paths)
        )

    loaded_preprocessors = []

    loaded_xgb_models = []

    loaded_calibration_params = joblib.load(
        CALIBRATION_PATH
    )

    if not isinstance(
        loaded_calibration_params,
        list
    ):

        raise RuntimeError(
            "Calibration parameters must be a list."
        )

    if len(loaded_calibration_params) != N_FOLDS:

        raise RuntimeError(
            f"Expected {N_FOLDS} calibration entries, "
            f"found {len(loaded_calibration_params)}."
        )

    # Validate calibration parameters

    for expected_fold, params in enumerate(
        loaded_calibration_params,
        start=1
    ):

        if not isinstance(params, dict):

            raise RuntimeError(
                f"Calibration entry {expected_fold} is invalid."
            )

        if "a" not in params or "b" not in params:

            raise RuntimeError(
                f"Calibration entry {expected_fold} "
                "must contain a and b."
            )

        params_fold = int(
            params.get("fold", expected_fold)
        )

        if params_fold != expected_fold:

            raise RuntimeError(
                "Calibration fold order is incorrect."
            )

        params["a"] = float(params["a"])

        params["b"] = float(params["b"])

    # Load five preprocessors and five XGBoost models

    for fold_number, (
        preprocessor_path,
        xgb_path
    ) in enumerate(
        zip(
            PREPROCESSOR_PATHS,
            XGBOOST_PATHS
        ),
        start=1
    ):

        preprocessor = joblib.load(
            preprocessor_path
        )

        if not hasattr(
            preprocessor,
            "transform"
        ):

            raise RuntimeError(
                f"Fold {fold_number} preprocessor "
                "does not support transform()."
            )

        classifier = XGBClassifier()

        classifier.load_model(
            str(xgb_path)
        )

        if not hasattr(
            classifier,
            "predict_proba"
        ):

            raise RuntimeError(
                f"Fold {fold_number} model "
                "does not support predict_proba()."
            )

        loaded_preprocessors.append(
            preprocessor
        )

        loaded_xgb_models.append(
            classifier
        )

        print(
            f"Successfully loaded fold {fold_number}"
        )

    # Assign loaded components

    preprocessors = loaded_preprocessors

    xgb_models = loaded_xgb_models

    calibration_params = loaded_calibration_params

    model = "5-Fold Calibrated XGBoost Ensemble"

    print("=" * 55)

    print("CREDIT RISK ENSEMBLE LOADED SUCCESSFULLY")

    print("Model:", model)

    print("Folds:", len(xgb_models))

    print("Export directory:", EXPORT_DIR)

    print("=" * 55)

    yield

    # Shutdown cleanup

    model = None

    preprocessors = []

    xgb_models = []

    calibration_params = []


# ============================================================
# 5. FASTAPI APPLICATION
# ============================================================

app = FastAPI(

    title="AI Credit Risk Prediction API",

    description=(
        "Credit Default Risk Prediction System "
        "using a five-fold calibrated XGBoost ensemble."
    ),

    version="3.0.0",

    lifespan=lifespan
)


# ============================================================
# 6. CORS
# ============================================================

app.add_middleware(

    CORSMiddleware,

    allow_origins=["*"],

    allow_credentials=False,

    allow_methods=["*"],

    allow_headers=["*"]
)


# ============================================================
# 7. HELPER FUNCTIONS
# ============================================================

def check_model():

    if (
        model is None
        or len(preprocessors) != N_FOLDS
        or len(xgb_models) != N_FOLDS
        or len(calibration_params) != N_FOLDS
    ):

        raise RuntimeError(
            "The five-fold credit risk model "
            "is not fully loaded."
        )


def prepare_input(data: dict):

    input_df = pd.DataFrame(

        [data],

        columns=FEATURE_COLUMNS
    )

    return input_df


def get_threshold(threshold):

    if threshold is None:

        return float(current_threshold)

    return float(threshold)


def classify_risk(probability: float):

    if probability < 0.20:

        return "Low"

    if probability < 0.50:

        return "Medium"

    return "High"


def get_default_probability(
    probabilities,
    classes
):

    classes = list(classes)

    if 1 not in classes:

        raise RuntimeError(
            "Default class 1 was not found."
        )

    default_index = classes.index(1)

    return np.asarray(probabilities)[
        :,
        default_index
    ]


# ============================================================
# 8. FIVE-FOLD CALIBRATED PREDICTION
# ============================================================

def predict_default_probabilities(input_df):

    check_model()

    if input_df.empty:

        return np.array([], dtype=float)

    calibrated_fold_probabilities = []

    for (
        preprocessor,
        classifier,
        params
    ) in zip(
        preprocessors,
        xgb_models,
        calibration_params
    ):

        # Step 1: Preprocessing

        transformed_data = preprocessor.transform(
            input_df
        )

        # Step 2: Raw XGBoost probabilities

        raw_probabilities = classifier.predict_proba(
            transformed_data
        )

        # Step 3: Extract default class probability

        raw_default_probability = get_default_probability(
            raw_probabilities,
            classifier.classes_
        )

        # Step 4: Apply sigmoid calibration

        calibrated_probability = expit(
            -(
                params["a"]
                * raw_default_probability
                + params["b"]
            )
        )

        calibrated_fold_probabilities.append(
            calibrated_probability
        )

    # Step 5: Average five calibrated probabilities

    fold_matrix = np.vstack(
        calibrated_fold_probabilities
    )

    ensemble_probabilities = np.mean(
        fold_matrix,
        axis=0
    )

    return np.clip(
        ensemble_probabilities,
        0.0,
        1.0
    )


# ============================================================
# 9. SINGLE PREDICTION LOGIC
# ============================================================

def make_prediction(
    input_data: dict,
    threshold: float | None = None
):

    check_model()

    threshold = get_threshold(
        threshold
    )

    input_df = prepare_input(
        input_data
    )

    probability = float(
        predict_default_probabilities(
            input_df
        )[0]
    )

    non_default_probability = (
        1 - probability
    )

    risk_band = classify_risk(
        probability
    )

    decision = (
        "Reject"
        if probability >= threshold
        else "Approve"
    )

    return {

        # Return probability as a fraction (0 to 1)
        "default_probability": round(
            probability,
            6
        ),

        "non_default_probability": round(
            non_default_probability,
            6
        ),

        "risk_band": risk_band,

        "decision": decision,

        "threshold": threshold
    }


# ============================================================
# 10. SHAP EXPLANATION
# ============================================================

def calculate_shap(data: dict):

    check_model()

    input_df = prepare_input(
        data
    )

    fold_shap_values = []

    feature_names_reference = None

    for (
        preprocessor,
        classifier
    ) in zip(
        preprocessors,
        xgb_models
    ):

        transformed_data = preprocessor.transform(
            input_df
        )

        feature_names = list(
            preprocessor.get_feature_names_out()
        )

        if feature_names_reference is None:

            feature_names_reference = feature_names

        elif feature_names != feature_names_reference:

            raise RuntimeError(
                "Feature names differ between folds."
            )

        explainer = shap.TreeExplainer(
            classifier
        )

        shap_values = explainer.shap_values(
            transformed_data
        )

        if isinstance(shap_values, list):

            if len(shap_values) > 1:

                values = np.asarray(
                    shap_values[1]
                )[0]

            else:

                values = np.asarray(
                    shap_values[0]
                )[0]

        else:

            values = np.asarray(
                shap_values
            )

            if values.ndim == 3:

                values = values[0, :, 1]

            elif values.ndim == 2:

                values = values[0]

            elif values.ndim == 1:

                pass

            else:

                raise RuntimeError(
                    f"Unexpected SHAP shape: {values.shape}"
                )

        values = np.asarray(
            values
        ).reshape(-1)

        if len(feature_names) != len(values):

            raise RuntimeError(
                "SHAP feature count does not match."
            )

        fold_shap_values.append(
            values.astype(float)
        )

    # Average SHAP values from five folds

    mean_shap_values = np.mean(
        np.vstack(fold_shap_values),
        axis=0
    )

    explanations = []

    for name, impact in zip(
        feature_names_reference,
        mean_shap_values
    ):

        impact = float(impact)

        explanations.append({

            "feature": str(name),

            "impact": round(
                impact,
                6
            ),

            "direction": (

                "Increases model output"

                if impact > 0

                else "Decreases model output"

                if impact < 0

                else "No impact"
            )
        })

    explanations.sort(

        key=lambda item: abs(
            item["impact"]
        ),

        reverse=True
    )

    return explanations


# ============================================================
# 11. HOME ENDPOINT
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

            "/threshold"
        ]
    }


# ============================================================
# 12. HEALTH CHECK
# ============================================================

@app.get("/health")
def health_check():

    is_loaded = (

        model is not None

        and len(preprocessors) == N_FOLDS

        and len(xgb_models) == N_FOLDS

        and len(calibration_params) == N_FOLDS
    )

    return {

        "status": (
            "healthy"
            if is_loaded
            else "unhealthy"
        ),

        "model_loaded": is_loaded,

        "model_name": model,

        "folds_loaded": len(xgb_models),

        "preprocessors_loaded": len(preprocessors),

        "calibration_entries_loaded": len(
            calibration_params
        )
    }


# ============================================================
# 13. PREDICTION ENDPOINT
# ============================================================

@app.post("/predict")
def predict(request: PredictionRequest):

    try:

        input_data = request.application.model_dump()

        result = make_prediction(

            input_data,

            request.threshold
        )

        return {

            "success": True,

            **result,

            "prediction": result
        }

    except Exception as e:

        raise HTTPException(

            status_code=500,

            detail=str(e)
        ) from e


# ============================================================
# 14. EXPLANATION ENDPOINT
# ============================================================

@app.post("/explain")
def explain(request: ExplanationRequest):

    try:

        input_data = request.application.model_dump()

        explanations = calculate_shap(
            input_data
        )

        return {

            "success": True,

            "explanation": explanations,

            "explanations": explanations,

            "note": (
                "Feature contributions are averaged across "
                "five XGBoost folds. They explain tree-model "
                "output, not the exact calibrated ensemble probability."
            )
        }

    except Exception as e:

        raise HTTPException(

            status_code=500,

            detail=str(e)
        ) from e



# ============================================================
# 15. WHAT-IF ENDPOINT
# ============================================================

@app.post("/what-if")
def what_if(request: WhatIfRequest):

    try:

        # Step 1: Get threshold
        threshold = get_threshold(
            request.threshold
        )

        # Step 2: Get original application data
        original_data = request.application.model_dump()

        # Step 3: Get original prediction
        original_result = make_prediction(
            original_data,
            threshold
        )

        # Step 4: Create a copy of original data
        modified_data = original_data.copy()

        # Step 5: Apply user modifications
        if request.loan_amnt is not None:

            modified_data["loan_amnt"] = (
                request.loan_amnt
            )

        if request.loan_int_rate is not None:

            modified_data["loan_int_rate"] = (
                request.loan_int_rate
            )

        # Step 6: Recalculate derived feature
        modified_data["loan_percent_income"] = (

            modified_data["loan_amnt"]

            / modified_data["person_income"]
        )

        # Step 7: Get new prediction
        new_result = make_prediction(
            modified_data,
            threshold
        )

        # Step 8: Calculate probability difference
        # Probability is in fraction format (0 to 1)
        difference = (

            new_result["default_probability"]

            - original_result["default_probability"]
        )

        # Step 9: Return comparison
        return {

            "success": True,

            "original_prediction": original_result,

            "what_if_prediction": new_result,

            "probability_difference": round(
                difference,
                6
            ),

            "change": (

                "Risk increased"

                if difference > 0

                else "Risk decreased"

                if difference < 0

                else "No change"
            )
        }

    except Exception as e:

        raise HTTPException(

            status_code=400,

            detail=str(e)
        ) from e


# ============================================================
# 16. BATCH CSV PREDICTION
# ============================================================

@app.post("/predict-batch")
async def predict_batch(

    file: UploadFile = File(...),

    threshold: float = Form(
        DEFAULT_THRESHOLD,
        ge=0,
        le=1
    )
):

    try:

        # Check file extension

        if (
            not file.filename

            or not file.filename.lower().endswith(".csv")
        ):

            raise HTTPException(

                status_code=400,

                detail="Only CSV files are accepted."
            )

        # Read file

        contents = await file.read()

        if len(contents) > MAX_CSV_SIZE:

            raise HTTPException(

                status_code=413,

                detail="CSV file exceeds 10 MB."
            )

        # Read CSV

        try:

            decoded_contents = contents.decode(
                "utf-8-sig"
            )

            df = pd.read_csv(
                StringIO(decoded_contents)
            )

        except Exception as e:

            raise HTTPException(

                status_code=400,

                detail="Could not read CSV file as UTF-8."
            ) from e

        if df.empty:

            raise HTTPException(

                status_code=400,

                detail="CSV file is empty."
            )

        if len(df) > MAX_BATCH_ROWS:

            raise HTTPException(

                status_code=400,

                detail=(
                    f"Maximum {MAX_BATCH_ROWS} rows are allowed."
                )
            )

        # Required input columns

        required_columns = [

            column

            for column in FEATURE_COLUMNS

            if column != "loan_percent_income"
        ]

        missing_columns = [

            column

            for column in required_columns

            if column not in df.columns
        ]

        if missing_columns:

            raise HTTPException(

                status_code=400,

                detail={

                    "message": "Missing required columns.",

                    "missing_columns": missing_columns
                }
            )

        # Validate each CSV row

        validated_rows = []

        errors = []

        for row_position, (_, row) in enumerate(

            df.iterrows(),

            start=2
        ):

            try:

                row_data = row[
                    required_columns
                ].to_dict()

                row_data = {

                    key: (

                        value.item()

                        if isinstance(value, np.generic)

                        else value
                    )

                    for key, value in row_data.items()
                }

                validated = CreditRiskInput(
                    **row_data
                )

                validated_rows.append(
                    validated.model_dump()
                )

            except Exception as e:

                errors.append({

                    "row": row_position,

                    "error": str(e)
                })

        if errors:

            raise HTTPException(

                status_code=422,

                detail={

                    "message": "CSV validation failed.",

                    "errors": errors[:20],

                    "total_invalid_rows": len(errors)
                }
            )

        check_model()

        X = pd.DataFrame(

            validated_rows,

            columns=FEATURE_COLUMNS
        )

        # IMPORTANT:
        # Batch prediction uses the same five-fold
        # calibration logic as the single prediction endpoint.

        default_probabilities = (
            predict_default_probabilities(X)
        )

        result_df = df.copy()

        result_df["loan_percent_income"] = (
            X["loan_percent_income"].to_numpy()
        )

        result_df["default_probability"] = (

            default_probabilities * 100
        ).round(2)

        result_df["non_default_probability"] = (

            (1 - default_probabilities) * 100
        ).round(2)

        result_df["risk_band"] = [

            classify_risk(
                float(probability)
            )

            for probability in default_probabilities
        ]

        result_df["decision"] = [

            (
                "Reject"

                if probability >= threshold

                else "Approve"
            )

            for probability in default_probabilities
        ]

        # Convert results into CSV

        output = StringIO()

        result_df.to_csv(

            output,

            index=False
        )

        output.seek(0)

        return StreamingResponse(

            iter([
                output.getvalue()
            ]),

            media_type="text/csv",

            headers={

                "Content-Disposition": (
                    'attachment; filename="credit_risk_predictions.csv"'
                )
            }
        )

    except HTTPException:

        raise

    except Exception as e:

        raise HTTPException(

            status_code=400,

            detail=str(e)
        ) from e

    finally:

        await file.close()


# ============================================================
# 17. THRESHOLD ENDPOINTS
# ============================================================

@app.get("/threshold")
def read_threshold():

    return {

        "threshold": current_threshold
    }


@app.put("/threshold")
def update_threshold(

    threshold: float = Query(
        ...,
        ge=0,
        le=1
    )
):

    global current_threshold

    current_threshold = float(
        threshold
    )

    return {

        "message": "Threshold updated successfully.",

        "threshold": current_threshold
    }