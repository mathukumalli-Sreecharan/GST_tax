"use client";

import { ChangeEvent, DragEvent, useMemo, useRef, useState } from "react";
import { CellContext, ColumnDef } from "@tanstack/react-table";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  AlertCircle, ArrowDownToLine, ArrowRight, BadgeCheck, BarChart3, Check, ChevronRight,
  CircleHelp, FileSpreadsheet, FileWarning, Gauge, Menu, RotateCw, Settings2,
  ShieldCheck, Upload, X,
} from "lucide-react";
import { DataTable } from "@/components/DataTable";
import { downloadResult, inspectWorkbook, processWorkbook } from "@/lib/api";
import type { ColumnMeta, InspectResponse, ProcessResponse, ResultRow, SheetInfo } from "@/lib/types";

type PageName = "Dashboard" | "Process Excel" | "Verification" | "Settings";
const pages: { name: PageName; icon: typeof Gauge }[] = [
  { name: "Dashboard", icon: Gauge }, { name: "Process Excel", icon: FileSpreadsheet },
  { name: "Verification", icon: FileWarning }, { name: "Settings", icon: Settings2 },
];
const mappingSchema = z.object({ invoiceCol: z.number().int().positive(), taxableCol: z.number().int().positive() })
  .refine((value) => value.invoiceCol !== value.taxableCol, { message: "Invoice Value and Taxable Value must use different columns." });
type MappingValues = z.infer<typeof mappingSchema>;
const sizeLimit = 20 * 1024 * 1024;

function Status({ status }: { status: ResultRow["status"] }) {
  return <span className={`status ${status.replaceAll(" ", "_")}`}>{status}</span>;
}
function metric(label: string, value: number, note: string, tone = "") {
  return <div className="metric" key={label}><div className="metric-label">{label}</div><div className="metric-value" style={tone ? { color: tone } : undefined}>{value.toLocaleString()}</div><div className="metric-note">{note}</div></div>;
}
function colLabel(column: ColumnMeta) { return `${column.letter} · ${column.header}`; }

