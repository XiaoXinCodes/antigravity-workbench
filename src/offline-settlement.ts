import { LiveError, type TokenSlots } from './live-storage';
import { sameStorageIdentity } from './live-switch';
import type { OfflineJournal, OfflineProcess } from './offline-switch';

/** Call only after joining the operation lock. This classifies bytes; it does
 * not authorize clearing a fence without fresh server identity and route proof. */
export function classifyOfflineSettlement(record: OfflineJournal, current: TokenSlots): 'target' | 'original' {
  if (current.keyringState !== 'unobserved' || record.backup.keyringState !== 'unobserved' || record.target.keyringState !== 'unobserved') throw new LiveError('OFFLINE_SCOPE_UNVERIFIED');
  const target = sameStorageIdentity(current, record.target), original = sameStorageIdentity(current, record.backup);
  if (record.phase === 'prepared') {
    if (original && record.originalEmail) return 'original';
    if (target) return 'target';
  } else if (['restored', 'restored-verified'].includes(record.phase)) {
    if (original && record.originalEmail) return 'original';
  } else if (['installed', 'verified'].includes(record.phase) && target) return 'target';
  throw new LiveError('VERIFICATION_STORAGE_MISMATCH');
}

export function isNewOfflineHost(record: OfflineJournal, current: OfflineProcess): boolean | undefined {
  // Old candidates only stored the initiating host in knownHosts. Do not call
  // an existing peer a reopened host; missing initial membership is unknown.
  const hosts = record.execution?.initialHosts;
  return hosts ? !hosts.some(host => host.pid === current.pid && host.startIdentity === current.startIdentity) : undefined;
}
