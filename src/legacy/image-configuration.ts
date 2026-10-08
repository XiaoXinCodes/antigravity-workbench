/** Schema-aware CLI configuration inspection. Never changes settings or reads token stores. */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

export interface ImageConfigurationIssue { source: string; key?: string; reason: string }
export class ImageConfigurationError extends Error {
  constructor(code: string, readonly diagnostics: ImageConfigurationIssue[]) { super(code); this.name = 'ImageConfigurationError'; }
}
const MAX_ISSUES = 8;
const SETTINGS = ['.gemini/config/config.json', '.gemini/antigravity-cli/settings.json', '.antigravity/settings.json'] as const;
const HOOK_FILES = ['.gemini/config/hooks.json', '.gemini/antigravity-cli/hooks.json'];
const MCP_FILES = ['.gemini/config/mcp_config.json', '.gemini/antigravity-cli/mcp_config.json', '.gemini/mcp_config.json'];
const DIRECTORIES = ['.gemini/config/agents', '.gemini/config/rules', '.gemini/config/skills', '.gemini/config/plugins', '.gemini/config/sidecars',
  '.gemini/antigravity-cli/agents', '.gemini/antigravity-cli/rules', '.gemini/antigravity-cli/skills', '.gemini/antigravity-cli/plugins', '.gemini/antigravity-cli/sidecars', '.gemini/extensions'];
const DISCOVERY_FILES = ['.gemini/AGENTS.md', '.gemini/GEMINI.md', '.gemini/config/AGENTS.md', '.gemini/config/GEMINI.md',
  '.gemini/config/agents.json', '.gemini/config/rules.json', '.gemini/config/skills.json', '.gemini/config/plugins.json',
  '.gemini/antigravity-cli/agents.json', '.gemini/antigravity-cli/rules.json', '.gemini/antigravity-cli/skills.json', '.gemini/antigravity-cli/plugins.json'];
