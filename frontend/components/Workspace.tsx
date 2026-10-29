"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CellContext, ColumnDef } from "@tanstack/react-table";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  Activity, AlertCircle, ArrowDownToLine, ArrowRight, BadgeCheck, Check, ChevronRight,
  CircleAlert, CircleCheck, CircleHelp, FileCheck2, FileSpreadsheet,
  FolderClosed, Lightbulb, RotateCw, Settings2, ShieldCheck, TriangleAlert, Upload, X, type LucideIcon,
} from "lucide-react";
import { TransactionReview } from "@/components/TransactionReview";
import { DataTable } from "@/components/DataTable";
import {WorkspaceShell,type WorkspaceNav} from "@/components/WorkspaceShell";
import Link from 'next/link';
import { downloadResult, inspectWorkbook, processWorkbook } from "@/lib/api";
import type { ColumnMeta, InspectResponse, ProcessResponse, ResultRow, SheetInfo, ReviewSession } from "@/lib/types";

type PageName = Exclude<WorkspaceNav,"My Files">;
const mappingSchema = z.object({ invoiceCol: z.number().int().positive(), taxableCol: z.number().int().positive() })
  .refine((value) => value.invoiceCol !== value.taxableCol, { message: "Invoice Value and Taxable Value must use different columns." });
type MappingValues = z.infer<typeof mappingSchema>;
const sizeLimit = 20 * 1024 * 1024;
const supportedRates = [5, 12, 18, 28] as const;
type SupportedRate = (typeof supportedRates)[number];

function rateCount(summary: ProcessResponse["summary"], rate: SupportedRate): number {
  const key = String(rate) as keyof NonNullable<ProcessResponse["summary"]["rate_counts"]>;
  const legacyKey = ({ 5: "five_percent", 12: "twelve_percent", 18: "eighteen_percent", 28: "twenty_eight_percent" } as const)[rate];
  return summary.rate_counts?.[key] ?? summary[legacyKey] ?? 0;
}

function Status({ status }: { status: ResultRow["status"] }) {
  return <span className={`status ${status.replaceAll(" ", "_")}`}>{status}</span>;
}

function formatDifference(value: string) {
  if (!value) return "—";
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
    : value;
}

function metric(label: string, value: number, note: string, tone = "") {
  return <div className="metric" key={label}><div className="metric-label">{label}</div><div className="metric-value" style={tone ? { color: tone } : undefined}>{value.toLocaleString()}</div><div className="metric-note">{note}</div></div>;
}
function colLabel(column: ColumnMeta) { return `${column.letter} · ${column.header}`; }

