import { LiveError } from './live-storage';
import type { OfficialWriteContract } from './official-contract';

/** Current configuration admission, not a proof that past callbacks drained.
 * The lifecycle checks actual exits and bounds retries of observed late starts. */
export function assertComponentPauseContract(contract: OfficialWriteContract, assertRecoveryDisabled?: () => void): void {
  if (contract === '1.8.0') return;
  if (!['1.9.0', 'component-runtime'].includes(contract) || !assertRecoveryDisabled) throw new LiveError('OFFICIAL_CREDENTIAL_WRITE_BARRIER_UNAVAILABLE');
  assertRecoveryDisabled();
}

/** The reviewed 1.8 ready publication clears startingPromise in the same
 * synchronous tail. The caller must still pin the exact process/contract,
 * exclude other hosts, and stop that instance before any credential write. */
export async function admitReadyOfficialWrite(
  contract: OfficialWriteContract,
  readyIdentity: () => Promise<string>,
  _wait?: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
  assertRecoveryDisabled?: () => void,
): Promise<string> {
  assertComponentPauseContract(contract, assertRecoveryDisabled);
  if (signal?.aborted) throw new LiveError('CANCELLED');
  const before = await readyIdentity();
  if (signal?.aborted) throw new LiveError('CANCELLED');
  const after = await readyIdentity();
  assertComponentPauseContract(contract, assertRecoveryDisabled);
  if (signal?.aborted) throw new LiveError('CANCELLED');
  if (!before || before !== after) throw new LiveError('HUB_CHANGED_DURING_OPERATION');
  return after;
}