const KNOWN_SOURCES = new Set([...SETTINGS, ...HOOK_FILES, ...MCP_FILES, ...DIRECTORIES, ...DISCOVERY_FILES, '.gemini', '.gemini/antigravity-cli', '.gemini/config', '.gemini/config/keybindings.json', '.gemini/config/projects']);
const REASONS = new Set(['配置无法安全读取', '配置不是有效 JSON 对象', '配置层级过深', '存在全局工具执行或服务覆盖配置', '不支持的认证方式', '存在全局指令或扩展入口', '存在未支持的共享配置入口', '临时目录上级含项目配置', '已启用的本机界面脚本需要本次明确授权', '配置在确认后已改变']);
const KNOWN_KEYS = new Set(['userSettings', 'previousAuthMethod', 'authMethod', 'auth_method', 'auth.method', 'auth', 'method', 'hooks', 'mcpServers', 'mcp', 'plugins', 'sidecars', 'statusLine', 'title', 'windowTitle', 'modelProvider', 'sandboxProxy', 'skills', 'customWorkspace', 'custom_models', 'caCertPath', 'models', 'remoteControl', 'gateway', 'customModels', 'customModelsConfig', 'customizations', 'personal_customization_dir', 'apiKey', 'api_key', 'apiUrl', 'baseUrl', 'serverUrl', 'endpointUrl', 'provider', 'headers', 'adc', 'wif']);
function populated(value: unknown): boolean { return value !== null && value !== undefined && value !== false && value !== '' && (!Array.isArray(value) || value.length > 0) && (typeof value !== 'object' || Array.isArray(value) || Object.keys(value as object).length > 0); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
export interface ImageScriptApproval { source: '~/.gemini/antigravity-cli/settings.json'; key: 'statusLine' | 'title'; sha256: string }
export interface ImageScriptReview extends ImageScriptApproval { preview: string }
export interface ImageConfigurationReview { scripts: ImageScriptReview[] }
function commandPreview(command: string): string {
  // Never show arbitrary paths, arguments, URLs, environment assignments or values.
  // Even a command's basename can be private; expose only these common runtimes.
  const first = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/u);
  const program = first ? path.basename(first[1] || first[2] || first[3] || '').toLowerCase().replace(/\.exe$/u, '') : '';
  return ['node', 'python', 'python3', 'bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd'].includes(program) ? `${program} …（参数已隐藏）` : '自定义命令（内容已隐藏）';
}
export function validImageScriptApprovals(value: unknown): value is ImageScriptApproval[] {
  return Array.isArray(value) && value.length <= 2 && value.every(item => object(item) && Object.keys(item).length === 3 && item.source === '~/.gemini/antigravity-cli/settings.json' && ['statusLine', 'title'].includes(String(item.key)) && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(item.sha256)) && new Set(value.map(item => item.key)).size === value.length;
}
export async function checkImageConfiguration(home: string, workspace: string, approvedScripts: ImageScriptApproval[] = []): Promise<void> {
  if (!validImageScriptApprovals(approvedScripts)) throw new Error('IMAGE_REQUEST_INVALID');
  const review = await reviewImageConfiguration(home, workspace);
  for (const script of review.scripts) {
    const approved = approvedScripts.find(item => item.source === script.source && item.key === script.key);
    if (!approved || approved.sha256 !== script.sha256) throw new ImageConfigurationError(approved ? 'IMAGE_CONFIGURATION_CHANGED' : 'IMAGE_SCRIPT_CONSENT_REQUIRED', [{ source: script.source, key: script.key, reason: approved ? '配置在确认后已改变' : '已启用的本机界面脚本需要本次明确授权' }]);
  }
  if (approvedScripts.some(approved => !review.scripts.some(script => script.key === approved.key && script.sha256 === approved.sha256))) throw new ImageConfigurationError('IMAGE_CONFIGURATION_CHANGED', [{ source: '~/.gemini/antigravity-cli/settings.json', reason: '配置在确认后已改变' }]);
}
/** IPC and UI only receive known paths/field names/reasons, never arbitrary config values or names. */
export function imageConfigurationDiagnostics(error: unknown): ImageConfigurationIssue[] {
  const items = error && typeof error === 'object' ? (error as { diagnostics?: unknown }).diagnostics : undefined;
  if (!Array.isArray(items)) return [];
  return items.slice(0, MAX_ISSUES).flatMap(item => {
    if (!object(item) || typeof item.source !== 'string' || typeof item.reason !== 'string' || !REASONS.has(item.reason)) return [];
    if (!KNOWN_SOURCES.has(item.source.replace(/^~\//u, '')) && !/^临时目录上级\([1-9][0-9]*\)\/(?:\.agents|\.agent|\.gemini|AGENTS\.md|GEMINI\.md)$/u.test(item.source)) return [];
    if (item.key !== undefined && (typeof item.key !== 'string' || item.key.length > 256 || item.key.split('.').some(key => !KNOWN_KEYS.has(key) && key !== '<自定义字段>'))) return [];
    return [{ source: item.source, reason: item.reason, ...(typeof item.key === 'string' ? { key: item.key } : {}) }];
  });
}

/** No blanket rejection of an existing CLI profile: accept verified inert metadata only. */
export async function reviewImageConfiguration(home: string, workspace?: string): Promise<ImageConfigurationReview> {
  const scripts: ImageScriptReview[] = []; const fileHashes = new Map<string, string>();
  const diagnostics: ImageConfigurationIssue[] = []; let unsafe = false; let parentIssue = false;
  const add = (relative: string, reason: string, key?: string): void => {
    if (diagnostics.length < MAX_ISSUES) diagnostics.push({ source: relative.startsWith('临时目录') ? relative : `~/${relative}`, ...(key ? { key } : {}), reason });
    if (reason.startsWith('配置')) unsafe = true;
  };
  const stat = async (relative: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> => {
    try {
      const file = path.join(home, relative); const st = await fs.lstat(file);
      if (st.isSymbolicLink() || await fs.realpath(file) !== file) { add(relative, '配置无法安全读取'); return undefined; }
      return st;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') add(relative, '配置无法安全读取'); return undefined; }
  };
  const read = async (relative: string, allowEmpty = false): Promise<Record<string, unknown> | undefined> => {
    const st = await stat(relative); if (!st) return undefined;
    if (!st.isFile() || st.nlink > 1 || st.size > 1024 * 1024) { add(relative, '配置无法安全读取'); return undefined; }
    try {
      const handle = await fs.open(path.join(home, relative), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink > 1 || opened.size > 1024 * 1024 || opened.dev !== st.dev || opened.ino !== st.ino) { add(relative, '配置无法安全读取'); return undefined; }
        const bytes = Buffer.alloc(1024 * 1024 + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 1024 * 1024) { add(relative, '配置无法安全读取'); return undefined; }
        const after = await handle.stat(); const current = await fs.lstat(path.join(home, relative));
        if (bytesRead !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || current.ino !== opened.ino || current.dev !== opened.dev || current.isSymbolicLink()) { add(relative, '配置无法安全读取'); return undefined; }
        const content = bytes.subarray(0, bytesRead);
        fileHashes.set(relative, createHash('sha256').update(content).digest('hex'));
        // Official 1.2.14 creates a zero-byte MCP file during first migration.
        if (allowEmpty && bytesRead === 0) return {};
        const parsed: unknown = JSON.parse(content.toString('utf8')); 
        if (!object(parsed)) { add(relative, '配置不是有效 JSON 对象'); return undefined; }
        return parsed;
      } finally { await handle.close(); }
    } catch (error) { add(relative, error instanceof SyntaxError ? '配置不是有效 JSON 对象' : '配置无法安全读取'); return undefined; }
  };
  for (const relative of ['.gemini', '.gemini/antigravity-cli']) {
    const st = await stat(relative); if (st && !st.isDirectory()) add(relative, '配置无法安全读取');
  }
  // The documented reader discovers named customization paths. It does not
  // execute every unknown filename in config/. .migrated and project/cache/UI
  // metadata are ordinary official state, not a customization allowlist failure.
  for (const relative of ['.gemini/config', '.gemini/config/projects']) {
    const st = await stat(relative); if (st && !st.isDirectory()) add(relative, '配置无法安全读取');
  }
  for (const relative of DIRECTORIES) {
    const st = await stat(relative); if (!st) continue;
    try { if (!st.isDirectory() || (await fs.readdir(path.join(home, relative))).length) add(relative, '存在全局指令或扩展入口'); }
    catch { add(relative, '配置无法安全读取'); }
  }
  for (const relative of DISCOVERY_FILES) if (await stat(relative)) add(relative, '存在全局指令或扩展入口');
  for (const relative of HOOK_FILES) {
    const hooks = await read(relative);
    // Only an actually empty map is inert. Disabled/populated hook definitions
    // still require review; never guess how another CLI build merges them.
    if (hooks && Object.keys(hooks).length) add(relative, '存在全局工具执行或服务覆盖配置', 'hooks');
  }
  for (const relative of MCP_FILES) {
    const mcp = await read(relative, true);
    if (mcp && !(Object.keys(mcp).length === 0 || (Object.keys(mcp).length === 1 && object(mcp.mcpServers) && Object.keys(mcp.mcpServers).length === 0))) add(relative, '存在全局工具执行或服务覆盖配置', 'mcpServers');
  }
  for (const relative of SETTINGS) {
    const value = await read(relative); if (!value) continue;
    const block = (config: Record<string, unknown>, fields: readonly string[], prefix = ''): void => {
      for (const field of fields) if (populated(config[field])) add(relative, '存在全局工具执行或服务覆盖配置', prefix + field);
    };
    if (relative === '.antigravity/settings.json') {
      // Official gateway.defaultUserSettingsPath / AdminSettings. This is not
      // the unrelated Gemini CLI security.auth profile. Struct aliases fold case.
      for (const [field, entry] of Object.entries(value)) {
        const known = ['caCertPath', 'gateway', 'models'].find(key => key.toLowerCase() === field.toLowerCase());
        if (known && populated(entry)) add(relative, '存在全局工具执行或服务覆盖配置', known);
      }
      continue;
    }
    if (relative === '.gemini/config/config.json') {
      // UserConfig is decoded as a protobuf (DiscardUnknown). Only its actual
      // customization fields and effective user-settings overrides matter here.
      block(value, ['sidecars', 'plugins', 'skills']);
      const settings = value.userSettings ?? value.user_settings;
      if (object(settings)) block(settings, ['customModels', 'custom_models'], 'userSettings.');
      continue;
    }
    // CliSetting uses ParseSettingsFields, not a recursive substring matcher.
    // Unknown nested auth/custom/UI data is preserved by CLI but not executed.
    block(value, ['customModelsConfig', 'modelProvider', 'sandboxProxy', 'hooks', 'mcpServers', 'plugins', 'sidecars', 'skills']);
    if ('previousAuthMethod' in value && (typeof value.previousAuthMethod !== 'string' || !['', 'consumer', 'gcp', 'keyring'].includes(value.previousAuthMethod))) add(relative, '不支持的认证方式', 'previousAuthMethod');
    for (const key of ['statusLine', 'title'] as const) {
      const script = value[key]; if (!populated(script)) continue;
      if (!object(script)) { add(relative, '配置不是有效 JSON 对象', key); continue; }
      // ParseSettingsFields matches root keys exactly, while the nested Go
      // StatusLine struct decoder accepts case-insensitive member names. Never
      // let Command/Enabled aliases bypass execution consent. Ambiguity fails.
      const commands = Object.entries(script).filter(([field]) => field.toLowerCase() === 'command');
      const enables = Object.entries(script).filter(([field]) => field.toLowerCase() === 'enabled');
      const command = commands[0]?.[1], enabled = enables[0]?.[1];
      if (commands.length > 1 || enables.length > 1 || (command !== undefined && command !== null && typeof command !== 'string') || (enabled !== undefined && enabled !== null && typeof enabled !== 'boolean')) { add(relative, '配置不是有效 JSON 对象', key); continue; }
      // Native initStatusLine/InitTitle return for empty commands or enabled=false.
      if (enabled === false || !command) continue;
      scripts.push({ source: '~/.gemini/antigravity-cli/settings.json', key, sha256: fileHashes.get(relative)!, preview: commandPreview(String(command)) });
    }
  }
  let parent = workspace ? path.dirname(workspace) : ''; let level = 1;
  while (parent) {
    for (const dot of ['.agents', '.agent', '.gemini', 'AGENTS.md', 'GEMINI.md']) {
      try {
        const file = path.join(parent, dot); const st = await fs.lstat(file);
        if (st.isSymbolicLink() || !st.isDirectory() || (await fs.readdir(file)).length) { parentIssue = true; add(`临时目录上级(${level})/${dot}`, '临时目录上级含项目配置'); }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { parentIssue = true; add(`临时目录上级(${level})/${dot}`, '临时目录上级含项目配置'); } }
    }
    const next = path.dirname(parent); if (next === parent) break; parent = next; level++;
  }
  if (diagnostics.length) throw new ImageConfigurationError(unsafe ? 'IMAGE_UNSAFE_CLI_SETTINGS' : parentIssue ? 'IMAGE_PARENT_CUSTOMIZATIONS_UNSUPPORTED' : 'IMAGE_EXTERNAL_CUSTOMIZATIONS_UNSUPPORTED', diagnostics);
  return { scripts };
}
