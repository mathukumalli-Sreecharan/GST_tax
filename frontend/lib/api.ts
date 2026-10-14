import type { InspectResponse, ProcessResponse } from "@/lib/types";

const base = (process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000").replace(/\/+$/, "");

async function check<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const data = await response.json() as { detail?: string };
      if (data.detail) message = data.detail;
    } catch { /* use HTTP status message */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export async function inspectWorkbook(file: File): Promise<InspectResponse> {
  const body = new FormData();
  body.append("file", file);
  return check<InspectResponse>(await fetch(`${base}/api/excel/inspect`, { method: "POST", body }));
}

export type ProcessFields = {
  worksheet: string;
  firstDataRow: number;
  invoiceCol: number;
  taxableCol: number;
  invoiceNumberCol: number | null;
  invoiceHeaderRow: number;
  taxableHeaderRow: number;
  recalculateExisting: boolean;
  confirmOverwrite: boolean;
};

export async function processWorkbook(file: File, fields: ProcessFields): Promise<ProcessResponse> {
  const body = new FormData();
  body.append("file", file);
  body.append("worksheet", fields.worksheet);
  body.append("first_data_row", String(fields.firstDataRow));
  body.append("invoice_col", String(fields.invoiceCol));
  body.append("taxable_col", String(fields.taxableCol));
  if (fields.invoiceNumberCol !== null) body.append("invoice_number_col", String(fields.invoiceNumberCol));
  body.append("invoice_header_row", String(fields.invoiceHeaderRow));
  body.append("taxable_header_row", String(fields.taxableHeaderRow));
  body.append("recalculate_existing", String(fields.recalculateExisting));
  body.append("confirm_overwrite", String(fields.confirmOverwrite));
  return check<ProcessResponse>(await fetch(`${base}/api/excel/process`, { method: "POST", body }));
}

export async function downloadResult(fileId: string, kind: "download" | "report", filename: string): Promise<void> {
  const response = await fetch(`${base}/api/excel/${kind}/${encodeURIComponent(fileId)}`);
  if (!response.ok) throw new Error("The download has expired. Process the workbook again.");
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
