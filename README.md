# GST Ledger Studio

A local desktop-first Excel GST workflow with a Next.js/TypeScript frontend and a FastAPI backend. It calls the existing OpenPyXL processor and Decimal based GST rules in `excel_processor.py` and `gst_calculator.py`. It does not use Streamlit, a database, cloud storage, or external APIs.

## Run locally on Windows

Use two PowerShell terminals from the project directory.

### 1. Install and start the backend

```powershell
python -m pip install -r requirements.txt
python -m uvicorn backend.main:app --reload --host 127.0.0.1 --port 8000
```

### 2. Install and start the frontend

```powershell
cd frontend
npm.cmd install
npm.cmd run dev
```

Open `http://localhost:3000`. The frontend calls the local API at `http://localhost:8000`. Set `NEXT_PUBLIC_API_BASE` if you need a different local backend address.

## Workflow

1. Upload an `.xlsx` workbook (20 MB maximum) and select a worksheet.
2. Confirm or change detected Invoice Value and Taxable Value columns; Invoice Number is optional.
3. Review the first data row and, if present, the existing `Rate(%)` column behavior.
4. Calculate, inspect results and verification rows, then download the updated workbook and separate CSV report.

Existing GST logic remains in the existing modules: expected taxable values are Invoice Value × 100 / 105 and × 100 / 118; the nearest supported rate is assigned. Differences below ₹1 match, differences from ₹1 to less than ₹50 are assigned and flagged, and differences of ₹50 or more remain blank. Exceptional and ambiguous rows remain flagged. Existing Rate(%) values are kept unless the user confirms recalculation.

## Excel preservation

Workbook editing stays in OpenPyXL. The output keeps the original sheets and workbook layout while inserting only the Rate(%) column. When OpenPyXL cannot safely preserve a workbook feature or update formula references, processing stops with a clear error instead of returning a potentially damaged file. Existing rate columns are reused; choosing to keep them returns an exact copy of the input package. Generated files are stored in a local temporary directory and their opaque download IDs expire after one hour.

## Tests and build

From the project root:

```powershell
python -m pytest -q
```

From `frontend`:

```powershell
npm.cmd run build
```

The regression tests use the KK May and KK April original/updated workbook pairs present in this project.
