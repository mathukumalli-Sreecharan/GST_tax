import type {ReviewRow} from '@/lib/types';

/** The backend marks rows requiring a decision with any status except MATCHED. */
export function reviewableRows(rows: ReviewRow[]): ReviewRow[] {
 return rows.filter(row => row.status !== 'MATCHED');
}
