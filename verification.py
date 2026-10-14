"""Verification report generation helpers."""
import csv
import io


def report_csv(rows):
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(["Excel row", "Invoice Value column", "Invoice Value column number", "Invoice Value header",
                     "Taxable Value column", "Taxable Value column number", "Taxable Value header",
                     "Rate(%) column", "Rate(%) column number", "Difference (₹)", "Assigned rate", "Message"])
    for r in rows:
        writer.writerow([r["row"], r["invoice_letter"], r["invoice_col"], r["invoice_header"],
                         r["taxable_letter"], r["taxable_col"], r["taxable_header"],
                         r["rate_letter"], r["rate_col"], r["difference"], r["rate"] or "",
                         "Once again verify the following row. " + r["message"]])
    return "\ufeff" + stream.getvalue()
