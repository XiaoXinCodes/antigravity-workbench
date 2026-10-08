import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { spawn } from 'node:child_process';
import { resolveExecutable, cliEnvironment, terminateProcessTree } from './cli-process';
import { redact } from './cli-process';

export interface QuotaReport {
  source: 'official-cli-server-query'; command: 'agy --print /usage';
  requestedAt: string; completedAt: string; identity: null; serverUpdatedAt: null;
  report: string; verification: 'cli-report-not-independent-server-attestation';
}
export const QUOTA_ARGS = ['--print', '/usage'] as const;
/** Fixed CLI built-in command. Never send arbitrary prompts, read snapshot files, or extract credentials. */
export async function queryQuota(executable: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<QuotaReport> {
  if (signal?.aborted) throw new Error('QUOTA_QUERY_CANCELLED');
  const resolved = await resolveExecutable(executable);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-quota-query-'));
  const requestedAt = new Date().toISOString();
  try {
    const report = await new Promise<string>((resolve, reject) => {
      const child = spawn(resolved, [...QUOTA_ARGS], { cwd: directory, shell: false, detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], env: cliEnvironment() });
      const decoder = new StringDecoder('utf8');
      let stdout = ''; let stderr = ''; let bytes = 0; let failure: string | undefined; let killing: Promise<void> | undefined;
      const stop = (code: string): void => { if (!failure) { failure = code; killing = terminateProcessTree(child); } };
      const cancel = (): void => stop('QUOTA_QUERY_CANCELLED');
      const timer = setTimeout(() => stop('QUOTA_QUERY_TIMEOUT'), timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) cancel();
      child.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 256 * 1024) stop('QUOTA_REPORT_TOO_LARGE'); else { stdout += decoder.write(chunk); if (/authentication required|waiting for authentication|paste the authorization code/iu.test(stdout)) stop('QUOTA_AUTH_REQUIRED'); } });
      child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length); if (/authentication required|waiting for authentication|paste the authorization code/iu.test(stderr)) stop('QUOTA_AUTH_REQUIRED'); });
      child.on('error', () => stop('QUOTA_CLI_START_FAILED'));
      child.on('close', code => {
        clearTimeout(timer); signal?.removeEventListener('abort', cancel);
        void (async () => {
          if (killing) await killing;
          if (failure) throw new Error(failure);
          if (code !== 0) throw new Error(/auth|log.?in|sign.?in|unauthorized|401/iu.test(stderr + stdout) ? 'QUOTA_AUTH_REQUIRED' : 'QUOTA_QUERY_FAILED');
          const report = redact(stdout + decoder.end()).trim();
          if (!report) throw new Error('QUOTA_REPORT_EMPTY');
          // A zero exit alone cannot turn an explicit error report into fresh quota.
          if (/authentication required|not logged in|unauthorized|failed to (?:fetch|refresh)|unknown (?:slash )?command/iu.test(report)) throw new Error('QUOTA_QUERY_FAILED');
          return report;
        })().then(resolve, reject);
      });
    });
    return { source: 'official-cli-server-query', command: 'agy --print /usage', requestedAt, completedAt: new Date().toISOString(), identity: null,
      serverUpdatedAt: null, report, verification: 'cli-report-not-independent-server-attestation' };
  } finally { await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}
