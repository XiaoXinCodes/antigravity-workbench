import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readLocalGenerationDb } from './local-generation-db';
import { mergeLocalRecords, type LocalGenerationRecord } from './local-generation-record';
export type GenerationClient = 'cli' | 'ide' | 'selected';
export interface GenerationScope { host: string; files: number; skipped: number; rows: number; limited: boolean; gaps?: Partial<Record<'changed' | 'unsupported' | 'unsafe' | 'unavailable' | 'limit', number>> }
export interface DiscoveryRuntime { home: string; platform: NodeJS.Platform; cliHome?: string; remoteName?: string }
export const nativeDiscoveryRuntime = (): DiscoveryRuntime => ({ home: os.homedir(), platform: process.platform, ...(process.env.GEMINI_CLI_HOME ? {cliHome: process.env.GEMINI_CLI_HOME} : {}) });
export function officialConversationRoots(runtime: DiscoveryRuntime): { directory: string; client: GenerationClient }[] {
  // A Windows UI host in a WSL workspace must not scan the Windows home as WSL data.
  if (runtime.remoteName === 'wsl' && runtime.platform !== 'linux') throw Error('LOCAL_DB_HOST_UNSUPPORTED');
  const native = runtime.platform === 'win32' ? path.win32 : path.posix;
  const valid = (value: string) => native.isAbsolute(value) && value.length <= 4096 && ![...value].some(c => c.charCodeAt(0) < 32);
  if (!valid(runtime.home) || runtime.cliHome !== undefined && !valid(runtime.cliHome)) throw Error('LOCAL_DB_UNSAFE');
  return [{directory:native.join(runtime.cliHome ?? native.join(runtime.home,'.gemini'),'antigravity-cli','conversations'),client:'cli'}, {directory:native.join(runtime.home,'.gemini','antigravity','conversations'),client:'ide'}];
}
const MAX_FILES = 20, MAX_ROWS = 2000, MAX_ENTRIES = 5000;
export async function readConversationDirectory(directory: string, signal: AbortSignal, deps: { runtime?: DiscoveryRuntime; read?: typeof readLocalGenerationDb } = {}) {
  return readNativeGenerations(signal, deps, [{directory,client:'selected'}]);
}
/** On-demand bounded discovery. No recursion, credential paths, grants, timers or model requests. */
export async function readNativeGenerations(signal: AbortSignal, deps: { runtime?: DiscoveryRuntime; read?: typeof readLocalGenerationDb } = {}, selected?: {directory:string;client:GenerationClient}[]): Promise<{rows:LocalGenerationRecord[];scope:GenerationScope;found:boolean}> {
  const runtime = deps.runtime ?? nativeDiscoveryRuntime(), roots = selected ?? officialConversationRoots(runtime);
  const candidates: {file:string;client:GenerationClient;modified:number}[] = [];
  const scope: GenerationScope = {host:runtime.platform + (runtime.remoteName ? ` (${runtime.remoteName})` : ''),files:0,skipped:0,rows:0,limited:false}; let found = false;
  const gap = (reason: 'changed' | 'unsupported' | 'unsafe' | 'unavailable' | 'limit') => { scope.skipped++; scope.gaps ??= {}; scope.gaps[reason] = (scope.gaps[reason] ?? 0) + 1; if (reason === 'limit') scope.limited = true; };
  const check = () => { if (signal.aborted) throw Error('LOCAL_DB_CANCELLED'); };
  for (const root of roots) {
    check();
    try {
      const stat = await fs.lstat(root.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root.directory) !== path.resolve(root.directory) || typeof process.getuid === 'function' && stat.uid !== process.getuid()) { gap('unsafe'); continue; }
      found = true; let seen=0;
      for await (const entry of await fs.opendir(root.directory)) {
        check(); if (++seen > MAX_ENTRIES) {scope.limited=true;break;}
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.db$/i.test(entry.name)) continue;
        if (!entry.isFile() || entry.isSymbolicLink()) {gap('unsafe');continue;}
        const file=path.join(root.directory,entry.name), stat=await fs.lstat(file);
        candidates.push({file,client:root.client,modified:stat.mtimeMs});
      }
    } catch (error) { if (signal.aborted) throw Error('LOCAL_DB_CANCELLED'); if ((error as NodeJS.ErrnoException).code !== 'ENOENT') gap('unavailable'); }
  }
  // mtime determines the bounded file selection only, never a generation timestamp.
  candidates.sort((a,b)=>b.modified-a.modified || a.file.localeCompare(b.file));
  if (candidates.length > MAX_FILES) scope.limited=true;
  const rows: LocalGenerationRecord[] = [];
  let processed=0;
  for (const candidate of candidates.slice(0,MAX_FILES)) {
    processed++;
    check(); let result: Awaited<ReturnType<typeof readLocalGenerationDb>> | undefined;
    for (let attempt=0;attempt<2;attempt++) {
      try { result=await (deps.read ?? readLocalGenerationDb)(candidate.file,signal);break; }
      catch (error) {
        if (signal.aborted) throw Error('LOCAL_DB_CANCELLED');
        if (attempt===0 && error instanceof Error && error.message==='LOCAL_DB_CHANGED') continue;
        const code = error instanceof Error ? error.message : '';
        gap(code === 'LOCAL_DB_CHANGED' ? 'changed' : code === 'LOCAL_DB_UNSUPPORTED' ? 'unsupported' : code === 'LOCAL_DB_UNSAFE' ? 'unsafe' : code === 'LOCAL_DB_LIMIT' ? 'limit' : 'unavailable'); break;
      }
    }
    if (!result) continue;
    scope.files++; scope.limited ||= result.limited;
    if (rows.length + result.rows.length > MAX_ROWS) scope.limited=true;
    rows.push(...result.rows.slice(0,MAX_ROWS-rows.length).map(row=>({...row,client:candidate.client,key:candidate.client+':'+row.key})));
    if (rows.length >= MAX_ROWS) { if (processed < candidates.length) scope.limited=true;break; }
  }
  check(); const merged=mergeLocalRecords(rows);scope.rows=merged.length;
  return {rows:merged,scope,found};
}
