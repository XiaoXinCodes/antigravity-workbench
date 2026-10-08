import { beginDebugOperation, debugErrorData, debugFailureOutcome, type DebugSpan } from '../debug-events';
import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { terminateProcessTree } from './cli-process';
import { imageGuardDiagnostics, type ImageGuardReason } from '../image-guard';
import { imageCapabilityDiagnostics } from './image-capabilities';
import { spawn, type ChildProcess } from 'node:child_process';
import { RATIOS, validateImageRequest, type ImageRequest, type ImageResult, type ImageProgress } from './image-service';
import { readPng } from '../image-files';
import { homedir } from 'node:os';
import { isLocalFileUri, nativeHostStatus } from '../native-host';
import { imageConfigurationDiagnostics, reviewImageConfiguration, type ImageConfigurationReview } from './image-configuration';

export interface ImageUiDependencies {
  outputChanged?: () => void;
  accountRecoveryPending?: () => boolean;
  reviewConfiguration?: () => Promise<ImageConfigurationReview>;
  run?: (request: ImageRequest, signal: AbortSignal, progress: (value: ImageProgress) => void) => Promise<ImageResult>;
  configurationTimeoutMs?: number;
  workerTimeoutMs?: number;
  cancelTimeoutMs?: number;
}
/** Bound local waits without trusting a pending filesystem or dialog to honour abort. */
function bounded<T>(work: PromiseLike<T>, signal: AbortSignal, timeoutMs: number, timeoutCode: string, cancelTimeoutMs = 0, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false; let timer: NodeJS.Timeout | undefined; let cancelTimer: NodeJS.Timeout | undefined;
    const finish = (error?: unknown, value?: T): void => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(cancelTimer); signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value as T);
    };
    const abort = (): void => {
      if (cancelTimer || settled) return;
      if (!cancelTimeoutMs) finish(new Error('IMAGE_CANCELLED'));
      else cancelTimer = setTimeout(() => finish(new Error('IMAGE_CANCEL_TIMEOUT')), cancelTimeoutMs);
    };
    if (timeoutMs > 0) timer = setTimeout(() => { finish(new Error(timeoutCode)); onTimeout?.(); }, timeoutMs);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    Promise.resolve(work).then(value => finish(undefined, value), error => finish(error));
  });
}
export interface ImageWorkerTimeouts { preparationMs?: number; generationMs?: number; cancelMs?: number; shutdownMs?: number }
export function runImageWorker(request: ImageRequest, signal: AbortSignal, progress: (value: ImageProgress) => void, timeouts: ImageWorkerTimeouts = {}): Promise<ImageResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('IMAGE_CANCELLED'));
    const child: ChildProcess = spawn(process.execPath, [path.join(__dirname, 'image-worker.js')], { shell: false, windowsHide: true, detached: true,
      stdio: ['pipe', 'ignore', 'ignore', 'ipc'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    let settled = false; let cancelling = false; let timeoutCode: string | undefined;
    let timer: NodeJS.Timeout | undefined; let cancelTimer: NodeJS.Timeout | undefined;
    const notifyCancel = (): void => { if (child.connected) { try { child.send('cancel', () => undefined); } catch { /* An exited IPC channel is already stopped. */ } } };
    const stopWorker = async (): Promise<void> => {
      notifyCancel(); if (child.connected) { try { child.disconnect(); } catch { /* Already disconnected. */ } }
      // The CLI owns a separate process group. Let the worker abort that CLI and
      // finish cleanup before force-stopping the worker itself.
      if (child.pid && child.exitCode === null && child.signalCode === null) await new Promise<void>(done => {
        const exited = (): void => { clearTimeout(shutdown); child.removeListener('exit', exited); done(); };
        const shutdown = setTimeout(exited, timeouts.shutdownMs ?? 5000); child.once('exit', exited);
      });
      await terminateProcessTree(child).catch(() => undefined);
    };
    const finish = (error?: string, result?: ImageResult, diagnostics?: unknown, capabilities?: unknown, guard?: unknown): void => {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(cancelTimer); signal.removeEventListener('abort', cancel);
      if (timeoutCode && result?.images.length) {
        result = { ...result, batch: { requested: result.batch?.requested ?? request.count ?? 1, completed: result.batch?.completed ?? result.images.length, outcome: 'partial', error: timeoutCode } };
        timeoutCode = undefined; error = undefined;
      }
      const code = timeoutCode || error;
      if (code || !result) { void stopWorker().then(() => reject(Object.assign(new Error(code || 'IMAGE_WORKER_EXITED'), { diagnostics: imageConfigurationDiagnostics({ diagnostics }), capabilities: imageCapabilityDiagnostics({ capabilities }), guard: imageGuardDiagnostics({ guard }) }))); } else resolve(result);
    };
    const cancel = (): void => {
      if (settled || cancelling) return; cancelling = true; clearTimeout(timer); notifyCancel();
      // Give the worker time to stop its CLI and return already validated images.
      cancelTimer = setTimeout(() => finish(timeoutCode || 'IMAGE_CANCEL_TIMEOUT'), timeouts.cancelMs ?? 5000);
    };
    const arm = (phase?: ImageProgress['phase']): void => {
      clearTimeout(timer); if (cancelling) return;
      timer = setTimeout(() => { timeoutCode = 'IMAGE_WORKER_TIMEOUT'; cancel(); }, phase === 'generating' ? (timeouts.generationMs ?? 650_000) : (timeouts.preparationMs ?? 30_000));
    };
    signal.addEventListener('abort', cancel, { once: true });
    arm(); if (signal.aborted) cancel();
    child.on('message', (message: { kind?: string; progress?: ImageProgress; result?: ImageResult; code?: string; diagnostics?: unknown; capabilities?: unknown; guard?: unknown }) => {
      if (settled) return;
      if (message.kind === 'progress' && message.progress) { arm(message.progress.phase); if (!cancelling) progress(message.progress); }
      else if (message.kind === 'result') finish(signal.aborted && !message.result?.images.length ? 'IMAGE_CANCELLED' : undefined, message.result);
      else if (message.kind === 'error') finish(message.code || 'IMAGE_GENERATION_FAILED', undefined, message.diagnostics, message.capabilities, message.guard);
    });
    child.on('error', () => finish('IMAGE_WORKER_START_FAILED'));
    child.on('exit', () => finish(signal.aborted ? 'IMAGE_CANCELLED' : 'IMAGE_WORKER_EXITED'));
    child.on('disconnect', () => finish(signal.aborted ? 'IMAGE_CANCELLED' : 'IMAGE_WORKER_EXITED'));
    child.stdin?.on('error', () => finish('IMAGE_WORKER_START_FAILED'));
    child.stdin?.end(JSON.stringify(request)); child.unref(); child.channel?.unref();
  });
}
export const IMAGE_ERRORS: Record<string, string> = {
  IMAGE_AUTH_REQUIRED: '官方 CLI 尚未登录或认证失效。请在当前宿主终端运行 agy 自行登录，再重试。不会切换侧栏中的已保存账户。',
  IMAGE_QUOTA_EXHAUSTED: '官方报告图片配额不足。请等待恢复或检查官方账户页面；不会自动换号或启用额外额度。',
  IMAGE_NATIVE_LINUX_CLI_REQUIRED: 'Linux / WSL 图片任务必须使用当前宿主的原生 Linux agy CLI，不能使用 Windows .exe、.cmd、.bat 或 .ps1 程序。请在当前宿主安装并选择 Linux CLI。',
  IMAGE_CLI_NOT_FOUND: '找不到官方 agy。请填写当前宿主可信任的原生可执行文件绝对路径，Windows 使用 .exe。',
  IMAGE_CANCELLED: '已取消，不会发起后续请求。已发送的请求可能仍被服务端计费；取消前已保存的图片会保留。',
  IMAGE_REQUEST_INVALID: '图片选项无效。请选择 1–4 张、支持的宽高比与提示词偏好，并选择保存目录。',
  IMAGE_PROMPT_INVALID: '请填写有效的画面描述，并缩短过长的提示词。',
  IMAGE_GENERATION_FAILED: '官方图片请求未完成，后续请求已停止。本插件不会自动重试或切换账户。',
  IMAGE_TEMP_CLEANUP_FAILED: '临时工作目录清理失败，可能留有本次参考图副本。已保存图片不会删除；本批后续生成已停止。',
  IMAGE_TIMEOUT: '任务超时并已终止当前宿主 CLI。请检查官方状态；本插件不会自动重试。',
  IMAGE_EXTERNAL_CUSTOMIZATIONS_UNSUPPORTED: '当前 CLI 有尚不能与图片任务安全隔离的全局配置。请检查下方列出的位置，并在当前宿主手动停用对应的执行配置后重试；普通官方登录配置无需删除。本插件不会修改设置或登录。',
  IMAGE_PARENT_CUSTOMIZATIONS_UNSUPPORTED: '临时目录的上级含项目自定义配置，无法安全隔离。请为当前宿主临时目录使用无项目配置的位置。',
  IMAGE_TOOL_SCOPE_UNVERIFIED: '官方 CLI 的初始化结果未确认专用图片 agent、generate_image 工具或图片结果 schema，或当前权限为全部放行。未发送图片提示词；请检查所选 CLI 的 agent、JSON schema 与官方权限设置。',
  IMAGE_ACCOUNT_RECOVERY_PENDING: '存在尚未完成的账户添加或切换，请先核验或恢复登录，再生成图片。',
  IMAGE_CLI_CAPABILITY_MISSING: '当前选中的 CLI 缺少图片流程需要的功能参数，尚未提交生成。请检查下方实际 CLI 路径与缺少的参数，改用支持这些功能的官方 agy 后重试。',
  IMAGE_CLI_PROBE_FAILED: '无法读取当前 CLI 的功能信息，尚未提交生成。请检查下方实际 CLI 路径，并在当前宿主终端运行该程序的 --help，确认可以正常启动后重试。',
  IMAGE_CLI_PROBE_TIMEOUT: '检查 CLI 功能超时，尚未提交生成。请检查实际 CLI 路径是否指向官方程序，在当前宿主终端检查 --help 后重试。',
  IMAGE_CLI_VERSION_UNSUPPORTED: '无法核验当前 CLI 的图片协议。请检查 agy 路径与本次提示的功能要求后重试；不按版本号限制生成。',
  IMAGE_TRUSTED_LOCAL_DESKTOP_REQUIRED: '请使用受信任的桌面 VS Code，并在受支持的原生扩展宿主运行。支持本机原生宿主或 WSL Linux 工作区宿主；CLI、参考图与保存目录必须属于同一宿主。',
  IMAGE_GUARD_NOT_CONFIRMED: '没有收到专用图片请求保护程序的执行证明；未把 CLI 的成功文本当作图片成功。',
  IMAGE_INVALID_PNG: '文件不是受支持、可解码的 PNG。当前支持非交错 PNG，单图最多 24 MB、2400 万像素。',
  IMAGE_PNG_REQUIRED: '当前只接受 PNG 参考图与 PNG 生成产物。请先在图片编辑器导出为 PNG。',
  IMAGE_PERMISSION_DENIED: '官方 CLI 未允许本次图片工具执行。请在官方 CLI 的 /permissions 查看具体拒绝规则；无需开启全工具自动批准。',
  IMAGE_REQUEST_SCOPE_DENIED: '本次图片调用被 Workbench 的参数检查拦截。具体原因见下方；无需提供账号凭证或放开官方权限。',
  IMAGE_OUTPUT_REQUIRED: '先点击“选择保存目录”，再生成图片。',
  IMAGE_LOCAL_DIRECTORY_REQUIRED: '请选择当前宿主的原生文件夹。不能使用其他宿主的远程 URI 或路径；不会转换 Windows / WSL 路径。',
  IMAGE_LOCAL_REFERENCE_REQUIRED: '请选择当前宿主原生文件系统中的 PNG 文件，不能使用其他宿主的远程 URI 或路径。',
  IMAGE_FILE_CHANGED: '图片文件在选取后发生变化，请重新选择参考图或重新打开结果。',
  IMAGE_DIRECTORY_CHANGED: '保存目录已移动或发生变化，请重新选择保存目录。',
  IMAGE_LOCAL_IO_ERROR: '图片任务未完成。请检查当前宿主文件是否存在，以及保存目录是否可写。',
  IMAGE_WORKER_START_FAILED: '图片进程无法启动。请重新打开图片生成窗口后再试。',
  IMAGE_CONFIGURATION_TIMEOUT: '检查本机 CLI 配置超时，尚未启动图片生成。请检查当前宿主的 HOME 与配置文件是否可访问，然后重新检查并生成。',
  IMAGE_WORKER_TIMEOUT: '图片进程长时间没有进展，已请求停止。请检查当前宿主 CLI 和网络后手动重试；已提交的请求可能仍被计费，请先核对官方结果。',
  IMAGE_CANCEL_TIMEOUT: '取消等待超时，已请求停止图片进程。已提交的请求可能仍被计费；请先在官方 CLI 核对任务与保存目录，再手动重试。',
  IMAGE_WORKER_EXITED: '图片进程意外退出。请检查当前宿主 CLI 是否可以正常启动。',
  IMAGE_CLI_START_FAILED: 'agy 无法启动。请在“更多选项”中检查当前宿主 CLI 路径。',
  IMAGE_CLI_INIT_TIMEOUT: 'agy 启动超时。请先在当前宿主终端检查登录和连接，再重新生成。',
  IMAGE_CLI_INPUT_FAILED: '未能向 agy 提交提示词，请检查当前宿主 CLI 后重试。',
  IMAGE_CLI_MALFORMED_OUTPUT: 'agy 返回的流式事件或图片结果格式无法验证。本次未导入未经验证的文件；请检查当前 CLI 是否支持 stream-json 与 image_paths 结果格式后重试。',
  IMAGE_CLI_MISSING_RESULT: 'agy 没有返回完成结果，请检查当前宿主 CLI 后重试。',
  IMAGE_CLI_MISSING_IMAGE_PATH: 'agy 没有返回图片文件，尚无可预览的产物。请检查官方 CLI 结果。',
  IMAGE_GENERATION_NOT_CONFIRMED: '尚未收到图片生成成功的结果，请检查官方 CLI 状态。',
  IMAGE_CLI_OUTPUT_TOO_LARGE: 'agy 输出超过处理上限，本次已停止。请检查 CLI 是否产生了异常输出。',
  IMAGE_UNSAFE_CLI_SETTINGS: 'CLI 配置格式或文件状态不受支持，请按下方具体原因检查。无需删除普通登录配置。',
  IMAGE_SCRIPT_CONSENT_REQUIRED: 'CLI 将运行已配置的状态栏或标题脚本，需要在本次生成确认中明确允许。取消不会运行脚本，也不会生成图片。',
  IMAGE_CONFIGURATION_CHANGED: 'CLI 脚本配置在确认后已改变。本次未继续，请重新点击生成并核对确认。',
  IMAGE_HOOK_PATH_UNSUPPORTED: '扩展路径含 CLI 守卫不支持的字符，请将扩展安装到当前宿主不含特殊字符的路径后重试。',
  IMAGE_LINK_REJECTED: '不能使用链接文件作为图片，请选择实际的 PNG 文件。',
  IMAGE_UNSAFE_FILE: '图片文件的类型、大小或权限不受支持，请重新选择 PNG 文件。',
  IMAGE_PATH_OUTSIDE_OUTPUT: '图片已不在原保存目录中，请从文件管理器查看。',
  IMAGE_ARTIFACT_PATH_REJECTED: 'CLI 返回的图片路径无法验证，本次没有导入该文件。请检查官方 CLI 产物。',
  IMAGE_UNEXPECTED_TOOL: 'CLI 尝试了图片生成以外的工具，任务已停止。请检查 CLI 配置。',
};
function nativeAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && (process.platform === 'win32' || !/^(?:[a-z]:|\/[a-z]:|\\)/iu.test(value));
}
export function imageHostPath(uri: Pick<vscode.Uri, 'scheme' | 'authority' | 'fsPath' | 'path'>, extensionKind: number, remoteName?: string, distroName = process.env.WSL_DISTRO_NAME): string | undefined {
  if (isLocalFileUri(uri)) return nativeAbsolutePath(uri.fsPath) ? uri.fsPath : undefined;
  // Remote URIs are not local paths. Only the current WSL workspace process can
  // resolve its own authority, and only with an independently known distro name.
  if (process.platform !== 'linux' || extensionKind !== vscode.ExtensionKind.Workspace || remoteName !== 'wsl' || uri.scheme !== 'vscode-remote' || !distroName) return undefined;
  let distro: string;
  try { distro = decodeURIComponent(uri.authority.slice(4)); } catch { return undefined; }
  if (!uri.authority.startsWith('wsl+') || distro.toLowerCase() !== distroName.toLowerCase() || (uri.path.includes('\\') || Array.from(uri.path).some(char => char.charCodeAt(0) < 32))) return undefined;
  return nativeAbsolutePath(uri.path) ? uri.path : undefined;
}
function windowsExecutableOnLinux(value: string): boolean {
  return process.platform === 'linux' && /\.(?:exe|cmd|bat|ps1)$/iu.test(value);
}
function nativeExecutable(value: string): boolean {
  return !windowsExecutableOnLinux(value) && (/^[a-zA-Z0-9._-]+$/u.test(value) || nativeAbsolutePath(value));
}
function knownErrorCode(error: unknown): string {
  return error instanceof Error && Object.hasOwn(IMAGE_ERRORS, error.message) ? error.message : 'IMAGE_LOCAL_IO_ERROR';
}
const IMAGE_GUARD_MESSAGES: Record<ImageGuardReason, string> = {
  EVENT_SHAPE: 'CLI 的 PreToolUse 事件缺少有效 toolCall 对象。请核对当前 agy 是否支持官方 Hooks 协议。',
  TOOL_NAME: '模型尝试调用 generate_image 之外的工具，本次已拒绝。请只填写需要的画面描述。',
  ARGUMENT_SHAPE: 'toolCall.args 不是官方要求的参数对象；未尝试猜测或改写 CLI 协议。',
  UNKNOWN_ARGUMENT: '图片调用包含尚未支持的参数。官方执行说明与等待字段已兼容；尺寸、画质和张数仍不能作为图片工具参数添加。',
  FRAMEWORK_METADATA: '官方执行说明或等待字段的类型/长度不符合已核验的合同。说明应为短文本，waitForPreviousTools 应为布尔值。',
  ARGUMENT_ALIAS: '图片参数使用了非标准大小写，或同时出现重名别名。图片字段是 Prompt、ImageName、ImagePaths、AspectRatio；执行元数据也须使用官方原名。',
  PROMPT: '图片调用的 Prompt 为空、类型错误或超过长度限制。请缩短画面描述后重试。',
  IMAGE_NAME: 'ImageName 不是受支持的安全文件名。只接受最多 64 字符的英文字母、数字、空格、下划线和连字符，不接受路径、扩展名或其他特殊字符。',
  ASPECT_RATIO: '模型提交的 AspectRatio 与界面所选宽高比不一致。请检查描述中的比例要求是否与所选项冲突。',
  REFERENCE_SHAPE: 'ImagePaths 不是有效的路径数组。请重新选择参考图；无参考图时保持为空。',
  REFERENCE_COUNT: 'ImagePaths 的数量与所选参考图不一致。请通过“添加参考图”选择，不在描述里要求读取其他文件。',
  REFERENCE_PATH: 'ImagePaths 包含本次所选副本之外的路径或顺序不一致，未读取该路径。请重新选择参考图。',
  CALL_LIMIT: '模型试图在同一个单图任务中再次调用图片工具；第二次调用已拦截。',
  STATE_IO: '无法安全读写本次调用保护状态。请检查当前宿主临时目录的可用空间和访问权限。',
  INPUT_LIMIT: 'CLI 的工具事件超过诊断读取上限，本次已停止。请缩短描述并减少参考图后重试。',
};
export function imageErrorMessage(error: unknown): string {
  const code = knownErrorCode(error);
  const message = IMAGE_ERRORS[code] || '图片任务未完成。未保存未经验证的产物；可检查官方 CLI 后重新发起。';
  const diagnostics = imageConfigurationDiagnostics(error);
  const capabilities = imageCapabilityDiagnostics(error);
  const guard = imageGuardDiagnostics(error);
  return message + (guard ? `\n${IMAGE_GUARD_MESSAGES[guard.reason]}\n诊断代码：${guard.reason}\n${guard.generationAllowed === true ? '当前失败的单图任务已放行过一次图片调用，可能已消耗额度。请先核对官方结果；重新生成会创建新任务并再次确认。' : guard.generationAllowed === false ? '当前失败的单图任务尚未放行图片工具。任务已停止；重新生成会创建新任务并再次确认。' : '无法确认图片调用是否已放行。请先核对官方结果，再决定是否重新生成。'}` : '') + (capabilities ? `\n实际 CLI：${capabilities.executable}${capabilities.missingFlags.length ? `\n缺少参数：${capabilities.missingFlags.join('、')}` : ''}` : '') + diagnostics.map(issue => `\n${issue.source}${issue.key ? ` → ${issue.key}` : ''}：${issue.reason}`).join('');
}
export function registerImageUi(context: vscode.ExtensionContext, dependencies: ImageUiDependencies = {}): { getStatus(): string; getOutputDirectory(): string } {
  let panel: vscode.WebviewPanel | undefined; let disposed = false; let busy = false; let controller: AbortController | undefined;
  let generation = 0; let operation = 0; let errorCode = ''; let retryable = false; let status = '尚未生成图片'; let references: string[] = []; let outputDirectory = ''; let latest: ImageResult | undefined;
  let outputUri: vscode.Uri | undefined; let manualOutput = false;
  const hostPath = (uri: vscode.Uri): string | undefined => imageHostPath(uri, context.extension.extensionKind, vscode.env.remoteName);
  const workspaceChoices = (): { label: string; description: string; uri: vscode.Uri; directory: string }[] => (vscode.workspace.workspaceFolders || []).flatMap(folder => {
    // VS Code transforms the remote workspace's own URI to file: inside its
    // workspace extension host; desktop-side file: becomes vscode-local there.
    // Keep that native file: route. Untransformed remote URIs require an exact
    // host/distro match above; vscode-local and other schemes stay rejected.
    const directory = hostPath(folder.uri);
    return directory ? [{ label: folder.name, description: directory, uri: folder.uri, directory }] : [];
  });
  const setOutput = (uri: vscode.Uri | undefined, directory: string, manual: boolean): void => {
    const changed = directory !== outputDirectory;
    outputUri = uri; outputDirectory = directory; manualOutput = manual;
    if (changed) dependencies.outputChanged?.();
  };
  // Keep the current draft only in extension memory; never persist prompts to settings or disk.
  let draft = { prompt: '', executable: 'agy', aspectRatio: '1:1', count: 1, size: 'auto', quality: 'auto' };
  const saveDraft = (value: Record<string, unknown>): void => {
    if (typeof value.prompt === 'string' && value.prompt.length <= 12000 && typeof value.executable === 'string' && value.executable.length <= 4096 &&
      typeof value.aspectRatio === 'string' && (RATIOS as readonly string[]).includes(value.aspectRatio) && Number.isInteger(value.count) && Number(value.count) >= 1 && Number(value.count) <= 4 &&
      ['auto', '1K', '2K', '4K'].includes(String(value.size)) && ['auto', 'detail'].includes(String(value.quality))) {
      draft = { prompt: value.prompt, executable: value.executable, aspectRatio: value.aspectRatio, count: Number(value.count), size: String(value.size), quality: String(value.quality) };
    }
  };
  const run = dependencies.run || runImageWorker;
  const update = (restoreDraft = false): void => { if (panel && !disposed) void panel.webview.postMessage({ type: 'state', busy, errorCode, retryable, resultWarning: latest?.warning || '', cancellable: !!controller && !controller.signal.aborted, status, references: references.map(v => path.basename(v)), outputDirectory, ...(restoreDraft ? { draft } : {}),
    images: latest?.images.map((item, index) => ({ index, name: path.basename(item.file), width: item.width, height: item.height })) || [] }); };
  const active = (mine: number): boolean => !disposed && !!panel && mine === generation;
  const trusted = (): boolean => nativeHostStatus(context, vscode.workspace.isTrusted, vscode.env.uiKind === vscode.UIKind.Desktop, vscode.env.remoteName).available;
  let debugSpan: DebugSpan | undefined;
  const cancel = (): void => { debugSpan?.event('cancelling'); if (!controller || controller.signal.aborted) return; controller.abort(); status = '正在取消，已保存的图片会保留'; update(); };
  const handle = async (message: unknown): Promise<void> => {
    if (!message || typeof message !== 'object' || disposed || !panel) return;
    const msg = message as Record<string, unknown>;
    if (msg.type === 'ready') { update(true); return; }
    if (msg.type === 'draft') { if (!busy) saveDraft(msg); return; }
    if (msg.type === 'cancel') { cancel(); return; }
    if (busy) { update(); return; }
    if (!['references', 'clearReferences', 'output', 'preview', 'reveal', 'generate'].includes(String(msg.type))) return;
    const mine = generation; const job = ++operation; const previousStatus = status;
    busy = true; errorCode = ''; retryable = false;
    const diagnostic = msg.type === 'generate' ? beginDebugOperation('image.generate') : undefined;
    debugSpan = diagnostic;
    if (msg.type === 'generate') { controller = new AbortController(); status = '正在检查图片请求与本机配置'; }
    else if (msg.type === 'output') status = '请选择保存目录，或在文件选择窗口取消';
    else if (msg.type === 'references') status = '请选择 PNG 参考图，或在文件选择窗口取消';
    update();
    try {
      if (msg.type !== 'preview' && msg.type !== 'reveal' && !trusted()) throw new Error('IMAGE_TRUSTED_LOCAL_DESKTOP_REQUIRED');
      if (msg.type === 'references') {
        const files = await vscode.window.showOpenDialog({ title: '选择当前宿主 PNG 参考图（最多 3 张）', defaultUri: vscode.Uri.file(homedir()), canSelectMany: true, canSelectFiles: true, canSelectFolders: false, filters: { PNG: ['png'] } });
        if (!active(mine) || !files) { if (active(mine)) status = previousStatus; return; }
        if (files.some(f => !hostPath(f))) throw new Error('IMAGE_LOCAL_REFERENCE_REQUIRED');
        if (files.length > 3) throw new Error('IMAGE_REQUEST_INVALID');
        for (const file of files) await readPng(hostPath(file)!);
        if (active(mine)) { references = files.map(f => hostPath(f)!); status = `已选择 ${references.length} 张参考图`; }
      } else if (msg.type === 'clearReferences') references = [];
      else if (msg.type === 'output') {
        const files = await vscode.window.showOpenDialog({ title: '选择当前宿主保存目录', defaultUri: outputUri || vscode.Uri.file(homedir()), canSelectFiles: false, canSelectFolders: true, canSelectMany: false });
        if (!active(mine) || !files?.[0]) { if (active(mine)) status = previousStatus; return; }
        const directory = hostPath(files[0]);
        if (!directory) throw new Error('IMAGE_LOCAL_DIRECTORY_REQUIRED');
        setOutput(files[0], directory, true); status = '保存目录已选择，可以生成图片';
      } else if (msg.type === 'preview') {
        if (!Number.isInteger(msg.index)) return;
        const item = latest?.images[Number(msg.index)]; if (!item) return;
        const checked = await readPng(item.file, path.dirname(item.file));
        if (checked.info.sha256 !== item.sha256) throw new Error('IMAGE_FILE_CHANGED');
        const uri = outputUri?.scheme === 'vscode-remote' && hostPath(outputUri) ? outputUri.with({ path: item.file }) : vscode.Uri.file(item.file);
        if (active(mine)) await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
      } else if (msg.type === 'reveal') {
        const item = latest?.images[0]; if (item) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(item.file));
      } else if (msg.type === 'generate') {
        if (dependencies.accountRecoveryPending?.() || context.globalState?.get('live-switch.pending.v1', false)) throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
        if (!outputDirectory) throw new Error('IMAGE_OUTPUT_REQUIRED');
        if (typeof msg.prompt !== 'string' || typeof msg.executable !== 'string' || typeof msg.aspectRatio !== 'string') throw new Error('IMAGE_REQUEST_INVALID');
        if (windowsExecutableOnLinux(msg.executable)) throw new Error('IMAGE_NATIVE_LINUX_CLI_REQUIRED');
        if (!nativeExecutable(msg.executable)) throw new Error('IMAGE_CLI_NOT_FOUND');
        const count = msg.count === undefined ? 1 : msg.count;
        const size = msg.size === undefined ? 'auto' : msg.size;
        const quality = msg.quality === undefined ? 'auto' : msg.quality;
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 4 ||
          (size !== 'auto' && size !== '1K' && size !== '2K' && size !== '4K') || (quality !== 'auto' && quality !== 'detail')) throw new Error('IMAGE_REQUEST_INVALID');
        const request: ImageRequest = { prompt: msg.prompt, executable: msg.executable, aspectRatio: msg.aspectRatio, references: [...references], outputDirectory, count, size, quality };
        saveDraft({ ...request });
        diagnostic?.event('validating', {requestedCount: count, count: references.length});
        validateImageRequest(request); const current = controller!; status = `正在检查图片任务配置，可随时取消\n所选 CLI：${request.executable === 'agy' ? 'agy（优先当前宿主 ~/.gemini/bin/agy，再查 PATH）' : request.executable}`; update();
        diagnostic?.event('preparing');
        const review = await bounded((dependencies.reviewConfiguration || (() => reviewImageConfiguration(homedir())))(), current.signal, dependencies.configurationTimeoutMs ?? 30_000, 'IMAGE_CONFIGURATION_TIMEOUT');
        if (!active(mine)) return;
        if (!trusted()) throw new Error('IMAGE_TRUSTED_LOCAL_DESKTOP_REQUIRED');
        if (current.signal.aborted) throw new Error('IMAGE_CANCELLED');
        status = '等待本次生成确认，请在确认窗口选择；也可取消本次任务'; update();
        const accept = review.scripts.length ? '允许本次界面脚本并生成' : '确认生成';
        const scriptNotice = review.scripts.length ? ['当前官方 CLI 启动时还会运行以下已配置的本机界面脚本（它们不是图片工具守卫的一部分）：', ...review.scripts.map(script => `${script.source} → ${script.key}：${script.preview}`), '这些脚本在任务期间可能多次运行，能读写本机文件、访问网络，并可能收到 CLI 会话/账户状态；命令参数为保护隐私已隐藏。仅在您认识并信任这些配置时允许。授权只限本次最多 ' + count + ' 次 CLI 启动，不包含 hooks、MCP 或其他工具；不保存为以后授权。取消不会运行。'].join('\n') : '';
        const answer = await bounded(vscode.window.showWarningMessage([
          `生成 ${count} 张图片？`,
          '提示词和参考图将发送给 Google，使用当前宿主 CLI 当前登录账户；可能与侧栏账户不同。',
          `最多发起 ${count} 次独立图片生成，逐张串行；每次可能单独计费或消耗 AI credits。插件不自动重试或换号；官方 CLI 内部可能重试。请确认当前账户与额外用量设置。`,
          `宽高比：${request.aspectRatio} · 尺寸偏好：${size === 'auto' ? '自动' : size} · 细节偏好：${quality === 'detail' ? '更多细节' : '自动'}\n尺寸与细节仅写入提示词，不保证固定分辨率或官方画质档位。`,
          `参考图：${request.references.length ? request.references.join('；') : '无'}`, `保存目录：${request.outputDirectory}`,
          ...(scriptNotice ? [scriptNotice] : []),
          'CLI 会保留会话与图片。取消会停止后续生成，保留已保存图片；已提交的请求仍可能计费。',
        ].join('\n\n'), { modal: true }, accept), current.signal, 0, 'IMAGE_CANCELLED');
        if (active(mine) && !trusted()) throw new Error('IMAGE_TRUSTED_LOCAL_DESKTOP_REQUIRED');
        if (!active(mine) || current.signal.aborted || answer !== accept) { if (active(mine)) status = '已取消生成确认'; if (controller === current) controller = undefined; return; }
        if (dependencies.accountRecoveryPending?.() || context.globalState?.get('live-switch.pending.v1', false)) throw new Error('IMAGE_ACCOUNT_RECOVERY_PENDING');
        if (review.scripts.length) request.authorizedScripts = review.scripts.map(({ source, key, sha256 }) => ({ source, key, sha256 }));
        try {
          status = `正在准备 ${count} 张图片，逐张生成`; update();
          diagnostic?.event('spawning');
          const result = await bounded(run(request, current.signal, progress => { diagnostic?.event(progress.phase === 'checking' ? 'preparing' : progress.phase === 'starting' ? 'spawning' : progress.phase); if (active(mine) && !current.signal.aborted) { status = progress.message; update(); } }), current.signal, dependencies.workerTimeoutMs ?? count * 700_000, 'IMAGE_WORKER_TIMEOUT', dependencies.cancelTimeoutMs ?? 20_000, () => current.abort());
          if (!active(mine)) return;
          if (current.signal.aborted && !result.images.length) throw new Error('IMAGE_CANCELLED');
          latest = result;
          diagnostic?.end(current.signal.aborted || result.batch?.outcome === 'cancelled' ? 'cancelled' : result.batch?.outcome === 'partial' ? 'partial' : 'completed', {completedCount: result.batch?.completed ?? result.images.length, requestedCount: result.batch?.requested ?? count, ...(result.batch?.error ? debugErrorData(Object.assign(new Error(result.batch.error), {guard: result.batch.guard})) : {})});
          const completed = result.batch?.completed ?? result.images.length;
          const requested = result.batch?.requested ?? count;
          if (current.signal.aborted || result.batch?.outcome === 'cancelled') {
            status = `已取消；已完成 ${completed}/${requested} 次生成，已保留 ${result.images.length} 张 PNG。不会再发起生成；已提交的生成可能仍被计费。`;
          } else if (result.batch?.outcome === 'partial') {
            errorCode = knownErrorCode(new Error(result.batch.error || 'IMAGE_GENERATION_FAILED')); retryable = true;
            status = `已完成 ${completed}/${requested} 次生成，已保存 ${result.images.length} 张 PNG；后续请求已停止。${imageErrorMessage(Object.assign(new Error(result.batch.error || 'IMAGE_GENERATION_FAILED'), { diagnostics: result.batch.diagnostics, guard: result.batch.guard }))}`;
          } else status = `已完成 ${completed}/${requested} 次生成，已保存 ${result.images.length} 张 PNG。`;
        } finally { if (controller === current) controller = undefined; }
      }
    } catch (error) { const data = debugErrorData(error); diagnostic?.end(debugFailureOutcome(data.code), data); if (active(mine)) { errorCode = knownErrorCode(error); retryable = msg.type === 'generate' && errorCode !== 'IMAGE_CANCELLED'; status = imageErrorMessage(error); } }
    finally { diagnostic?.end('cancelled'); if (debugSpan === diagnostic) debugSpan = undefined; if (job === operation) { controller = undefined; busy = false; if (!active(mine)) { errorCode = ''; retryable = false; status = '前一个图片窗口的任务已结束，可重新生成；已有结果与草稿已保留'; } update(); } }
  };
  const open = (): void => {
    if (disposed) return;
    if (panel) { panel.reveal(); return; }
    generation++;
    const choices = !manualOutput && trusted() ? workspaceChoices() : [];
    let ambiguous = false;
    if (!manualOutput) {
      const current = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
      const selected = current && choices.find(choice => choice.uri === current.uri || choice.uri.toString() === current.uri.toString());
      if (selected || choices.length === 1) { const choice = selected || choices[0]!; setOutput(choice.uri, choice.directory, false); }
      else { setOutput(undefined, '', false); ambiguous = choices.length > 1; }
    }
    panel = vscode.window.createWebviewPanel('antigravityImageGeneration', 'Antigravity Workbench · 图片生成', vscode.ViewColumn.One, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] });
    panel.webview.html = imageHtml();
    const owned = panel;
    const listener = owned.webview.onDidReceiveMessage(message => { void handle(message); });
    const closed = owned.onDidDispose(() => { listener.dispose(); closed.dispose(); if (panel === owned) { panel = undefined; generation++; controller?.abort(); if (busy) { status = '图片窗口已关闭；正在等待原任务终止'; if (!controller) { operation++; busy = false; } } } });
    if (ambiguous && !busy) {
      const mine = generation; const job = ++operation; busy = true; status = '请选择图片默认保存项目，或取消后手动更改保存目录';
      void (async () => {
        try {
          const choice = await vscode.window.showQuickPick(choices, { title: '选择图片默认保存项目', placeHolder: '当前打开了多个项目，请选择本次图片保存目录' });
          if (active(mine) && choice && trusted()) { setOutput(choice.uri, choice.directory, false); status = '默认保存到所选项目，可随时更改目录'; }
        } catch { if (active(mine)) status = '请选择图片保存目录'; }
        finally { if (job === operation) { busy = false; update(); } }
      })();
    }
  };
  context.subscriptions.push(vscode.commands.registerCommand('antigravityAccounts.images.open', open), vscode.commands.registerCommand('antigravityAccounts.images.cancel', cancel),
    { dispose: () => { disposed = true; generation++; controller?.abort(); panel?.dispose(); } });
  return { getStatus: () => status, getOutputDirectory: () => outputDirectory };
}
export function imageHtml(): string {
  const nonce = randomBytes(18).toString('base64');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><meta name="viewport" content="width=device-width,initial-scale=1"><title>图片生成</title>
<style nonce="${nonce}">
body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-editor-background);max-width:820px;margin:28px auto;padding:0 24px 32px}h1{font-size:26px;margin-bottom:8px}p,small{line-height:1.65}.muted{color:var(--vscode-descriptionForeground)}label{display:block;margin:16px 0 7px;font-weight:600}textarea,input,select{box-sizing:border-box;width:100%;padding:10px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:5px;font:inherit}textarea{min-height:155px;resize:vertical}button{cursor:pointer;border:1px solid transparent;border-radius:5px;padding:9px 14px;margin:8px 8px 0 0;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font:inherit}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}button:disabled{opacity:.5;cursor:default}button:focus-visible,summary:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.row{display:flex;gap:18px;flex-wrap:wrap}.row>div{flex:1;min-width:150px}.box{margin:18px 0;padding:16px;border:1px solid var(--vscode-panel-border);border-radius:7px}.box p{margin:8px 0}.actions{margin-top:20px}#status{white-space:pre-wrap;line-height:1.7}#outputPath,#referenceNames{overflow-wrap:anywhere}#images button{display:block;text-align:left}details{margin:18px 0}summary{cursor:pointer;padding:4px 0}#formHint{margin:6px 0;font-size:12px}.error{border-color:var(--vscode-inputValidation-errorBorder,#be5858)}.error #status{color:var(--vscode-errorForeground)}#busyIndicator{color:var(--vscode-progressBar-background);font-size:12px;margin-left:10px}#busyIndicator:not([hidden]){animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{50%{opacity:.45}}@media(prefers-reduced-motion:reduce){#busyIndicator{animation:none!important}}@media(max-width:480px){body{padding:0 16px}.row{gap:0}.row>div{flex-basis:100%}}
</style></head><body>
<h1>图片生成</h1><p class="muted">使用当前扩展宿主的 agy 登录账户与 HOME。CLI、参考图和保存目录必须属于同一宿主；不会转换 Windows / WSL 路径。</p>
<label for="prompt">想生成什么？</label><textarea id="prompt" maxlength="12000" placeholder="描述主体、风格、构图、颜色；也可以选一张参考图，说明想修改的地方"></textarea>
<div class="row"><div><label for="ratio">宽高比</label><select id="ratio">${RATIOS.map(v => `<option>${v}</option>`).join('')}</select></div><div><label for="count">生成张数</label><select id="count"><option value="1">1 张</option><option value="2">2 张</option><option value="3">3 张</option><option value="4">4 张</option></select></div></div>
<div class="box"><strong>参考图（可选）</strong><p id="referenceNames" class="muted">未选择参考图</p><button id="references" class="secondary">添加参考图</button><button id="clearReferences" class="secondary" disabled>清除</button><p class="muted"><small>最多 3 张 PNG，每张不超过 24 MB</small></p>
<strong>保存目录</strong><p id="outputPath" class="muted">默认当前打开的项目目录</p><button id="output" class="secondary">更改保存目录</button><p class="muted"><small>默认当前项目；多个项目时优先当前文件所属项目。未打开项目时请选择文件夹</small></p></div>
<details><summary>更多选项</summary><label for="executable">当前宿主 agy 路径</label><input id="executable" value="agy" maxlength="4096" spellcheck="false"><p class="muted"><small>默认优先当前宿主 ~/.gemini/bin/agy，再从 PATH 查找。找不到时填写完整路径；Windows 选 agy.exe，Linux / WSL 选原生 Linux agy，不可使用 Windows 程序</small></p>
<div class="row"><div><label for="size">尺寸偏好（提示词）</label><select id="size"><option value="auto">自动</option><option value="1K">1K</option><option value="2K">2K</option><option value="4K">4K</option></select></div><div><label for="quality">细节偏好（提示词）</label><select id="quality"><option value="auto">自动</option><option value="detail">更多细节</option></select></div></div><p class="muted"><small>尺寸与细节仅写入提示词，不保证固定分辨率或官方画质档位。结果中会显示实际像素尺寸</small></p></details>
<div class="actions"><button id="generate" disabled>生成 1 张图片</button><button id="cancel" class="secondary" disabled>取消任务</button><p id="formHint" class="muted">填写画面描述并选择保存目录</p></div>
<div id="statusBox" class="box"><strong>任务状态</strong><span id="busyIndicator" hidden>处理中…</span><p id="status" role="status" aria-live="polite">尚未生成图片</p><button id="retry" class="secondary" hidden>重新检查并生成</button><button id="refreshStatus" class="secondary">刷新状态</button><div id="images"></div><button id="reveal" class="secondary" hidden>在文件夹中显示</button><details id="resultNotes" hidden><summary>生成说明</summary><p id="resultWarning" class="muted"></p></details></div>
<script nonce="${nonce}">
const api=acquireVsCodeApi();const el=id=>document.getElementById(id);let busy=false,outputDirectory='',referenceCount=0,cancellable=false,errorCode='',retryable=false;
const form=()=>({prompt:el('prompt').value,aspectRatio:el('ratio').value,executable:el('executable').value,count:Number(el('count').value),size:el('size').value,quality:el('quality').value});
const updateControls=()=>{el('generate').textContent=(busy?'处理中 · ':'生成 ')+el('count').value+' 张图片';for(const id of ['references','output','prompt','ratio','executable','count','size','quality','reveal'])el(id).disabled=busy;el('clearReferences').disabled=busy||!referenceCount;el('cancel').disabled=!cancellable;const missing=!el('prompt').value.trim()?'填写画面描述':!outputDirectory?'选择保存目录':!el('executable').value.trim()?'填写当前宿主 agy 路径':'';el('generate').disabled=busy||!!missing;el('retry').hidden=busy||!retryable;el('retry').disabled=busy||!!missing;el('busyIndicator').hidden=!busy;el('statusBox').className='box'+(errorCode&&errorCode!=='IMAGE_CANCELLED'?' error':'');el('formHint').textContent=busy?(cancellable?'任务处理中，可取消；下方显示当前进度':'正在等待当前操作结束；下方显示状态'):missing||'逐张生成；提交前会确认账户与费用'};
const save=()=>{api.postMessage({type:'draft',...form()});updateControls()};
for(const id of ['prompt','executable'])el(id).oninput=save;for(const id of ['ratio','count','size','quality'])el(id).onchange=save;
const send=(type,extra={})=>{if(busy)return;busy=true;cancellable=type==='generate';errorCode='';el('status').textContent=type==='generate'?'已收到生成请求，正在检查本机配置…':type==='output'?'正在打开保存目录选择窗口…':type==='references'?'正在打开参考图选择窗口…':type==='preview'?'正在验证并打开图片…':'正在处理…';updateControls();api.postMessage({type,...extra})};
for(const type of ['references','clearReferences','output','reveal'])el(type).onclick=()=>send(type);
el('cancel').onclick=()=>{if(!cancellable)return;cancellable=false;el('status').textContent='正在取消，已保存的图片会保留';updateControls();api.postMessage({type:'cancel'})};
el('generate').onclick=()=>{if(el('generate').disabled||busy)return;send('generate',form())};
el('retry').onclick=()=>{if(el('retry').disabled||busy)return;send('generate',form())};
el('refreshStatus').onclick=()=>api.postMessage({type:'ready'});
window.addEventListener('message',event=>{const s=event.data;if(s.type!=='state')return;if(s.draft){for(const [id,key]of [['prompt','prompt'],['ratio','aspectRatio'],['executable','executable'],['count','count'],['size','size'],['quality','quality']])el(id).value=String(s.draft[key])}busy=s.busy;cancellable=!!s.cancellable;errorCode=s.errorCode||'';retryable=!!s.retryable;outputDirectory=s.outputDirectory;referenceCount=s.references.length;el('status').textContent=s.status;el('referenceNames').textContent=s.references.join(' · ')||'未选择参考图';el('outputPath').textContent=outputDirectory||'请选择保存目录';el('reveal').hidden=!s.images.length;el('images').replaceChildren();for(const image of s.images){const b=document.createElement('button');b.className='secondary';b.disabled=busy;b.textContent='预览 '+image.name+' · '+image.width+' × '+image.height;b.onclick=()=>send('preview',{index:image.index});el('images').append(b)}el('resultNotes').hidden=!s.resultWarning;el('resultWarning').textContent=s.resultWarning||'';updateControls()});
updateControls();api.postMessage({type:'ready'});
</script></body></html>`;
}
