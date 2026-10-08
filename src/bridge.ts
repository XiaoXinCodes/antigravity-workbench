import { t as tr } from './i18n';
import { collectStatusline, InputError, LIMITS, parseJson } from './core';
import { writeSnapshotFile } from './snapshot-files';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timeout = setTimeout(() => process.stdin.destroy(new InputError('INPUT_TIMEOUT')), 3000);
  try {
    for await (const chunk of process.stdin) {
      const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      size += bytes.length;
      if (size > LIMITS.inputBytes) throw new InputError('INPUT_TOO_LARGE');
      chunks.push(bytes);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { clearTimeout(timeout); }
}
export async function main(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--dir' || !args[1]) throw new InputError('USAGE');
  const snapshot = collectStatusline(parseJson(await readStdin()));
  await writeSnapshotFile(args[1], snapshot);
  process.stdout.write(snapshot.quotaState === 'missing' ? tr("bridge.26972a6469") : tr("bridge.4a7d19b639"));
}
if (require.main === module) {
  main(process.argv.slice(2)).catch(error => {
    // No raw input, identity, filesystem path, stack, or third-party error text on stdout/stderr.
    const code = error instanceof InputError ? error.code : 'IO_ERROR';
    process.stderr.write(`Antigravity snapshot bridge: ${code}\n`);
    process.exitCode = 1;
  });
}
