import { LiveError } from './live-storage';

/** Current effective setting only; not evidence about past recovery callbacks.
 * Exact reviewed desktop 1.9 callers omit configOverride. */
export function assertCurrentRecoveryDisabled(value: unknown, disableOverride: unknown): void {
  if (value === true && disableOverride !== '1') throw new LiveError('OFFICIAL_RECOVERY_ENABLED');
}

export interface OwnedStopRuntime {
  /** Return only an exactly owned birth; unknown/foreign instances must throw. */
  inspect(): Promise<string | undefined>;
  stop(expectedBirth: string): Promise<void>;
  waitForExit(expectedBirth: string): Promise<void>;
  assertCurrent(): void;
}

/** Bounded engineering retry, NOT a pause lease. A new birth after the final
 * observation remains possible and is covered by write/readback/identity checks. */
export async function settleOwnedBackend(runtime: OwnedStopRuntime): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    runtime.assertCurrent();
    let birth = await runtime.inspect();
    runtime.assertCurrent();
    if (!birth) {
      birth = await runtime.inspect();
      runtime.assertCurrent();
      if (!birth) return;
    }
    await runtime.stop(birth);
    await runtime.waitForExit(birth);
    runtime.assertCurrent();
  }
  if (await runtime.inspect()) throw new LiveError('OFFICIAL_BACKEND_RESTARTING');
  runtime.assertCurrent();
  if (await runtime.inspect()) throw new LiveError('OFFICIAL_BACKEND_RESTARTING');
  runtime.assertCurrent();
}
