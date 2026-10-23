export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'revoked';
export type ApprovalState = {ready: boolean; status: ApprovalStatus; email_verified: boolean; is_admin: boolean};
export type Applicant = {user_id: string; is_owner: boolean; full_name: string; verified_email: string | null; registered_at: string;
 status: ApprovalStatus; decided_by: string | null; decided_at: string | null};
export type ApprovalList = {counts: Record<'total' | ApprovalStatus, number>; filtered_total: number; users: Applicant[];
 notifications: {pending: number; needs_review: number}};
export function canUseWorkspace(state: ApprovalState): boolean {
 return state.ready === true && state.email_verified === true && state.status === 'approved';
}
export function canManageApprovals(state: ApprovalState): boolean {
 return canUseWorkspace(state) && state.is_admin === true;
}
export function approvalMessage(state: ApprovalState): string {
 if (!state.email_verified) return 'Verify your email before using GST Ledger Studio.';
 if (state.status === 'rejected') return 'Your account approval request was rejected.';
 if (state.status === 'revoked') return 'Your account access has been revoked.';
 return 'Your account is awaiting administrator approval.';
}
