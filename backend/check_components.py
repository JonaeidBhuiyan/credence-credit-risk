
import os
import joblib
import xgboost as xgb

EXPORT_DIR = "credit_risk_export"

# 1. Load calibration parameters
calibration_params = joblib.load(
    os.path.join(EXPORT_DIR, "calibration_params.pkl")
)

print("Calibration parameters loaded:", len(calibration_params))

# 2. Load all 5 preprocessors and XGBoost models
for i in range(1, 6):

    preprocessor_path = os.path.join(
        EXPORT_DIR, f"preprocessor_{i}.pkl"
    )

    xgboost_path = os.path.join(
        EXPORT_DIR, f"xgboost_{i}.json"
    )

    preprocessor = joblib.load(preprocessor_path)

    xgb_model = xgb.XGBClassifier()
    xgb_model.load_model(xgboost_path)

    print(f"Fold {i}: Successfully loaded")

print("\nALL COMPONENTS LOADED SUCCESSFULLY!")
