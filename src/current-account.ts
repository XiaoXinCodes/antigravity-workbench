/** Only an unambiguous saved record on this host may represent a verified
 * official identity. Display names, selected image accounts and quotas do not. */
export function verifiedCurrentAccountId(accounts: readonly { id: string; expectedEmail: string; hostCurrent?: boolean; migrationState?: string }[], email: string | undefined, pending = false): string | undefined {
  if (pending || !email) return undefined;
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(normalized)) return undefined;
  const matches = accounts.filter(account => account.hostCurrent === true && account.migrationState !== 'pending' && typeof account.expectedEmail === 'string' && account.expectedEmail.trim().toLowerCase() === normalized);
  if (matches.length !== 1 || accounts.filter(account => account.id === matches[0]!.id).length !== 1) return undefined;
  return matches[0]!.id;
}
