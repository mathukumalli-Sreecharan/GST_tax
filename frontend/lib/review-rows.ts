import type {ReviewRow} from '@/lib/types';

/** The backend marks rows requiring a decision with any status except MATCHED. */
export function reviewableRows(rows: ReviewRow[], decisions: Record<string, {choice:'CORRECT'|'WRONG';rates:string[];split_confirmed?:boolean}> = {}): ReviewRow[] {
 return rows.filter(row => {
  if (row.status === 'MATCHED') return false;
  const decision = decisions[String(row.excel_row)];
  return !decision || (decision.choice === 'WRONG' && decision.rates.length > 1 && !decision.split_confirmed);
 });
}