export default function Home() {
  const [page, setPage] = useState<PageName>("Dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [inspection, setInspection] = useState<InspectResponse | null>(null);
  const [sheetName, setSheetName] = useState("");
  const [invoiceNumberCol, setInvoiceNumberCol] = useState<number | null>(null);
  const [firstDataRow, setFirstDataRow] = useState(2);
  const [stage, setStage] = useState(0);
  const [result, setResult] = useState<ProcessResponse | null>(null);
  const [recentFile, setRecentFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [rateAction, setRateAction] = useState<"keep" | "recalculate">("keep");
  const [confirmOverwrite, setConfirmOverwrite] = useState(false);
  const [selectedVerification, setSelectedVerification] = useState<ResultRow | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const activeSheet: SheetInfo | undefined = inspection?.sheets.find((sheet) => sheet.name === sheetName);
  const mappingForm = useForm<MappingValues>({ resolver: zodResolver(mappingSchema), defaultValues: { invoiceCol: 1, taxableCol: 2 } });
  const invoiceCol = mappingForm.watch("invoiceCol");
  const taxableCol = mappingForm.watch("taxableCol");

  const navigate = (next: PageName) => { setPage(next); setSidebarOpen(false); setError(""); setSuccess(""); };

  const selectFile = async (newFile: File | undefined) => {
    if (!newFile) return;
    setError(""); setSuccess(""); setInspection(null); setResult(null); setStage(0); setFile(newFile);
    if (!newFile.name.toLowerCase().endsWith(".xlsx")) { setError("Choose an .xlsx workbook. Other formats are not supported."); return; }
    if (newFile.size > sizeLimit) { setError("The workbook is larger than the 20 MB local processing limit."); return; }
    setBusy(true);
    try {
      const inspected = await inspectWorkbook(newFile);
      setInspection(inspected);
      const initial = inspected.sheets[0];
      if (initial) {
        setSheetName(initial.name);
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
        invoiceCol, taxableCol, invoiceNumberCol,
        invoiceHeaderRow: activeSheet.detected?.invoice_header_row ?? firstDataRow - 1,
        taxableHeaderRow: activeSheet.detected?.taxable_header_row ?? firstDataRow - 1,
        recalculateExisting: Boolean(activeSheet.existing_rate && rateAction === "recalculate"),
        confirmOverwrite });
      setResult(processed); setRecentFile(file.name); setStage(3); setPage("Process Excel");
      setSuccess("GST rate calculation completed. Review flagged rows before filing.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Processing failed. Check the workbook and try again."); setStage(1); }
    finally { setBusy(false); }
  };

  const triggerDownload = async (kind: "download" | "report") => {
    if (!result) return;
    try {
      await downloadResult(result.file_id, kind, kind === "download" ? result.filename : `verification_${file?.name.replace(/\.xlsx$/i, "") ?? "report"}.csv`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Download failed."); }
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
    { accessorKey: "difference", header: "Difference (₹)", cell: (ctx) => ctx.getValue() || "—" },
    { accessorKey: "status", header: "Status", cell: (ctx) => <Status status={ctx.getValue() as ResultRow["status"]} /> },
  ], []);
  const verificationColumns = useMemo<ColumnDef<ResultRow, unknown>[]>(() => [
    { accessorKey: "excel_row", header: "Excel row" },
    { accessorKey: "invoice_number", header: "Invoice number", cell: (ctx) => ctx.getValue() || "—" },
    { accessorKey: "invoice_value", header: "Invoice value" },
    { accessorKey: "taxable_value", header: "Taxable value" },
    { accessorKey: "rate", header: "Rate(%)", cell: (ctx) => ctx.getValue() == null ? "—" : `${ctx.getValue()}%` },
    { accessorKey: "difference", header: "Difference (₹)", cell: (ctx) => ctx.getValue() || "—" },
    { accessorKey: "status", header: "Status", cell: (ctx) => <Status status={ctx.getValue() as ResultRow["status"]} /> },
    { accessorKey: "reason", header: "Reason" },
  ], []);

  const pageText: Record<PageName, string> = {
    Dashboard: "Current local processing session and operational summary.",
    "Process Excel": "Upload, map columns, calculate, and review the workbook.",
    Verification: "Review exceptions and inspect the source row references.",
    Settings: "Read-only calculation and workbook handling policies.",
  };

  const uploadArea = <div className={`upload-zone ${dragging ? "dragging" : ""}`}
    onDragOver={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={(event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); void selectFile(event.dataTransfer.files[0]); }}>
    <div><Upload size={22} className="empty-icon" /><div className="upload-title">Drop an Excel workbook here</div>
      <div className="upload-meta">.xlsx only · processed locally · maximum 20 MB</div>
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
    {error && <div role="alert" className="inline-error" style={{ marginBottom: 12, display: "flex", gap: 8 }}><AlertCircle size={14} />{error}</div>}
    {success && stage === 3 && <div className="success-note" style={{ marginBottom: 12 }}>{success}</div>}
    {stage === 0 && <section className="panel"><div className="panel-head"><div><h2>Upload workbook</h2><p className="subtext" style={{ marginTop: 4 }}>Excel files are inspected and processed on this computer.</p></div></div><div className="panel-body">{uploadArea}{busy && <div className="loading"><span className="spinner" />Reading worksheet metadata…</div>}{file && !busy && <div className="success-note" style={{ marginTop: 10 }}>{file.name} · {(file.size / 1024).toFixed(1)} KB</div>}</div></section>}
    {stage === 1 && <><div className="panel" style={{ marginBottom: 12 }}><div className="panel-head"><div><h2>Review column mapping</h2><p className="subtext" style={{ marginTop: 4 }}>{file?.name} · {((file?.size ?? 0) / 1024).toLocaleString()} KB</p></div><button className="btn btn-small" onClick={() => { setStage(0); setError(""); }}><RotateCw size={13} />Change file</button></div><div className="panel-body">{mappingView}<div className="result-actions" style={{ justifyContent: "flex-end", marginTop: 14 }}><button className="btn btn-primary" onClick={() => { const validation = mappingSchema.safeParse({ invoiceCol, taxableCol }); if (!validation.success) setError(validation.error.issues[0]?.message ?? "Select valid columns."); else { setError(""); setStage(2); } }}>Continue to processing<ArrowRight size={14} /></button></div></div></div></>}
    {stage === 2 && <div className="panel"><div className="panel-head"><div><h2>Calculate GST rates</h2><p className="subtext" style={{ marginTop: 4 }}>Compare each row against supported 5%, 12%, 18%, and 28% GST rates.</p></div></div><div className="panel-body">
      <div className="mapping-row"><strong>Workbook</strong><span className="code-ref">{sheetName}</span><span>{file?.name}</span></div>
      <div className="mapping-row"><strong>Invoice Value</strong><span className="code-ref">{activeSheet?.columns.find((column) => column.index === Number(invoiceCol))?.letter} · {invoiceCol}</span><span>{firstDataRow.toLocaleString()} first data row</span></div>
      <div className="mapping-row"><strong>Taxable Value</strong><span className="code-ref">{activeSheet?.columns.find((column) => column.index === Number(taxableCol))?.letter} · {taxableCol}</span><span>{activeSheet?.existing_rate ? "Existing rate column will be reused" : `New column ${activeSheet?.columns.find((column) => column.index === Number(taxableCol) + 1)?.letter ?? "after Taxable Value"}`}</span></div>
      {activeSheet?.existing_rate && rateAction === "recalculate" && !confirmOverwrite && <div className="inline-alert" style={{ marginTop: 12 }}>Confirm overwrite in Column Mapping before recalculating existing rates.</div>}
      {busy ? <div className="loading"><span className="spinner" />Processing workbook locally…</div> : <div className="result-actions" style={{ marginTop: 18 }}><button className="btn" onClick={() => setStage(1)}>Back to mapping</button><button className="btn btn-primary" onClick={() => void doProcess()} disabled={!file || !activeSheet || (Boolean(activeSheet.existing_rate && rateAction === "recalculate") && !confirmOverwrite)}><BadgeCheck size={14} />Calculate GST Rates</button></div>}
    </div></div>}
    {stage === 3 && result && <ResultsView result={result} columns={resultColumns} onDownload={() => void triggerDownload("download")} onReport={() => void triggerDownload("report")} onRowClick={(row) => { setSelectedVerification(row); navigate("Verification"); }} onNew={() => { setStage(0); setFile(null); setInspection(null); setPage("Process Excel"); setSuccess(""); }} />}
  </>;

  const dashboard = () => <>
    <div className="page-head"><div><div className="eyebrow">GST LEDGER STUDIO / LOCAL SESSION</div><h1>Dashboard</h1><p className="subtext">Current processing session and review workload.</p></div><button className="btn btn-primary" onClick={() => { navigate("Process Excel"); setStage(0); setSuccess(""); }}><FileSpreadsheet size={14} />Process New Excel</button></div>
    {result ? <><div className="metric-grid">{metric("Invoices processed", result.summary.total, "Rows with source values")}{metric("Exact GST matches", result.summary.matched, "Below ₹1 difference", "#24744c")}{metric("5% GST records", result.summary.five_percent, "Assigned rate")}{metric("12% GST records", result.summary.twelve_percent, "Assigned rate")}{metric("18% GST records", result.summary.eighteen_percent, "Assigned rate")}{metric("28% GST records", result.summary.twenty_eight_percent, "Assigned rate")}{metric("Verification required", result.summary.review_required, "Review flagged records", "#946200")}{metric("Unmatched records", result.summary.unmatched, "No rate assigned", "#9c3434")}</div>
      <div className="dashboard-grid"><section className="panel"><div className="panel-head"><div><h2>Recent processing summary</h2><p className="subtext" style={{ marginTop: 4 }}>Current browser session only.</p></div><span className="status MATCHED">COMPLETED</span></div><table className="summary-table"><tbody><tr><th>Workbook</th><td>{recentFile || result.filename}</td></tr><tr><th>Worksheet</th><td>{result.worksheet}</td></tr><tr><th>Invoices</th><td>{result.summary.total.toLocaleString()}</td></tr><tr><th>Verification warnings</th><td>{result.verification.length.toLocaleString()}</td></tr></tbody></table><div style={{ padding: 14 }}><button className="btn btn-small" onClick={() => navigate("Process Excel")}>View results<ChevronRight size={13} /></button></div></section>
        <section className="panel"><div className="panel-head"><h2>Review queue</h2><FileWarning size={15} color="#946200" /></div><div className="panel-body"><div style={{ fontSize: 27, fontWeight: 650 }}>{result.verification.length.toLocaleString()}</div><p className="subtext" style={{ margin: "4px 0 14px" }}>Rows requiring verification</p><button className="btn btn-small" onClick={() => navigate("Verification")}>Open verification<ArrowRight size={13} /></button></div></section></div>
    </> : <div className="empty-state" style={{ marginTop: 20 }}><FileSpreadsheet size={24} className="empty-icon" /><h2>No processing session yet</h2><p className="subtext" style={{ margin: "6px 0 15px" }}>Upload an Excel workbook to create a session summary. No historical or sample metrics are shown.</p><button className="btn btn-primary" onClick={() => navigate("Process Excel")}><Upload size={14} />Process New Excel</button></div>}
  </>;

  const verification = () => <>
    <div className="page-head"><div><div className="eyebrow">EXCEPTION REVIEW</div><h1>Verification</h1><p className="subtext">Review flagged rows and check the original workbook references.</p></div><span className="status REVIEW_REQUIRED">{result?.verification.length ?? 0} FLAGGED</span></div>
    {!result ? <div className="empty-state"><CircleHelp size={22} className="empty-icon" /><h2>No verification session</h2><p className="subtext" style={{ margin: "6px 0 14px" }}>Process a workbook to see flagged rows here.</p><button className="btn btn-primary" onClick={() => navigate("Process Excel")}>Open processing workspace</button></div> : <div className="detail-layout"><section className="panel"><div className="panel-head"><div><h2>Flagged workbook rows</h2><p className="subtext" style={{ marginTop: 4 }}>Select a row to inspect rate comparison details.</p></div></div><div className="panel-body" style={{ paddingTop: 5 }}><DataTable rows={result.verification} columns={verificationColumns} statusFilter onRowClick={setSelectedVerification} emptyText="No verification warnings." /></div></section>
      {selectedVerification && <aside className="panel detail-panel"><div className="panel-head"><div><h2>Row {selectedVerification.excel_row} details</h2><p className="subtext" style={{ marginTop: 4 }}>{selectedVerification.invoice_number || "Invoice number unavailable"}</p></div><button className="btn btn-small" aria-label="Close row details" onClick={() => setSelectedVerification(null)}><X size={13} /></button></div><div className="panel-body"><div style={{ marginBottom: 12 }}><Status status={selectedVerification.status} /></div><div className="detail-list">
        <Detail label="Worksheet" value={result.worksheet} /><Detail label="Actual Excel row" value={String(selectedVerification.excel_row)} />
        <Detail label="Invoice Value column" value={`${selectedVerification.invoice_header} · ${selectedVerification.invoice_letter} (column ${selectedVerification.invoice_column})`} />
        <Detail label="Taxable Value column" value={`${selectedVerification.taxable_header} · ${selectedVerification.taxable_letter} (column ${selectedVerification.taxable_column})`} />
        <Detail label="Rate(%) column" value={`${selectedVerification.rate_letter} (column ${selectedVerification.rate_column})`} />
        <Detail label="Expected taxable at 5%" value={selectedVerification.expected_5 || "Unavailable"} />
        <Detail label="Difference at 5%" value={selectedVerification.difference_5 || "Unavailable"} />
        <Detail label="Expected taxable at 12%" value={selectedVerification.expected_12 || "Unavailable"} />
        <Detail label="Difference at 12%" value={selectedVerification.difference_12 || "Unavailable"} />
        <Detail label="Expected taxable at 18%" value={selectedVerification.expected_18 || "Unavailable"} />
        <Detail label="Difference at 18%" value={selectedVerification.difference_18 || "Unavailable"} />
        <Detail label="Expected taxable at 28%" value={selectedVerification.expected_28 || "Unavailable"} />
        <Detail label="Difference at 28%" value={selectedVerification.difference_28 || "Unavailable"} />
        <Detail label="Assigned rate" value={selectedVerification.rate == null ? "Unmatched" : `${selectedVerification.rate}%`} />
        <Detail label="Explanation" value={selectedVerification.reason || "Closest supported rate is within the automatic match tolerance."} />
      </div><div className="inline-alert" style={{ marginTop: 13 }}>Once again verify the following row.</div></div></aside>}
    </div>}
  </>;

  const settings = () => <><div className="page-head"><div><div className="eyebrow">APPLICATION POLICY</div><h1>Settings</h1><p className="subtext">Validated calculation settings are read-only.</p></div><ShieldCheck size={18} color="#24744c" /></div><div className="settings-grid"><section className="panel"><div className="panel-head"><h2>Calculation policy</h2></div><div className="panel-body"><Setting label="Supported GST rates" value="5%, 12%, 18%, and 28%" /><Setting label="Automatic match tolerance" value="Less than ₹1" /><Setting label="Verification threshold" value="₹1 to less than ₹50" /><Setting label="Unmatched threshold" value="₹50 or greater" /><Setting label="Arithmetic" value="Decimal based (existing behavior)" /></div></section><section className="panel"><div className="panel-head"><h2>Workbook preservation</h2></div><div className="panel-body"><Setting label="Supported input format" value=".xlsx" /><Setting label="Processing mode" value="Local OpenPyXL" /><Setting label="Output structure" value="Rate(%) after Taxable Value" /><Setting label="Verification output" value="Separate CSV report" /><Setting label="Upload limit" value="20 MB" /><p className="subtext" style={{ marginTop: 12 }}>Workbooks containing unsupported features or formulas that cannot be safely updated are rejected with an explanation. Files are processed locally and are not sent to a hosted service.</p></div></section></div></>;

  return <div className="shell">
    <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}><div className="brand"><span className="brand-mark"><BarChart3 size={16} /></span><span>GST Ledger Studio</span></div><div className="nav-label">Workspace</div><nav className="nav-list" aria-label="Main navigation">{pages.map(({ name, icon: Icon }) => <button key={name} className={`nav-item ${page === name ? "active" : ""}`} onClick={() => navigate(name)}><Icon size={15} strokeWidth={1.8} />{name}</button>)}</nav><div className="local-note"><span className="local-dot" />Local processing enabled</div></aside>
    <main className="main"><header className="topbar"><div style={{ display: "flex", alignItems: "center", gap: 10 }}><button className="btn btn-small mobile-menu" aria-label="Open navigation" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={15} /></button><div><div className="top-title">{page}</div><div className="top-subtitle">{pageText[page]}</div></div></div><div className="top-right"><span className="local-pill"><span className="local-dot" />Local processing</span><span className="file-chip" title={file?.name}>{file?.name ?? "No workbook selected"}</span></div></header>
      <div className="content">{page === "Dashboard" && dashboard()}{page === "Process Excel" && processPage()}{page === "Verification" && verification()}{page === "Settings" && settings()}</div>
    </main>
  </div>;
}

function Detail({ label, value }: { label: string; value: string }) { return <div className="detail-item"><div className="detail-label">{label}</div><div className="detail-value">{value}</div></div>; }
function Setting({ label, value }: { label: string; value: string }) { return <div className="setting-row"><span>{label}</span><span className="setting-value">{value}</span></div>; }

function ResultsView({ result, columns, onDownload, onReport, onRowClick, onNew }: {
  result: ProcessResponse; columns: ColumnDef<ResultRow, unknown>[]; onDownload: () => void;
  onReport: () => void; onRowClick: (row: ResultRow) => void; onNew: () => void;
}) {
  const summary = result.summary;
  return <><div className="metric-grid">{metric("Invoices processed", summary.total, "Rows with source values")}{metric("Exact GST matches", summary.matched, "Below ₹1 difference", "#24744c")}{metric("5% GST records", summary.five_percent, "Assigned rate")}{metric("12% GST records", summary.twelve_percent, "Assigned rate")}{metric("18% GST records", summary.eighteen_percent, "Assigned rate")}{metric("28% GST records", summary.twenty_eight_percent, "Assigned rate")}{metric("Verification required", summary.review_required, "Review flagged records", "#946200")}{metric("Unmatched records", summary.unmatched, "No rate assigned", "#9c3434")}</div>
    <section className="panel"><div className="panel-head"><div><h2>Processed rows</h2><p className="subtext" style={{ marginTop: 4 }}>{result.filename} · {result.worksheet}</p></div><div className="result-actions"><button className="btn btn-small" onClick={onNew}><Upload size={13} />Process another</button><button className="btn btn-small" onClick={onReport}><ArrowDownToLine size={13} />Verification report</button><button className="btn btn-small btn-primary" onClick={onDownload}><ArrowDownToLine size={13} />Updated Excel</button></div></div><div className="panel-body" style={{ paddingTop: 5 }}><DataTable rows={result.rows} columns={columns} statusFilter onRowClick={onRowClick} emptyText="No invoice rows found." /></div></section>
  </>;
}
