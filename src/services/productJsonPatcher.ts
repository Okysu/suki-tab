import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ILogger } from '../context/contracts';

/**
 * product.json 修补工具
 * 用于启动时检测和启用 VS Code proposed API
 */

// 存储键：用户是否选择忽略 API 提案检查
const IGNORE_PROPOSAL_CHECK_KEY = 'sukiTab.ignoreProposalCheck';

export interface PatchResult {
  success: boolean;
  message: string;
  path?: string;
  error?: unknown;
}

interface ProductJson {
  extensionEnabledApiProposals?: Record<string, string[]>;
  [k: string]: unknown;
}

/**
 * 获取候选的 product.json 路径
 */
function getCandidateProductJsonPaths(): string[] {
  const appRoot = vscode.env.appRoot;
  const candidates = [
    path.join(appRoot, 'product.json'),
    path.join(appRoot, 'resources', 'app', 'product.json'),
    path.join(path.dirname(appRoot), 'resources', 'app', 'product.json'),
  ];
  return Array.from(new Set(candidates));
}

/**
 * 查找第一个存在的路径
 */
async function firstExistingPath(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await fs.access(p);
      return p;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * 检测是否为权限错误
 */
function isPermissionError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }
  const code = (err as { code?: string }).code;
  return code === 'EACCES' || code === 'EPERM';
}

/**
 * 尝试普通权限修改 product.json
 */