export default function Home({accountActions}:{accountActions?:ReactNode}) {
  const [page, setPage] = useState<PageName>("Dashboard");
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<InspectResponse | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [invoiceNumberCol, setInvoiceNumberCol] = useState<number | null>(null);
  const [firstDataRow, setFirstDataRow] = useState(2);
  const [stage, setStage] = useState(0);
  const [result, setResult] = useState<ProcessResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [rateAction, setRateAction] = useState<"keep" | "recalculate">("keep");
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [selectedVerification, setSelectedVerification] = useState<ResultRow | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [review, setReview] = useState<ReviewSession | null>(null);
  const [monetaryColumns, setMonetaryColumns] = useState<Record<string, number | null>>({});
  useEffect(()=>{
    const requested=new URLSearchParams(window.location.search).get('page');
    if(requested==='Dashboard'||requested==='Process Excel'||requested==='Verification'||requested==='Settings')setPage(requested);
  },[]);
  const activeSheet: SheetInfo | undefined = inspection?.sheets.find((sheet) => sheet.name === sheetName);
  const mappingForm = useForm<MappingValues>({ resolver: zodResolver(mappingSchema), defaultValues: { invoiceCol: 1, taxableCol: 2 } });
  const invoiceCol = mappingForm.watch("invoiceCol");
  const taxableCol = mappingForm.watch("taxableCol");

  const navigate = (next: PageName) => { setPage(next); setError(""); setSuccess(""); };

  const selectFile = async (newFile: File | undefined) => {
    if (!newFile) return;
    setError(""); setSuccess(""); setInspection(null); setResult(null); setReview(null); setStage(0); setFile(newFile);
    if (!newFile.name.toLowerCase().endsWith(".xlsx")) { setError("Choose an .xlsx workbook. Other formats are not supported."); return; }
    if (newFile.size > sizeLimit) { setError("The workbook exceeds the 20 MB upload limit."); return; }
    setBusy(true);
    try {
      const inspected = await inspectWorkbook(newFile);
      setInspection(inspected);
      const initial = inspected.sheets[0];
      if (initial) {
        setSheetName(initial.name);
        setMonetaryColumns({});
        const found = initial.detected;
        mappingForm.reset({ invoiceCol: found?.invoice_col ?? 1, taxableCol: found?.taxable_col ?? Math.min(2, initial.max_column) });
        setInvoiceNumberCol(initial.invoice_number?.column ?? null);
        setFirstDataRow(found ? Math.max(found.invoice_header_row, found.taxable_header_row) + 1 : 2);
        setRateAction("keep"); setConfirmOverwrite(false); setStage(1);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not inspect this workbook."); }
    finally { setBusy(false); }
  };

  const changeSheet = (name: string) => {
    const next = inspection?.sheets.find((item) => item.name === name);
    if (!next) return;
    setSheetName(name);
    setMonetaryColumns({});
    mappingForm.reset({ invoiceCol: next.detected?.invoice_col ?? 1, taxableCol: next.detected?.taxable_col ?? Math.min(2, next.max_column) });
    setInvoiceNumberCol(next.invoice_number?.column ?? null);
    setFirstDataRow(next.detected ? Math.max(next.detected.invoice_header_row, next.detected.taxable_header_row) + 1 : 2);
    setRateAction("keep"); setConfirmOverwrite(false); setStage(1); setResult(null);
  };

  const doProcess = async () => {
    if (!file || !activeSheet || busy) return;
    const validation = mappingSchema.safeParse({ invoiceCol, taxableCol });
    if (!validation.success) { setError(validation.error.issues[0]?.message ?? "Check the selected columns."); return; }
    if (activeSheet.existing_rate && rateAction === "recalculate" && !confirmOverwrite) {
      setError("Confirm that the existing Rate(%) values may be overwritten before continuing."); return;
    }
    setBusy(true); setError(""); setSuccess(""); setStage(2);
    try {
      const processed = await processWorkbook(file, { worksheet: sheetName, firstDataRow,
        invoiceCol, taxableCol, invoiceNumberCol, monetaryColumns,
        invoiceHeaderRow: activeSheet.detected?.invoice_header_row ?? firstDataRow - 1,
        taxableHeaderRow: activeSheet.detected?.taxable_header_row ?? firstDataRow - 1,
        recalculateExisting: Boolean(activeSheet.existing_rate && rateAction === "recalculate"),
        confirmOverwrite });
      setResult(null); setReview(processed); setStage(3); setPage("Process Excel");
      setSuccess("Analysis completed. Review transactions before generating Excel.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Processing failed. Check the workbook and try again."); setStage(1); }
    finally { setBusy(false); }
  };

  const triggerDownload = async (kind: "download" | "report") => {
    if (!result) return;
    try {
      await downloadResult(result.file_id, kind, kind === "download" ? result.filename : `verification_${file?.name.replace(/\.xlsx$/i, "") ?? "report"}.csv`, result.review_download_id);
      setSuccess(kind === "download" ? "Updated Excel downloaded successfully." : "Verification report downloaded successfully.");
    } catch (cause) { setSuccess(""); setError(cause instanceof Error ? cause.message : "Download failed."); }
  };

  const previewColumns = useMemo<ColumnDef<Record<string, unknown>, unknown>[]>(() => [
    { accessorKey: "excel_row", header: "Excel row" },
    ...(activeSheet?.columns ?? []).map((column) => ({
      id: `col_${column.index}`, accessorFn: (row: Record<string, unknown>) => row[column.letter],
      header: `${column.letter} · ${column.header}`,
      cell: (context: CellContext<Record<string, unknown>, unknown>) => context.getValue() == null ? "" : String(context.getValue()),
    }))], [activeSheet]);
  const previewRows = useMemo(() => (activeSheet?.preview ?? []).map((row) => {
    const record: Record<string, unknown> = { excel_row: row.excel_row };
    activeSheet?.columns.forEach((column, index) => { record[column.letter] = row.values[index]; });
    return record;
  }), [activeSheet]);

  const resultColumns = useMemo<ColumnDef<ResultRow, unknown>[]>(() => [
    { accessorKey: "excel_row", header: "Excel row" },
    { accessorKey: "invoice_number", header: "Invoice number", cell: (ctx) => ctx.getValue() || "—" },
    { accessorKey: "invoice_value", header: "Invoice value" },
    { accessorKey: "taxable_value", header: "Taxable value" },
    { accessorKey: "rate", header: "Rate(%)", cell: (ctx) => ctx.getValue() == null ? "—" : `${ctx.getValue()}%` },
    { accessorKey: "difference", header: "Difference (₹)", cell: (ctx) => formatDifference(String(ctx.getValue() ?? "")) },
    { accessorKey: "status", header: "Status", cell: (ctx) => <Status status={ctx.getValue() as ResultRow["status"]} /> },
  ], []);
  const verificationColumns = useMemo<ColumnDef<ResultRow, unknown>[]>(() => [
    { accessorKey: "excel_row", header: "Excel row" },
    { accessorKey: "invoice_number", header: "Invoice number", cell: (ctx) => ctx.getValue() || "—" },
    { accessorKey: "invoice_value", header: "Invoice value" },
    { accessorKey: "taxable_value", header: "Taxable value" },
    { accessorKey: "rate", header: "Rate(%)", cell: (ctx) => ctx.getValue() == null ? "—" : `${ctx.getValue()}%` },
    { accessorKey: "difference", header: "Difference (₹)", cell: (ctx) => formatDifference(String(ctx.getValue() ?? "")) },
    { accessorKey: "status", header: "Status", cell: (ctx) => <Status status={ctx.getValue() as ResultRow["status"]} /> },
    { accessorKey: "reason", header: "Reason" },
  ], []);

  const pageText: Record<PageName, string> = {
    Dashboard: "Current processing session and operational summary.",
    "Process Excel": "Upload, map columns, calculate, and review the workbook.",
    Verification: "Review exceptions and inspect the source row references.",
    Settings: "GST calculation rules and thresholds.",
  };

  const uploadArea = <div className={`upload-zone ${dragging ? "dragging" : ""}`}
    onDragOver={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); void selectFile(event.dataTransfer.files[0]); }}>
    <div><Upload size={22} className="empty-icon" /><div className="upload-title">Drop an Excel workbook here</div>
      <button className="btn btn-small" type="button" onClick={() => inputRef.current?.click()}>Browse files</button>
      <input ref={inputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden
        onChange={(event: ChangeEvent<HTMLInputElement>) => { const selected = event.target.files?.[0]; event.target.value = ""; void selectFile(selected); }} />
    </div>
  </div>;

  const currentSheetSelect = inspection && <div className="field" style={{ maxWidth: 360, marginBottom: 14 }}>
    <label htmlFor="worksheet">Worksheet</label>
    <select id="worksheet" value={sheetName} onChange={(event) => changeSheet(event.target.value)}>
      {inspection.sheets.map((sheet) => <option key={sheet.name} value={sheet.name}>{sheet.name}</option>)}
    </select>
  </div>;

  const mappingView = activeSheet && <>
    {currentSheetSelect}
    {activeSheet.existing_rate && <div className="inline-alert" style={{ marginBottom: 12 }}>
      Rate(%) already exists in column {activeSheet.columns.find((column) => column.index === activeSheet.existing_rate?.column)?.letter ?? activeSheet.existing_rate.column}.
      <div className="toolbar" style={{ marginTop: 8 }}>
        <label><input type="radio" name="rate-action" checked={rateAction === "keep"} onChange={() => { setRateAction("keep"); setConfirmOverwrite(false); }} /> Keep existing rates</label>
        <label><input type="radio" name="rate-action" checked={rateAction === "recalculate"} onChange={() => setRateAction("recalculate")} /> Recalculate existing rates</label>
      </div>
      {rateAction === "recalculate" && <label style={{ display: "flex", gap: 7, marginTop: 8, alignItems: "center" }}>
        <input type="checkbox" checked={confirmOverwrite} onChange={(event) => setConfirmOverwrite(event.target.checked)} /> I confirm existing Rate(%) values may be overwritten.
      </label>}
    </div>}
    <div className="panel" style={{ marginBottom: 14 }}>
      <div className="panel-head"><div><h3>Column mapping</h3><p className="subtext" style={{ marginTop: 4 }}>Detected references are suggestions; confirm each source column.</p></div>
        {activeSheet.detected && <span className="status MATCHED">AUTO DETECTED</span>}</div>
      <div className="panel-body">
        <div className="mapping-row mapping-head"><span>Mapped field</span><span>Source column</span><span>Workbook header</span></div>
        <div className="mapping-row"><strong>Invoice Value</strong><span className="code-ref">{activeSheet.columns.find((column) => column.index === Number(invoiceCol))?.letter ?? "—"}</span>
          <select aria-label="Invoice Value column" {...mappingForm.register("invoiceCol", { valueAsNumber: true })}>
            {activeSheet.columns.map((column) => <option key={column.index} value={column.index}>{colLabel(column)}</option>)}
          </select></div>
        <div className="mapping-row"><strong>Taxable Value</strong><span className="code-ref">{activeSheet.columns.find((column) => column.index === Number(taxableCol))?.letter ?? "—"}</span>
          <select aria-label="Taxable Value column" {...mappingForm.register("taxableCol", { valueAsNumber: true })}>
            {activeSheet.columns.map((column) => <option key={column.index} value={column.index}>{colLabel(column)}</option>)}
          </select></div>
        <div className="mapping-row"><strong>Invoice Number <span className="subtext">(optional)</span></strong><span className="code-ref">{invoiceNumberCol ? activeSheet.columns.find((column) => column.index === invoiceNumberCol)?.letter : "—"}</span>
          <select aria-label="Invoice Number column" value={invoiceNumberCol ?? ""} onChange={(event) => setInvoiceNumberCol(event.target.value ? Number(event.target.value) : null)}>
            <option value="">Not selected</option>{activeSheet.columns.map((column) => <option key={column.index} value={column.index}>{colLabel(column)}</option>)}
          </select></div>
        {activeSheet.monetary_detection?.warnings.map(warning=><p className="inline-alert" key={warning}>{warning}</p>)}
        {(['igst','cgst','sgst','cess'] as const).map(key=><div className="mapping-row" key={key}>
          <strong>{key==='sgst'?'SGST/UTGST':key.toUpperCase()} total</strong><span className="subtext">Monetary column</span>
          <select aria-label={`${key.toUpperCase()} total column`} value={key in monetaryColumns ? monetaryColumns[key] ?? '' : activeSheet.monetary_detection?.columns[key] ?? ''}
            onChange={event=>setMonetaryColumns({...monetaryColumns,[key]:event.target.value?Number(event.target.value):null})}>
            <option value="">Unavailable / not selected</option>
            {activeSheet.columns.filter(column=>!column.is_rate).map(column=><option key={column.index} value={column.index}>{colLabel(column)}</option>)}
          </select>
        </div>)}
        <div className="form-grid" style={{ marginTop: 14 }}>
          <div className="field"><label htmlFor="first-row">First data row</label><input id="first-row" type="number" min={2} max={activeSheet.max_row} value={firstDataRow} onChange={(event) => setFirstDataRow(Number(event.target.value))} /></div>
          <div className="field"><label>Detected invoice header</label><input value={activeSheet.detected?.invoice_header_row ?? "Manual selection"} readOnly /></div>
          <div className="field"><label>Detected taxable header</label><input value={activeSheet.detected?.taxable_header_row ?? "Manual selection"} readOnly /></div>
        </div>
        {mappingForm.formState.errors.invoiceCol && <div className="inline-error" style={{ marginTop: 10 }}>{mappingForm.formState.errors.invoiceCol.message}</div>}
      </div>
    </div>
    <div className="panel"><div className="panel-head"><div><h3>Worksheet preview</h3><p className="subtext" style={{ marginTop: 4 }}>First 24 rows from the selected worksheet.</p></div><span className="code-ref">{activeSheet.max_row.toLocaleString()} rows · {activeSheet.max_column} columns</span></div>
      <div className="panel-body" style={{ paddingTop: 6 }}><DataTable rows={previewRows} columns={previewColumns} pageSize={8} emptyText="No preview rows." /></div></div>
  </>;

  const processPage = () => <>
    <div className="page-head"><div><div className="eyebrow">GST WORKSPACE</div><h1>Process Excel</h1><p className="subtext">Follow the four steps to validate and classify invoice rows.</p></div>
      {result && <div className="result-actions"><button className="btn" onClick={() => void triggerDownload("report")}><ArrowDownToLine size={14} />Download verification report</button><button className="btn btn-primary" onClick={() => void triggerDownload("download")}><ArrowDownToLine size={14} />Download updated Excel</button></div>}</div>
    <div className="workflow">{["Upload", "Column mapping", "Process", "Results"].map((label, index) => <div key={label} className={`step ${stage === index ? "active" : stage > index ? "done" : ""}`}><span className="step-index">{stage > index ? <Check size={12} /> : index + 1}</span>{label}</div>)}</div>
    {inspection?.source_info?.read_only_detected && <div role="status" className="inline-alert" style={{ marginBottom: 12 }}>Read-only source detected. Your original file will remain unchanged. The updated workbook will be generated as a separate file.</div>}
    {error && <div role="alert" className="inline-error" style={{ marginBottom: 12, display: "flex", gap: 8 }}><AlertCircle size={14} />{error}</div>}
    {success && stage === 3 && <div className="success-note" style={{ marginBottom: 12 }}>{success}</div>}
    {stage === 0 && <><TransactionReview onUpdate={setReview} onResume={()=>{setResult(null);setStage(3);}} onGenerated={setResult} /> <section className="panel"><div className="panel-head"><div><h2>Upload workbook</h2></div></div><div className="panel-body">{uploadArea}{busy && <div className="loading"><span className="spinner" />Reading workbook…</div>}{file && !busy && <div className="success-note" style={{ marginTop: 10 }}>{file.name} · {(file.size / 1024).toFixed(1)} KB</div>}</div></section></>}
    {stage === 1 && <><div className="panel" style={{ marginBottom: 12 }}><div className="panel-head"><div><h2>Review column mapping</h2><p className="subtext" style={{ marginTop: 4 }}>{file?.name} · {((file?.size ?? 0) / 1024).toLocaleString()} KB</p></div><button className="btn btn-small" onClick={() => { setStage(0); setError(""); }}><RotateCw size={13} />Change file</button></div><div className="panel-body">{mappingView}<div className="result-actions" style={{ justifyContent: "flex-end", marginTop: 14 }}><button className="btn btn-primary" onClick={() => { const validation = mappingSchema.safeParse({ invoiceCol, taxableCol }); if (!validation.success) setError(validation.error.issues[0]?.message ?? "Select valid columns."); else { setError(""); setStage(2); } }}>Continue to processing<ArrowRight size={14} /></button></div></div></div></>}
    {stage === 2 && <div className="panel"><div className="panel-head"><div><h2>Calculate GST rates</h2><p className="subtext" style={{ marginTop: 4 }}>Compare each row against supported 5%, 12%, 18%, and 28% GST rates.</p></div></div><div className="panel-body">
      <div className="mapping-row"><strong>Workbook</strong><span className="code-ref">{sheetName}</span><span>{file?.name}</span></div>
      <div className="mapping-row"><strong>Invoice Value</strong><span className="code-ref">{activeSheet?.columns.find((column) => column.index === Number(invoiceCol))?.letter} · {invoiceCol}</span><span>{firstDataRow.toLocaleString()} first data row</span></div>
      <div className="mapping-row"><strong>Taxable Value</strong><span className="code-ref">{activeSheet?.columns.find((column) => column.index === Number(taxableCol))?.letter} · {taxableCol}</span><span>{activeSheet?.existing_rate ? "Existing rate column will be reused" : `New column ${activeSheet?.columns.find((column) => column.index === Number(taxableCol) + 1)?.letter ?? "after Taxable Value"}`}</span></div>
      {activeSheet?.existing_rate && rateAction === "recalculate" && !confirmOverwrite && <div className="inline-alert" style={{ marginTop: 12 }}>Confirm overwrite in Column Mapping before recalculating existing rates.</div>}
      {busy ? <div className="loading"><span className="spinner" />Processing workbook…</div> : <div className="result-actions" style={{ marginTop: 18 }}><button className="btn" onClick={() => setStage(1)}>Back to mapping</button><button className="btn btn-primary" onClick={() => void doProcess()} disabled={!file || !activeSheet || (Boolean(activeSheet.existing_rate && rateAction === "recalculate") && !confirmOverwrite)}><BadgeCheck size={14} />Calculate GST Rates</button></div>}
    </div></div>}
    {stage === 3 && review && !result && <TransactionReview initial={review} onUpdate={setReview} onGenerated={setResult} />}
    {stage === 3 && result && <ResultsView result={result} columns={resultColumns} onDownload={() => void triggerDownload("download")} onReport={() => void triggerDownload("report")} onRowClick={(row) => { setSelectedVerification(row); navigate("Verification"); }} onNew={() => { setStage(0); setResult(null); setReview(null); setFile(null); setInspection(null); setPage("Process Excel"); setSuccess(""); }} />}
  </>;

  const dashboard = () => {
    const total = result?.summary.total ?? review?.progress.total;
    const matched = result?.summary.matched ?? review?.progress.matched;
    const requiringReview = result?.summary.review_required ?? review?.progress.requiring_review;
    const unresolved = result?.summary.unmatched ?? review?.rows.filter((row) => row.status === "UNRESOLVED").length;
    const warnings = result?.verification.length ?? review?.progress.requiring_review;
    const reviewed = result ? total : review?.progress.verified;
    const progress = total ? Math.round(((reviewed ?? 0) / total) * 100) : 0;
    const startProcessing = () => { navigate("Process Excel"); setStage(0); setSuccess(""); };
    const metricCard = (label: string, value: number | undefined, note: string, Icon: LucideIcon, tone: string, kind: string) =>
      <div className={`dashboard-kpi ${kind}`} key={label}>
        <span className="dashboard-kpi-icon" style={{ "--kpi-tone": tone } as CSSProperties}><Icon size={19} strokeWidth={2}/></span>
        <div className="dashboard-kpi-copy"><span>{label}</span><strong>{value === undefined ? "—" : value.toLocaleString()}</strong><small>{value === undefined ? "No active session" : note}</small></div>
      </div>;
    return <div className="dashboard-page">
      <section className="dashboard-hero" aria-labelledby="dashboard-welcome">
        <div className="dashboard-hero-copy"><div className="dashboard-eyebrow">WELCOME TO GST LEDGER STUDIO</div>
          <h2 id="dashboard-welcome">Your GST Workspace</h2>
          <p>Review, reconcile, and process your GST workbooks with clarity and confidence.</p>
          <button className="btn btn-primary dashboard-hero-action" onClick={startProcessing}><Upload size={17}/>Upload new Excel file<ArrowRight size={16}/></button>
        </div>
        <div className="dashboard-hero-art" aria-hidden="true"><div className="hero-sheet"><div className="hero-sheet-top"><span/><span/><span/></div><div className="hero-sheet-title">GST WORKBOOK</div><div className="hero-sheet-grid">{Array.from({length:18},(_,i)=><i key={i}/>)}</div></div><span className="hero-file-badge">XLSX</span><div className="hero-workflow-card"><span><CircleCheck/>Upload</span><span><CircleCheck/>Map columns</span><span><Activity/>Process</span><span><CircleCheck/>Review results</span></div></div>
        <div className="dashboard-hero-note"><span className="dashboard-hero-note-icon"><FileSpreadsheet size={18}/></span><span><b>Ready to get started?</b><small>Upload and analyze your GST workbook.</small></span></div>
      </section>

      <div className="dashboard-layout">
        <div className="dashboard-main-column">
          <section className="session-section" aria-labelledby="session-title">
            <div className="dashboard-section-heading"><div><h2 id="session-title">Current Session Overview</h2><p>Quick summary of your latest processing session.</p></div><span className={`session-state ${result ? "complete" : review ? "active" : "idle"}`}><span/>{result ? "Review complete" : review ? "Review in progress" : "No workbook selected"}</span></div>
            <div className="dashboard-kpi-grid">
              {metricCard("Invoices Processed",total,"Transactions analyzed",FileSpreadsheet,"#3b82f6","blue")}
              {metricCard("Exact GST Matches",matched,"Matching records",CircleCheck,"#0f9d8a","teal")}
              {metricCard("Requiring Review",requiringReview,"Needs your attention",TriangleAlert,"#f59e0b","amber")}
              {metricCard("Unmatched Records",unresolved,"No rate assigned",CircleAlert,"#ef5363","rose")}
            </div>
            <div className="dashboard-kpi-grid dashboard-secondary-kpis">
              {metricCard("Calculation Warnings",warnings,"Rows requiring a check",TriangleAlert,"#8958e8","purple")}
              <div className="dashboard-kpi progress-kpi"><span className="dashboard-kpi-icon" style={{ "--kpi-tone": "#243b53" } as CSSProperties}><Activity size={19}/></span><div className="dashboard-kpi-copy"><span>Session Progress</span><strong>{result ? "Complete" : review ? `${progress}% reviewed` : "Not started"}</strong><small>{review ? `${review.progress.verified} of ${review.progress.total} rows reviewed` : result ? `${total?.toLocaleString() ?? 0} rows processed` : "Upload an Excel workbook to begin"}</small></div><span className="progress-ring" style={{ "--progress": `${result ? 100 : progress}%` } as CSSProperties}><b>{result ? "100%" : review ? `${progress}%` : "0%"}</b></span></div>
            </div>
          </section>

          <section className="dashboard-upload-card" aria-labelledby="ready-title">
            <div className="dashboard-upload-inner"><div className="upload-illustration" aria-hidden="true"><FolderClosed size={42}/><span><Upload size={20}/></span></div>
              <h2 id="ready-title">{result ? "Your latest results are ready." : review ? "Your review is in progress." : "Your workspace is ready."}</h2>
              <p>{result ? "View your processed workbook and verification details." : review ? "Continue reviewing transactions in your current session." : "Upload an Excel workbook to create a session summary."}</p>
              {!result && !review && <small>No historical or sample metrics are shown.</small>}
              {result ? <button className="btn btn-primary" onClick={()=>navigate("Process Excel")}>View results<ArrowRight size={15}/></button> : review ? <button className="btn btn-primary" onClick={()=>navigate("Process Excel")}>Continue review<ArrowRight size={15}/></button> : <button className="btn btn-primary" onClick={startProcessing}><Upload size={15}/>Upload new Excel file</button>}
              <div className="dashboard-steps" aria-label="Workbook workflow">{[["1","Upload","Choose your Excel file"],["2","Map Columns","Confirm column mapping"],["3","Process","Analyze and validate"],["4","Review Results","Download your updated file"]].map(([number,label,description])=><div className="dashboard-step" key={number}><b>{number}</b><span><strong>{label}</strong><small>{description}</small></span></div>)}</div>
            </div>
          </section>
        </div>

        <aside className="dashboard-aside">
          <section className="dashboard-side-card"><div className="dashboard-side-title"><span className="side-title-icon purple"><ArrowRight size={19}/></span><h2>Quick Actions</h2></div>
            <button className="quick-action" onClick={startProcessing}><span className="quick-action-icon purple"><Upload size={18}/></span><span><b>Upload new Excel file</b><small>Upload and analyze a workbook</small></span><ChevronRight size={17}/></button>
            <Link className="quick-action" href="/my-files"><span className="quick-action-icon blue"><FolderClosed size={18}/></span><span><b>View My Files</b><small>Access your generated workbooks</small></span><ChevronRight size={17}/></Link>
            <button className="quick-action" onClick={()=>navigate("Verification")}><span className="quick-action-icon teal"><FileCheck2 size={18}/></span><span><b>Verification</b><small>Review flagged transactions</small></span><ChevronRight size={17}/></button>
            <button className="quick-action" onClick={()=>navigate("Settings")}><span className="quick-action-icon purple"><Settings2 size={18}/></span><span><b>Settings</b><small>View calculation policy</small></span><ChevronRight size={17}/></button>
          </section>
          <section className="dashboard-side-card tips-card"><div className="dashboard-side-title"><span className="side-title-icon amber"><Lightbulb size={19}/></span><h2>Helpful Tips</h2></div>
            <Tip icon={<FileSpreadsheet size={15}/>} title="Prepare your Excel file" text="Include invoice, taxable value, and GST columns." tone="purple"/>
            <Tip icon={<FileCheck2 size={15}/>} title="Map columns carefully" text="Confirm detected column mappings before processing." tone="teal"/>
            <Tip icon={<TriangleAlert size={15}/>} title="Review flagged records" text="Check and assign the correct GST rate to unresolved rows." tone="purple"/>
            <Tip icon={<ArrowDownToLine size={15}/>} title="Download your results" text="Save the updated workbook and verification report." tone="amber"/>
          </section>
        </aside>
      </div>
    </div>;
  };

  const verification = () => <>
    <div className="page-head"><div><div className="eyebrow">EXCEPTION REVIEW</div><h1>Verification</h1><p className="subtext">Review flagged rows and check the original workbook references.</p></div><span className="status REVIEW_REQUIRED">{result?.verification.length ?? 0} FLAGGED</span></div>
    {review ? <TransactionReview initial={review} onUpdate={setReview} onGenerated={setResult} /> : !result ? <div className="empty-state"><CircleHelp size={22} className="empty-icon" /><h2>No verification session</h2><p className="subtext" style={{ margin: "6px 0 14px" }}>Process a workbook to see flagged rows here.</p><button className="btn btn-primary" onClick={() => navigate("Process Excel")}>Open processing workspace</button></div> : <div className="detail-layout"><section className="panel"><div className="panel-head"><div><h2>Flagged workbook rows</h2><p className="subtext" style={{ marginTop: 4 }}>Select a row to inspect rate comparison details.</p></div></div><div className="panel-body" style={{ paddingTop: 5 }}><DataTable rows={result.verification} columns={verificationColumns} statusFilter onRowClick={setSelectedVerification} emptyText="No verification warnings." /></div></section>
      {selectedVerification && <aside className="panel detail-panel"><div className="panel-head"><div><h2>Row {selectedVerification.excel_row} details</h2><p className="subtext" style={{ marginTop: 4 }}>{selectedVerification.invoice_number || "Invoice number unavailable"}</p></div><button className="btn btn-small" aria-label="Close row details" onClick={() => setSelectedVerification(null)}><X size={13} /></button></div><div className="panel-body"><div style={{ marginBottom: 12 }}><Status status={selectedVerification.status} /></div><div className="detail-list">
        <Detail label="Worksheet" value={result.worksheet} /><Detail label="Actual Excel row" value={String(selectedVerification.excel_row)} />
        <Detail label="Invoice Value" value={formatDifference(selectedVerification.invoice_value)} />
        <Detail label="Taxable Value" value={formatDifference(selectedVerification.taxable_value)} />
        <Detail label="Invoice Value column" value={`${selectedVerification.invoice_header} · ${selectedVerification.invoice_letter} (column ${selectedVerification.invoice_column})`} />
        <Detail label="Taxable Value column" value={`${selectedVerification.taxable_header} · ${selectedVerification.taxable_letter} (column ${selectedVerification.taxable_column})`} />
        <Detail label="Rate(%) column" value={`${selectedVerification.rate_letter} (column ${selectedVerification.rate_column})`} />
        <Detail label="Expected taxable at 5%" value={selectedVerification.expected_5 || "Unavailable"} />
        <Detail label="Difference at 5%" value={formatDifference(selectedVerification.difference_5)} />
        <Detail label="Expected taxable at 12%" value={selectedVerification.expected_12 || "Unavailable"} />
        <Detail label="Difference at 12%" value={formatDifference(selectedVerification.difference_12)} />
        <Detail label="Expected taxable at 18%" value={selectedVerification.expected_18 || "Unavailable"} />
        <Detail label="Difference at 18%" value={formatDifference(selectedVerification.difference_18)} />
        <Detail label="Expected taxable at 28%" value={selectedVerification.expected_28 || "Unavailable"} />
        <Detail label="Difference at 28%" value={formatDifference(selectedVerification.difference_28)} />
        <Detail label="Assigned rate" value={selectedVerification.rate == null ? "Unmatched" : `${selectedVerification.rate}%`} />
        <Detail label="Explanation" value={selectedVerification.reason || "Closest supported rate is within the automatic match tolerance."} />
      </div><div className="inline-alert" style={{ marginTop: 13 }}>Once again verify the following row.</div></div></aside>}
    </div>}
  </>;

  const settings = () => <><div className="page-head"><div><div className="eyebrow">CALCULATION POLICY</div><h1>Settings</h1><p className="subtext">GST calculation rules for your review.</p></div><ShieldCheck size={18} color="#24744c" /></div><section className="panel"><div className="panel-head"><h2>Calculation policy</h2></div><div className="panel-body"><Setting label="Supported GST rates" value="5%, 12%, 18%, and 28%" /><Setting label="Automatic match tolerance" value="Less than ₹1" /><Setting label="Verification threshold" value="₹1 to less than ₹50" /><Setting label="Unmatched threshold" value="₹50 or greater" /></div></section></>;


  const view=page === "Dashboard" ? dashboard() : page === "Process Excel" ? processPage() : page === "Verification" ? verification() : settings();
  return <WorkspaceShell active={page} subtitle={pageText[page]} accountActions={accountActions} headerExtra={<span className="file-chip" title={file?.name}>{file?.name ?? "No workbook selected"}</span>} onNavigate={next=>{if(next!=='My Files')navigate(next);}}>{view}</WorkspaceShell>;
}

function Detail({ label, value }: { label: string; value: string }) { return <div className="detail-item"><div className="detail-label">{label}</div><div className="detail-value">{value}</div></div>; }
function Setting({ label, value }: { label: string; value: string }) { return <div className="setting-row"><span>{label}</span><span className="setting-value">{value}</span></div>; }

function Tip({icon,title,text,tone}:{icon:ReactNode;title:string;text:string;tone:"purple"|"teal"|"amber"}) {
  return <div className="dashboard-tip"><span className={`quick-action-icon ${tone}`}>{icon}</span><span><b>{title}</b><small>{text}</small></span></div>;
}

function SummaryMetrics({ summary }: { summary: ProcessResponse["summary"] }) {
  return <div className="metric-grid">
    {metric("Invoices processed", summary.total, "Rows with source values")}
    {metric("Exact GST matches", summary.matched, "Below ₹1 difference", "#24744c")}
    {supportedRates.map((rate) => metric(`${rate}% GST records`, rateCount(summary, rate), "Assigned rate"))}
    {metric(summary.review_complete ? "Reviewed calculation warnings" : "Verification required", summary.review_required, "Calculation checks", "#946200")}
    {metric("Unmatched records", summary.unmatched, "No rate assigned", "#9c3434")}
  </div>;
}
function formatTotalCurrency(value: string): string {
  const negative = value.startsWith('-');
  const [whole, cents = '00'] = value.replace(/^-/, '').split('.');
  return `${negative ? '-' : ''}\u20b9${new Intl.NumberFormat('en-IN').format(BigInt(whole))}.${cents}`;
}
function ResultsView({ result, columns, onDownload, onReport, onRowClick, onNew }: {
  result: ProcessResponse; columns: ColumnDef<ResultRow, unknown>[]; onDownload: () => void;
  onReport: () => void; onRowClick: (row: ResultRow) => void; onNew: () => void;
}) {
  const summary = result.summary;
  return <>{result.history && <div className={result.history.saved?'success-note':'inline-alert'} role="status" style={{marginBottom:16}}>
    {result.history.saved?<><Link href="/my-files">Saved to My Files</Link>. Available until {new Date(result.history.expires_at!).toLocaleDateString()}.</>:result.history.warning}
    </div>}<SummaryMetrics summary={summary} />
    {result.column_totals && <section className="panel" style={{marginBottom:20}}>
      <div className="panel-head"><div><h2>GST Column Totals</h2><p className="subtext">{result.column_totals.worksheet} | {result.column_totals.included_rows.length} transaction rows</p></div></div>
      <div className="panel-body"><div className="metric-grid">{Object.entries(result.column_totals.columns).filter(([key,item])=>key!=='cess'||item.source_column!==null).map(([key,item])=><div className="metric" key={key}>
        <div className="metric-label">Total {item.label}</div><div className="metric-value" style={{fontSize:22}}>{item.total===null?'Unavailable':formatTotalCurrency(item.total)}</div>
        <small>{item.blank_count} blank | {item.invalid_count} invalid</small>
      </div>)}</div>
      {result.summary.review_complete&&result.summary.rate_counts&&<details><summary>Verified output rate counts</summary><ul>{Object.entries(result.summary.rate_counts).filter(([,count])=>count>0).map(([rate,count])=><li key={rate}>{rate}%: {count} output rows</li>)}</ul></details>}
      {result.column_totals.warnings.map(warning=><p className="inline-alert" role="status" key={warning}>{warning}</p>)}
      {result.column_totals.issues.length>0 && <details><summary>Review excluded monetary cells ({result.column_totals.issues.length})</summary><ul>{result.column_totals.issues.map(issue=><li key={`${issue.row}-${issue.field}`}>Row {issue.row}, {issue.field.toUpperCase()}, column {issue.column}: {issue.message}</li>)}</ul></details>}
      {result.column_totals.output && <p className="subtext">Workbook totals: {result.column_totals.output.worksheet}{result.column_totals.output.row?`, row ${result.column_totals.output.row}`:''}.</p>}
      </div></section>}

    <section className="panel"><div className="panel-head"><div><h2>Processed rows</h2><p className="subtext" style={{ marginTop: 4 }}>{result.filename} · {result.worksheet}</p></div><div className="result-actions"><button className="btn btn-small" onClick={onNew}><Upload size={13} />Process another</button><button className="btn btn-small btn-primary" onClick={onDownload}><ArrowDownToLine size={13} />Download Updated Excel</button><button className="btn btn-small" onClick={onReport}><ArrowDownToLine size={13} />Verification report</button></div></div><div className="panel-body" style={{ paddingTop: 5 }}><DataTable rows={result.rows} columns={columns} statusFilter onRowClick={onRowClick} emptyText="No invoice rows found." /></div></section>
  </>;
}
