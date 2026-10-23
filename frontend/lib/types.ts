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
  rate: number | null;
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
  columns: Record<string, {label: string; source_column: number | null; total: string | null; blank_count: number; invalid_count: number}>;
  included_rows: number[];
  excluded_rows: {row: number; reason: string}[];
  issues: {row: number; field: string; column: number; message: string}[];
  warnings: string[];
  output: {worksheet: string; mode: string; row?: number} | null;
};

export type ProcessResponse = {
  column_totals?: ColumnTotals;
  history?: {saved: boolean; id?: string; expires_at?: string; warning?: string};
  file_id: string;
  filename: string;
  worksheet: string;
  summary: {
    total: number;
    matched: number;
    five_percent?: number;
    twelve_percent?: number;
    eighteen_percent?: number;
    twenty_eight_percent?: number;
    rate_counts?: Partial<Record<"5" | "12" | "18" | "28", number>>;
    review_required: number;
    unmatched: number;
    status_counts: Record<string, number>;
  };
  rows: ResultRow[];
  verification: ResultRow[];
  rate_column: { letter: string; index: number };
};