async function tryNormalPatch(
  extensionId: string,
  proposals: string[],
  logger: ILogger
): Promise<PatchResult> {
  try {
    const productPath = await firstExistingPath(getCandidateProductJsonPaths());
    if (!productPath) {
      return { success: false, message: '未找到 product.json 路径' };
    }

    logger.info(`[ProductJsonPatcher] 找到 product.json: ${productPath}`);

    const content = await fs.readFile(productPath, 'utf8');
    const product: ProductJson = JSON.parse(content);

    if (!product.extensionEnabledApiProposals) {
      product.extensionEnabledApiProposals = {};
    }

    const current = product.extensionEnabledApiProposals[extensionId] ?? [];
    const next = Array.from(new Set([...current, ...proposals]));

    // 检查是否需要修改
    if (current.length === next.length && current.every((v, i) => v === next[i])) {
      return { success: true, message: '已启用所需 API Proposals（无需更改）', path: productPath };
    }

    // 更新并写入
    product.extensionEnabledApiProposals[extensionId] = next;
    
    // 创建备份
    const backup = `${productPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fs.copyFile(productPath, backup).catch(() => {}); // 忽略备份失败
    
    // 写入新内容
    const newContent = JSON.stringify(product, null, 2) + '\n';
    await fs.writeFile(productPath, newContent, 'utf8');
    
    logger.info(`[ProductJsonPatcher] 成功修改 product.json，备份: ${backup}`);
    return { success: true, message: '已修改 product.json 并创建备份', path: productPath };
  } catch (err) {
    logger.error('[ProductJsonPatcher] 普通权限修改失败', err);
    return { 
      success: false, 
      message: isPermissionError(err) ? '需要管理员权限' : '修改失败', 
      error: err 
    };
  }
}

/**
 * 使用提升权限修改 product.json
 */
async function tryElevatedPatch(
  extensionId: string,
  proposals: string[],
  logger: ILogger
): Promise<PatchResult> {
  logger.info('[ProductJsonPatcher] 开始尝试权限提升修改 product.json');

  // 动态导入 @vscode/sudo-prompt
  const sudo = require('@vscode/sudo-prompt') as {
    exec: (command: string, options: { name: string }, callback: (error: Error | undefined, stdout: string | Buffer | undefined, stderr: string | Buffer | undefined) => void) => void;
  };

  return new Promise(async (resolve) => {
    try {
      const productPath = await firstExistingPath(getCandidateProductJsonPaths());
      if (!productPath) {
        resolve({ success: false, message: '未找到 product.json 路径' });
        return;
      }

      const content = await fs.readFile(productPath, 'utf8');
      const product: ProductJson = JSON.parse(content);

      if (!product.extensionEnabledApiProposals) {
        product.extensionEnabledApiProposals = {};
      }

      const current = product.extensionEnabledApiProposals[extensionId] ?? [];
      const next = Array.from(new Set([...current, ...proposals]));

      if (current.length === next.length && current.every((v, i) => v === next[i])) {
        resolve({ success: true, message: '已启用所需 API Proposals（无需更改）', path: productPath });
        return;
      }

      product.extensionEnabledApiProposals[extensionId] = next;
      const newContent = JSON.stringify(product, null, 2) + '\n';
      const backupPath = `${productPath}.bak.${new Date().toISOString().replace(/[:.]/g, '-')}`;

      // 先写入临时文件
      const tempPath = path.join(os.tmpdir(), `product-${Date.now()}.json`);
      await fs.writeFile(tempPath, newContent, 'utf8');
      logger.info(`[ProductJsonPatcher] 临时文件: ${tempPath}`);

      // 构建跨平台复制命令
      const platform = process.platform;
      let command: string;

      if (platform === 'win32') {
        const escapedProductPath = productPath.replace(/'/g, "''");
        const escapedBackupPath = backupPath.replace(/'/g, "''");
        const escapedTempPath = tempPath.replace(/'/g, "''");

        command = `powershell -Command "try { Copy-Item '${escapedProductPath}' '${escapedBackupPath}' -ErrorAction SilentlyContinue; Copy-Item '${escapedTempPath}' '${escapedProductPath}' -Force } catch { Write-Host 'ERROR:' $_.Exception.Message }"`;
      } else {
        const escapedProductPath = productPath.replace(/'/g, "'\"'\"'");
        const escapedBackupPath = backupPath.replace(/'/g, "'\"'\"'");
        const escapedTempPath = tempPath.replace(/'/g, "'\"'\"'");

        command = `sh -c "cp '${escapedProductPath}' '${escapedBackupPath}' 2>/dev/null || true && cp '${escapedTempPath}' '${escapedProductPath}'"`;
      }

      logger.info('[ProductJsonPatcher] 执行权限提升命令...');

      sudo.exec(command, { name: 'SukiTab VS Code Configuration' }, async (error, stdout, stderr) => {
        // 清理临时文件
        try {
          await fs.unlink(tempPath);
        } catch {
          // 忽略清理失败
        }

        if (error) {
          logger.error('[ProductJsonPatcher] 权限提升失败', error);
          resolve({ success: false, message: '获取管理员权限失败或用户取消操作', error });
          return;
        }

        // 检查是否有错误输出
        if (stderr && String(stderr).includes('ERROR:')) {
          logger.error(`[ProductJsonPatcher] 修改错误: ${stderr}`);
          resolve({ success: false, message: '修改时发生错误', error: new Error(String(stderr)) });
        } else {
          logger.info('[ProductJsonPatcher] product.json 修改成功！');
          resolve({ success: true, message: '已成功修改 product.json 并创建备份', path: productPath });
        }
      });
    } catch (error) {
      resolve({ success: false, message: '修改失败', error });
    }
  });
}

/**
 * 检查 API 提案是否已启用
 */
export async function checkApiProposals(
  extensionId: string,
  proposals: string[]
): Promise<{ ok: boolean; path?: string; reason?: string }> {
  const productPath = await firstExistingPath(getCandidateProductJsonPaths());
  if (!productPath) {return { ok: false, reason: '找不到 product.json' };}

  try {
    const content = await fs.readFile(productPath, 'utf8');
    const product: ProductJson = JSON.parse(content);
    const enabled = product.extensionEnabledApiProposals?.[extensionId] ?? [];
    const ok = proposals.every(p => enabled.includes(p));
    return { ok, path: productPath, reason: ok ? undefined : '缺少所需 API Proposals' };
  } catch (err) {
    return { ok: false, path: productPath, reason: '读取或解析失败' };
  }
}

/**
 * 启动时检查并提示用户启用 proposed API
 */
export async function checkAndPromptProposedApiOnStartup(
  context: vscode.ExtensionContext,
  extensionId: string,
  proposals: string[],
  logger: ILogger
): Promise<void> {
  logger.info('[ProductJsonPatcher] 启动时检查 proposed API 状态');

  // 检查用户是否已选择忽略
  const ignoreCheck = context.globalState.get<boolean>(IGNORE_PROPOSAL_CHECK_KEY, false);
  if (ignoreCheck) {
    logger.info('[ProductJsonPatcher] 用户已选择忽略 API 提案检查');
    return;
  }

  // 检查是否已经启用
  const check = await checkApiProposals(extensionId, proposals);
  if (check.ok) {
    logger.info('[ProductJsonPatcher] Proposed API 已启用，无需修改');
    return;
  }

  logger.warn(`[ProductJsonPatcher] Proposed API 未启用: ${check.reason}`);

  // 显示提示
  const selection = await vscode.window.showWarningMessage(
    '🚀 SukiTab 需要启用 VS Code Proposed API 才能提供完整功能（如内联编辑等）。\n\n是否要启用？这需要修改 VS Code 的 product.json 文件。',
    '启用（需要管理员权限）',
    '稍后提醒',
    '不再提示'
  );

  if (selection === '不再提示') {
    await context.globalState.update(IGNORE_PROPOSAL_CHECK_KEY, true);
    logger.info('[ProductJsonPatcher] 用户选择不再提示');
    return;
  }

  if (selection === '稍后提醒') {
    logger.info('[ProductJsonPatcher] 用户选择稍后提醒');
    return;
  }

  if (selection !== '启用（需要管理员权限）') {return;}

  // 用户选择启用 - 先尝试普通权限
  logger.info('[ProductJsonPatcher] 用户选择启用，开始修改流程');

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: '正在启用 Proposed API...',
    cancellable: false
  }, async (progress) => {
    // 先尝试普通权限
    progress.report({ message: '尝试修改 product.json...' });
    const normalResult = await tryNormalPatch(extensionId, proposals, logger);
    
    if (normalResult.success) {
      logger.info('[ProductJsonPatcher] 普通权限修改成功');
      await showRestartPrompt(normalResult.message);
      return;
    }

    // 如果是权限错误，尝试提升权限
    if (isPermissionError(normalResult.error)) {
      progress.report({ message: '请在系统对话框中确认管理员权限...' });
      const elevatedResult = await tryElevatedPatch(extensionId, proposals, logger);
      
      if (elevatedResult.success) {
        logger.info('[ProductJsonPatcher] 权限提升修改成功');
        await showRestartPrompt(elevatedResult.message);
      } else {
        logger.error('[ProductJsonPatcher] 权限提升修改失败');
        vscode.window.showErrorMessage(`❌ ${elevatedResult.message}`);
      }
    } else {
      vscode.window.showErrorMessage(`❌ ${normalResult.message}`);
    }
  });
}

/**
 * 显示重启提示
 */
async function showRestartPrompt(message: string): Promise<void> {
  const selection = await vscode.window.showInformationMessage(
    `✅ ${message}\n\n需要重新加载窗口才能使更改生效。`,
    '立即重新加载',
    '稍后'
  );

  if (selection === '立即重新加载') {
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

/**
 * 重置忽略状态（用于用户想重新启用检查）
 */
export async function resetIgnoreProposalCheck(context: vscode.ExtensionContext): Promise<void> {
  await context.globalState.update(IGNORE_PROPOSAL_CHECK_KEY, false);
}

/**
 * 在激活函数最开头调用的检查函数
 * 返回 true 表示可以继续激活，false 表示应该停止激活
 */
export async function ensureProposedApiEnabled(
  context: vscode.ExtensionContext,
  extensionId: string,
  proposals: string[],
  logger?: ILogger
): Promise<boolean> {
  const log = (msg: string) => logger?.info(msg) ?? console.log(msg);
  const logWarn = (msg: string) => logger?.warn(msg) ?? console.warn(msg);
  const logError = (msg: string, err?: unknown) => logger?.error(msg, err) ?? console.error(msg, err);

  log('[ProductJsonPatcher] 启动时检查 proposed API 状态（前置检查）');

  // 检查用户是否已选择忽略
  const ignoreCheck = context.globalState.get<boolean>(IGNORE_PROPOSAL_CHECK_KEY, false);
  if (ignoreCheck) {
    log('[ProductJsonPatcher] 用户已选择忽略 API 提案检查，尝试继续激活');
    return true;
  }

  // 检查是否已经启用
  const check = await checkApiProposals(extensionId, proposals);
  if (check.ok) {
    log('[ProductJsonPatcher] Proposed API 已在 product.json 中启用');
    return true;
  }

  logWarn(`[ProductJsonPatcher] Proposed API 未启用: ${check.reason}`);

  // 显示提示
  const selection = await vscode.window.showWarningMessage(
    '🚀 SukiTab 需要启用 VS Code Proposed API 才能正常工作。\n\n需要修改 VS Code 的 product.json 文件以启用 inlineCompletionsAdditions API。',
    '启用（需要管理员权限）',
    '稍后提醒',
    '不再提示'
  );

  if (selection === '不再提示') {
    await context.globalState.update(IGNORE_PROPOSAL_CHECK_KEY, true);
    log('[ProductJsonPatcher] 用户选择不再提示，扩展将尝试继续激活（可能失败）');
    return true; // 让扩展尝试激活，可能会失败但用户选择了忽略
  }

  if (selection === '稍后提醒') {
    log('[ProductJsonPatcher] 用户选择稍后提醒，扩展将停止激活');
    vscode.window.showInformationMessage('SukiTab 未激活。请稍后通过命令面板运行 "SukiTab: Enable Proposed API" 来启用。');
    return false;
  }

  if (selection !== '启用（需要管理员权限）') {
    log('[ProductJsonPatcher] 用户取消了对话框，扩展将停止激活');
    return false;
  }

  // 用户选择启用
  log('[ProductJsonPatcher] 用户选择启用，开始修改流程');

  let success = false;

  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: '正在启用 Proposed API...',
    cancellable: false
  }, async (progress) => {
    // 先尝试普通权限
    progress.report({ message: '尝试修改 product.json...' });
    
    // 创建临时 logger（满足 ILogger 接口）
    const tempLogger: ILogger = {
      info: log,
      warn: logWarn,
      error: logError,
      dispose: () => {}
    };
    
    const normalResult = await tryNormalPatch(extensionId, proposals, tempLogger);
    
    if (normalResult.success) {
      log('[ProductJsonPatcher] 普通权限修改成功');
      success = true;
      await showRestartPrompt(normalResult.message);
      return;
    }

    // 如果是权限错误，尝试提升权限
    if (isPermissionError(normalResult.error)) {
      progress.report({ message: '请在系统对话框中确认管理员权限...' });
      const elevatedResult = await tryElevatedPatch(extensionId, proposals, tempLogger);
      
      if (elevatedResult.success) {
        log('[ProductJsonPatcher] 权限提升修改成功');
        success = true;
        await showRestartPrompt(elevatedResult.message);
      } else {
        logError('[ProductJsonPatcher] 权限提升修改失败');
        vscode.window.showErrorMessage(`❌ ${elevatedResult.message}`);
      }
    } else {
      vscode.window.showErrorMessage(`❌ ${normalResult.message}`);
    }
  });

  // 如果修改成功，会触发重启，返回 false 阻止继续激活
  // 如果修改失败，也返回 false
  return false;
}
