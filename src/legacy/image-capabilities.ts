/* eslint-disable no-control-regex -- Only safe path/flag diagnostics cross IPC. */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { terminateProcessTree } from './cli-process';

export const IMAGE_REQUIRED_CLI_FLAGS = ['--input-format', '--output-format', '--json-schema', '--agent', '--disable-slash-commands', '--new-project', '--print-timeout'] as const;
export interface ImageCapabilityDiagnostics { executable: string; missingFlags: string[] }
export class ImageCapabilityError extends Error {
  constructor(code: string, readonly capabilities: ImageCapabilityDiagnostics) { super(code); this.name = 'ImageCapabilityError'; }
}
/** Do not expose CLI stdout/stderr, config values or arbitrary child-provided diagnostics. */
export function imageCapabilityDiagnostics(error: unknown): ImageCapabilityDiagnostics | undefined {
  const value = error && typeof error === 'object' ? (error as { capabilities?: unknown }).capabilities : undefined;
  if (!value || typeof value !== 'object') return undefined;
  const item = value as Record<string, unknown>;
  if (typeof item.executable !== 'string' || item.executable.length < 1 || item.executable.length > 4096 || /[\x00-\x1f\x7f]/u.test(item.executable) || !Array.isArray(item.missingFlags) || item.missingFlags.length > IMAGE_REQUIRED_CLI_FLAGS.length || item.missingFlags.some(flag => !(IMAGE_REQUIRED_CLI_FLAGS as readonly unknown[]).includes(flag))) return undefined;
  return { executable: item.executable, missingFlags: [...new Set(item.missingFlags as string[])] };
}
export function missingImageCliFlags(help: string): string[] {
  // Match actual option declarations, not prose mentioning a missing option.
  const declared = new Set([...help.matchAll(/^\s*(?:-[a-zA-Z],?\s+)?(--[a-z][a-z-]*)(?=[\s=,]|$)/gmu)].map(match => match[1]));
  return IMAGE_REQUIRED_CLI_FLAGS.filter(flag => !declared.has(flag));
}

/** Read-only, bounded help probe. No prompt, login, version allowlist or paid turn. */
export async function checkImageCliCapabilities(executable: string, env: NodeJS.ProcessEnv, signal: AbortSignal, prefix: string[] = [], timeoutMs = 8000, cwd?: string): Promise<void> {
  const details = (missingFlags: string[] = []): ImageCapabilityDiagnostics => ({ executable, missingFlags });
  if (signal.aborted) throw new Error('IMAGE_CANCELLED');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...prefix, '--help'], { env, cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', bytes = 0, failure: string | undefined, killing: Promise<void> | undefined;
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    const stop = (code: string): void => { if (!failure) { failure = code; killing = terminateProcessTree(child); } };
    const cancel = (): void => stop('IMAGE_CANCELLED');
    const timer = setTimeout(() => stop('IMAGE_CLI_PROBE_TIMEOUT'), timeoutMs);
    const append = (chunk: Buffer, decoder: StringDecoder): void => { bytes += chunk.length; if (bytes > 256 * 1024) stop('IMAGE_CLI_PROBE_FAILED'); else output += decoder.write(chunk); };
    child.stdout.on('data', (chunk: Buffer) => append(chunk, stdout)); child.stderr.on('data', (chunk: Buffer) => append(chunk, stderr));
    child.on('error', () => stop('IMAGE_CLI_PROBE_FAILED'));
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
    child.on('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      void (async () => {
        if (killing) await killing;
        if (failure) throw new ImageCapabilityError(failure, details());
        if (code !== 0) throw new ImageCapabilityError('IMAGE_CLI_PROBE_FAILED', details());
        const missing = missingImageCliFlags(output + stdout.end() + stderr.end());
        if (missing.length) throw new ImageCapabilityError('IMAGE_CLI_CAPABILITY_MISSING', details(missing));
      })().then(resolve, reject);
    });
  });
}
