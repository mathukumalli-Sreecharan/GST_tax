from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app


client = TestClient(app)


def test_inspect_and_process_regression_workbook():
    source = Path("KKENGIN APRIL-26.xlsx")
    if not source.exists():
        return
    data = source.read_bytes()
    inspected = client.post("/api/excel/inspect", files={"file": (source.name, data,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")})
    assert inspected.status_code == 200
    body = inspected.json()
    sheet = body["sheets"][0]
    assert sheet["name"] == "B2B"
    assert sheet["detected"]["invoice_col"] == 6
    assert sheet["detected"]["taxable_col"] == 9

    processed = client.post("/api/excel/process", files={"file": (source.name, data,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}, data={
            "worksheet": "B2B", "first_data_row": "7", "invoice_col": "6", "taxable_col": "9",
            "invoice_number_col": "3", "invoice_header_row": "6", "taxable_header_row": "5",
        })
    assert processed.status_code == 200, processed.text
    result = processed.json()
    assert result["rate_column"] == {"letter": "J", "index": 10}
    assert result["summary"]["total"] > 0
    assert all(row["status"] != "MATCHED" for row in result["verification"])

    output = client.get(f"/api/excel/download/{result['file_id']}")
    report = client.get(f"/api/excel/report/{result['file_id']}")
    assert output.status_code == 200 and output.headers["content-type"].startswith("application/vnd.openxmlformats-officedocument")
    assert "filename*=utf-8''updated_KKENGIN%20APRIL-26.xlsx" in output.headers["content-disposition"]
    assert report.status_code == 200 and b"Excel row" in report.content


def test_download_rejects_unknown_file_id():
    response = client.get("/api/excel/download/not-a-real-id")
    assert response.status_code == 404


def test_api_rejects_non_xlsx_upload():
    response = client.post("/api/excel/inspect", files={"file": ("book.xls", b"not excel", "application/octet-stream")})
    assert response.status_code == 400


def test_existing_rate_column_requires_confirmation_and_is_reused():
    source = Path("updated_KK MAY.xlsx")
    if not source.exists():
        return
    content = source.read_bytes()
    upload = {"file": (source.name, content,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    base_fields = {"worksheet": "B2B", "first_data_row": "7", "invoice_col": "6", "taxable_col": "9",
                   "invoice_number_col": "3", "invoice_header_row": "6", "taxable_header_row": "5"}

    refused = client.post("/api/excel/process", files=upload,
                          data={**base_fields, "recalculate_existing": "true", "confirm_overwrite": "false"})
    assert refused.status_code == 400
    assert "Confirm overwrite" in refused.json()["detail"]

    kept = client.post("/api/excel/process", files=upload, data=base_fields)
    assert kept.status_code == 200, kept.text
    keep_result = kept.json()
    assert keep_result["rate_column"] == {"letter": "J", "index": 10}
    kept_download = client.get(f"/api/excel/download/{keep_result['file_id']}")
    assert kept_download.content == content

    confirmed = client.post("/api/excel/process", files=upload,
                            data={**base_fields, "recalculate_existing": "true", "confirm_overwrite": "true"})
    assert confirmed.status_code == 200, confirmed.text
    confirmed_result = confirmed.json()
    workbook_bytes = client.get(f"/api/excel/download/{confirmed_result['file_id']}").content
    from io import BytesIO
    from openpyxl import load_workbook
    workbook = load_workbook(BytesIO(workbook_bytes), data_only=False)
    sheet = workbook["B2B"]
    assert sheet.max_column == 22
    assert sum(1 for row in sheet.iter_rows(min_row=1, max_row=40) for cell in row
               if str(cell.value or "").strip().lower() == "rate(%)") == 1
    workbook.close()
