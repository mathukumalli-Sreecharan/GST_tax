import { browserClient } from "@/lib/supabase/browser";
import type { InspectResponse, ReviewSession } from "@/lib/types";

const base = (process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000").replace(/\/+$/, "");

export async function authenticatedFetch(url: string, init: RequestInit = {}): Promise<Response> {
 const client = browserClient();
 let {data:{session}} = await client.auth.getSession();
 const send = () => fetch(url,{...init,headers:{...init.headers,Authorization:`Bearer ${session?.access_token ?? ''}`}});
 if (!session) { window.dispatchEvent(new Event('auth-required')); throw new Error('Sign in again, then retry. Your source workbook is retained.'); }
 let response = await send();
 if(response.status===401) {
  const refreshed = await client.auth.refreshSession(); session=refreshed.data.session;
  if(session) response=await send();
  if(!session || response.status===401) {window.dispatchEvent(new Event('auth-required'));throw new Error('Sign in again, then retry. Your source workbook is retained.');}
 }
 if(response.status===403 && (url.includes('/api/excel/') || url.includes('/api/files'))) window.dispatchEvent(new Event('approval-required'));
 return response;
}

export async function approvalApi<T>(path: string, init: RequestInit = {}): Promise<T> {
 return check<T>(await authenticatedFetch(`${base}/api${path}`, {...init, cache: 'no-store'}));
}

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
  return check<InspectResponse>(await authenticatedFetch(`${base}/api/excel/inspect`, { method: "POST", body }));
}

export type ProcessFields = {
  worksheet: string;
  monetaryColumns?: Record<string, number | null>;
  firstDataRow: number;
  invoiceCol: number;
  taxableCol: number;
  invoiceNumberCol: number | null;
  invoiceHeaderRow: number;
  taxableHeaderRow: number;
  recalculateExisting: boolean;
  confirmOverwrite: boolean;
};

export async function processWorkbook(file: File, fields: ProcessFields): Promise<ReviewSession> {
  const body = new FormData();
  body.append("file", file);
  body.append("worksheet", fields.worksheet);
  if (fields.monetaryColumns) body.append("monetary_columns", JSON.stringify(fields.monetaryColumns));
  body.append("first_data_row", String(fields.firstDataRow));
  body.append("invoice_col", String(fields.invoiceCol));
  body.append("taxable_col", String(fields.taxableCol));
  if (fields.invoiceNumberCol !== null) body.append("invoice_number_col", String(fields.invoiceNumberCol));
  body.append("invoice_header_row", String(fields.invoiceHeaderRow));
  body.append("taxable_header_row", String(fields.taxableHeaderRow));
  body.append("recalculate_existing", String(fields.recalculateExisting));
  body.append("confirm_overwrite", String(fields.confirmOverwrite));
  return check<ReviewSession>(await authenticatedFetch(`${base}/api/excel/process`, { method: "POST", body }));
}

export async function downloadResult(fileId: string, kind: "download" | "report", filename: string, reviewId?: string): Promise<void> {
  const response = await authenticatedFetch(reviewId ? `${base}/api/excel/reviews/${encodeURIComponent(reviewId)}/${kind}` : `${base}/api/excel/${kind}/${encodeURIComponent(fileId)}`);
  return saveDownload(response, filename);
}

export async function downloadSavedFile(fileId: string, filename: string): Promise<void> {
  return saveDownload(await authenticatedFetch(`${base}/api/files/${encodeURIComponent(fileId)}/download`, {cache:'no-store'}),filename);
}

async function saveDownload(response: Response, filename: string): Promise<void> {
  if (!response.ok) {
    let message = 'This download is unavailable. Check your access and try again.';
    try { const body = await response.json() as {detail?:string}; if(body.detail) message=body.detail; } catch { /* use safe fallback */ }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
