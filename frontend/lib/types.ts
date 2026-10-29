export type ColumnMeta = {
  index: number;
  letter: string;
  header: string;
  is_invoice_value: boolean;
  is_taxable_value: boolean;
  is_rate: boolean;
  is_invoice_number: boolean;
};

export type SheetInfo = {
  name: string;
  max_row: number;
  max_column: number;
  detected: { invoice_col: number; invoice_header_row: number; taxable_col: number; taxable_header_row: number } | null;
  existing_rate: { column: number; header_row: number } | null;
  invoice_number: { column: number; header_row: number } | null;
  monetary_detection?: {columns: Record<string, number | null>; candidates: Record<string, number[]>; warnings: string[]};
  columns: ColumnMeta[];
  preview: { excel_row: number; values: unknown[] }[];
};

export type InspectResponse = { filename: string; size_bytes: number; sheets: SheetInfo[]; max_upload_bytes: number;
  source_info?: { windows_read_only: boolean | null; read_only_recommended: boolean; read_only_detected: boolean };
  protection?: { workbook_structure: boolean; workbook_windows: boolean; protected_worksheets: string[] };
};

export type ResultRow = {
  excel_row: number;
  invoice_number: string;
  invoice_value: string;
  taxable_value: string;
  rate: number | string | null;
  difference: string;
  difference_5: string;
  difference_12: string;
  difference_18: string;
  difference_28: string;
  expected_5: string;
  expected_12: string;
  expected_18: string;
  expected_28: string;
  status: "MATCHED" | "REVIEW REQUIRED" | "UNMATCHED" | "INVALID" | "AMBIGUOUS";
  reason: string;
  invoice_column: number;
  invoice_letter: string;
  invoice_header: string;
  taxable_column: number;
  taxable_letter: string;
  taxable_header: string;
  rate_column: number;
  rate_letter: string;
};

export type ColumnTotals = {
  worksheet: string;
  columns: Record<string, {label: string; source_column: number | null; total: string | null; unrounded_total?:string|null; rounding_adjustment?:string|null; original_total?:string|null; verified_adjustment?:string|null; blank_count: number; invalid_count: number}>;
  included_rows: number[];
  excluded_rows: {row: number; reason: string}[];
  issues: {row: number; field: string; column: number; message: string}[];
  warnings: string[];
  output: {worksheet: string; mode: string; row?: number} | null;
};

export type ProcessResponse = {
  review_progress?: {total:number;matched:number;requiring_review:number;verified:number;remaining:number};
  column_totals?: ColumnTotals;
  history?: {saved: boolean; id?: string; expires_at?: string; warning?: string};
  file_id: string;
  review_download_id?: string;
  filename: string;
  worksheet: string;
  summary: {
    total: number;
    matched: number;
    five_percent?: number;
    twelve_percent?: number;
    eighteen_percent?: number;
    twenty_eight_percent?: number;
    zero_percent?: number;
    rate_counts?: Record<string, number>;
    review_complete?: boolean;
    review_required: number;
    unmatched: number;
    status_counts: Record<string, number>;
  };
  rows: ResultRow[];
  verification: ResultRow[];
  rate_column: { letter: string; index: number };
};
export type ReviewRow = {
 excel_row:number; supplier_gstin:string; supplier_name:string; invoice_number:string; invoice_date:string;
 invoice_value:string; taxable_value:string; igst:string; cgst:string; sgst:string; cess:string;
 rate:number|string|null; inferred_rate:number|null; status:'MATCHED'|'REVIEW_REQUIRED'|'UNRESOLVED'; reason:string;
};
export type SplitRow = {rate:string;invoice:string;taxable:string;igst:string;cgst:string;sgst:string;cess:string};
export type SplitPreview = {preview_id:string;manual_required:boolean;reason?:string;method?:string;tax_mode?:string;rows?:SplitRow[];rounding?:string;taxable_allocations:string[]|null;cess_allocations?:string[]|null;calculated_taxable?:string[];requested_mode:string|null};
export type ReviewSession = {
 generation_blockers?:string[];
 review_id:string;filename:string;worksheet:string;version:number;lease_until?:number|null;state:'open'|'generating'|'generated';expires_at:number;
 rows:ReviewRow[];excluded_rows:{row:number;reason:string}[];
 decisions:Record<string,{choice:'CORRECT'|'WRONG';rates:string[];saved_at:number;split_preview?:SplitPreview;split_confirmed?:boolean}>;
 progress:{total:number;matched:number;requiring_review:number;verified:number;remaining:number};
 result:ProcessResponse|null;
};
