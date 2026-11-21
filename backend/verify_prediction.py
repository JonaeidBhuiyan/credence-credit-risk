
import joblib
import numpy as np
import pandas as pd
import xgboost as xgb

from scipy.special import expit

# 1. Load calibration parameters
EXPORT_DIR = "credit_risk_export"

calibration_params = joblib.load(
    f"{EXPORT_DIR}/calibration_params.pkl"
)

# 2. Same input used in Google Colab
sample = pd.DataFrame([{
    "person_age": 25,
    "person_income": 60000,
    "person_home_ownership": "RENT",
    "person_emp_length": 2.0,
    "loan_intent": "EDUCATION",
    "loan_grade": "B",
    "loan_amnt": 10000,
    "loan_int_rate": 11.5,
    "loan_percent_income": 10000 / 60000,
    "cb_person_default_on_file": "N",
    "cb_person_cred_hist_length": 3
}])

# 3. Store calibrated probabilities from all folds
fold_probabilities = []

for i in range(1, 6):

    # Load preprocessor
    preprocessor = joblib.load(
        f"{EXPORT_DIR}/preprocessor_{i}.pkl"
    )

    # Load XGBoost model
    xgb_model = xgb.XGBClassifier()
    xgb_model.load_model(
        f"{EXPORT_DIR}/xgboost_{i}.json"
    )

    # Transform input
    X_processed = preprocessor.transform(sample)

    # Raw probability from XGBoost
    raw_probability = xgb_model.predict_proba(
        X_processed
    )[:, 1]

    # Get sigmoid parameters
    params = calibration_params[i - 1]

    a = params["a"]
    b = params["b"]

    # Apply sigmoid calibration
    calibrated_probability = expit(
        -(a * raw_probability + b)
    )

    fold_probabilities.append(
        calibrated_probability[0]
    )

    print(
        f"Fold {i} calibrated probability:",
        calibrated_probability[0]
    )

# 4. Average probabilities from all 5 folds
probability_default = float(
    np.mean(fold_probabilities)
)

probability_non_default = 1 - probability_default

# 5. Compare with original Colab prediction
original_default = 0.03575320568098002

print("\n========== FINAL RESULT ==========")

print(
    "Non-default:",
    probability_non_default
)

print(
    "Default:",
    probability_default
)

print(
    "Original Colab default:",
    original_default
)

print(
    "Absolute difference:",
    abs(probability_default - original_default)
)
