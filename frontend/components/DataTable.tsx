"use client";

import { useMemo, useState } from "react";
import {
  ColumnDef, flexRender, getCoreRowModel, getFilteredRowModel,
  getPaginationRowModel, getSortedRowModel, SortingState, useReactTable,
} from "@tanstack/react-table";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Search } from "lucide-react";

type Props<T extends object> = {
  rows: T[];
  columns: ColumnDef<T, unknown>[];
  onRowClick?: (row: T) => void;
  statusFilter?: boolean;
  emptyText?: string;
  pageSize?: number;
};

export function DataTable<T extends object>({ rows, columns, onRowClick, statusFilter = false,
  emptyText = "No records to display.", pageSize = 10 }: Props<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [globalFilter, setGlobalFilter] = useState("");
  const [status, setStatus] = useState("ALL");
  const data = useMemo(() => status === "ALL" ? rows : rows.filter((row) =>
    String((row as Record<string, unknown>).status ?? "") === status), [rows, status]);
  const table = useReactTable({ data, columns, state: { sorting, globalFilter },
    onSortingChange: setSorting, onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(), getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } }, globalFilterFn: "includesString" });
  const allCount = table.getFilteredRowModel().rows.length;
  return <div>
    <div className="toolbar" style={{ justifyContent: "space-between", padding: "8px 0" }}>
      <label style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <Search size={14} style={{ position: "absolute", left: 9, color: "#64748b" }} />
        <input className="search" aria-label="Search table" placeholder="Search records" value={globalFilter}
          onChange={(event) => setGlobalFilter(event.target.value)} style={{ paddingLeft: 29 }} />
      </label>
      {statusFilter && <select aria-label="Filter by verification status" className="search" value={status}
        onChange={(event) => setStatus(event.target.value)} style={{ minWidth: 155 }}>
        <option value="ALL">All statuses</option><option>MATCHED</option><option>REVIEW REQUIRED</option>
        <option>REVIEW_REQUIRED</option><option>UNRESOLVED</option><option>UNMATCHED</option><option>INVALID</option><option>AMBIGUOUS</option>
      </select>}
      <span style={{ color: "#64748b", fontSize: 10 }}>{allCount.toLocaleString()} records</span>
    </div>
    <div className="data-wrap"><table className="data-table">
      <thead>{table.getHeaderGroups().map((group) => <tr key={group.id}>{group.headers.map((header) => <th key={header.id} className={["invoice_value", "taxable_value", "difference"].includes(header.column.id) ? "numeric-heading" : undefined}>
        {header.isPlaceholder ? null : <button type="button" onClick={header.column.getToggleSortingHandler()}
          aria-label={`Sort by ${String(header.column.columnDef.header ?? "column")}`} style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "none", border: 0, color: "inherit", padding: 0, fontWeight: "inherit" }}>
          {flexRender(header.column.columnDef.header, header.getContext())}
          {header.column.getIsSorted() === "asc" ? <ChevronUp size={12} /> : header.column.getIsSorted() === "desc" ? <ChevronDown size={12} /> : null}
        </button>}
      </th>)}</tr>)}</thead>
      <tbody>{table.getRowModel().rows.map((row) => <tr key={row.id} className={onRowClick ? "click-row" : undefined}
        onClick={() => onRowClick?.(row.original)} tabIndex={onRowClick ? 0 : undefined}
        onKeyDown={(event) => { if (onRowClick && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onRowClick(row.original); } }}>
        {row.getVisibleCells().map((cell) => <td key={cell.id} className={["invoice_value", "taxable_value", "difference"].includes(cell.column.id) ? "numeric-cell" : undefined}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}
      </tr>)}{table.getRowModel().rows.length === 0 && <tr><td colSpan={columns.length} style={{ textAlign: "center", height: 70, color: "#64748b" }}>{emptyText}</td></tr>}</tbody>
    </table></div>
    <div className="pagination"><span>Page {table.getState().pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())}</span>
      <div className="toolbar"><button className="btn btn-small" type="button" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Previous page"><ChevronLeft size={13} />Previous</button>
        <button className="btn btn-small" type="button" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Next page">Next<ChevronRight size={13} /></button></div>
    </div>
  </div>;
}
