"""Verification report generation helpers."""
import csv
import io
import json


def report_csv(rows):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    trace = any("output_rows" in row for row in rows)
    writer.writerow(["Excel row", "Invoice Value column", "Invoice Value column number", "Invoice Value header",
                     "Taxable Value column", "Taxable Value column number", "Taxable Value header",
                     "Rate(%) column", "Rate(%) column number", "Difference (₹)", "Assigned rate", "Message"] + (["Output Excel rows", "Confirmed replacement allocations"] if trace else []))
    for r in rows:
        writer.writerow([r["row"], r["invoice_letter"], r["invoice_col"], r["invoice_header"],
                         r["taxable_letter"], r["taxable_col"], r["taxable_header"],
                         r["rate_letter"], r["rate_col"], r["difference"], r["rate"] if r["rate"] is not None else "",
                         "Once again verify the following row. " + r["message"]] + ([", ".join(map(str, r.get("output_rows", []))), json.dumps(r.get("replacement_rows", []))] if trace else []))
    return "\ufeff" + stream.getvalue()
