import { imageGuardDiagnostics } from '../image-guard';
import { imageCapabilityDiagnostics } from './image-capabilities';
import { imageConfigurationDiagnostics } from './image-configuration';
import { generateImageBatch, type ImageRequest } from './image-service';
if (require.main === module) {
  const controller = new AbortController();
  process.on('disconnect', () => controller.abort());
  process.on('SIGTERM', () => controller.abort());
  process.on('SIGINT', () => controller.abort());
  process.on('message', message => { if (message === 'cancel') controller.abort(); });
  let input = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => { input += chunk; if (Buffer.byteLength(input) > 128 * 1024) { controller.abort(); process.exitCode = 1; process.stdin.destroy(); process.disconnect?.(); } });
  process.stdin.on('end', () => {
    void (async () => {
      try {
        const result = await generateImageBatch(JSON.parse(input) as ImageRequest, controller.signal, { onProgress: progress => { if (process.connected) process.send?.({ kind: 'progress', progress }); } });
        if (process.connected) process.send?.({ kind: 'result', result });
      } catch (error) { if (process.connected) process.send?.({ kind: 'error', code: error instanceof Error && /^IMAGE_[A-Z_]+$/u.test(error.message) ? error.message : 'IMAGE_LOCAL_IO_ERROR', diagnostics: imageConfigurationDiagnostics(error), capabilities: imageCapabilityDiagnostics(error), guard: imageGuardDiagnostics(error) }); }
      finally { if (process.connected) process.disconnect(); }
    })();
  });
}
