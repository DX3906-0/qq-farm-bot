/**
 * Windows 系统代理自动管理
 *
 * 抓包开始时自动设置系统代理为 127.0.0.1:<port>，抓包结束/取消时自动恢复。
 * 通过注册表操作 + 广播 WM_SETTINGCHANGE 使设置立即生效。
 *
 * 仅在 Windows 平台生效，macOS/Linux 上所有方法均为空操作。
 */

const os = require('node:os');
const { execSync, execFileSync } = require('node:child_process');

const REG_PATH = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const isWindows = os.platform() === 'win32';

/** 保存的原始代理状态，恢复时使用 */
let savedState = null;

/**
 * 读取当前系统代理状态
 * @returns {{ enabled: boolean, server: string, bypass: string } | null}
 */
function readCurrentProxy() {
  if (!isWindows) return null;
  try {
    const enabledRaw = execSync(
      `reg query "${REG_PATH}" /v ProxyEnable`,
      { encoding: 'utf8', windowsHide: true },
    );
    const enabled = /0x1\b/i.test(enabledRaw);

    let server = '';
    let bypass = '';
    try {
      const serverRaw = execSync(
        `reg query "${REG_PATH}" /v ProxyServer`,
        { encoding: 'utf8', windowsHide: true },
      );
      const match = serverRaw.match(/REG_SZ\s+(.+)/i);
      if (match) server = match[1].trim();
    } catch { /* 未配置 */ }

    try {
      const bypassRaw = execSync(
        `reg query "${REG_PATH}" /v ProxyOverride`,
        { encoding: 'utf8', windowsHide: true },
      );
      const match = bypassRaw.match(/REG_SZ\s+(.+)/i);
      if (match) bypass = match[1].trim();
    } catch { /* 未配置 */ }

    return { enabled, server, bypass };
  } catch {
    return { enabled: false, server: '', bypass: '' };
  }
}

/**
 * 广播系统设置变更，使代理设置立即生效
 */
function broadcastSettingsChange() {
  if (!isWindows) return;
  try {
    // 使用 PowerShell 调用 user32.dll SendMessageTimeout 广播 WM_SETTINGCHANGE
    execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$s=@'
[DllImport("user32.dll")]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@; Add-Type -MemberDefinition $s -Name Win32 -Namespace User32 -ErrorAction SilentlyContinue; [User32.Win32]::SendMessageTimeout(0xffff, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref][UIntPtr]::Zero) | Out-Null`,
    ], { windowsHide: true, timeout: 8000 });
  } catch {
    // 广播失败不影响主流程，代理设置在下次应用启动时生效
  }
}

/**
 * 设置系统代理并保存原始状态
 * @param {string} host - 代理地址（如 127.0.0.1）
 * @param {number} port - 代理端口
 * @param {string} [extraBypass] - 额外绕过地址（如 localhost）
 */
function enable(host, port, extraBypass = '') {
  if (!isWindows) return;
  if (savedState) return; // 已经是代理状态，避免重复保存

  savedState = readCurrentProxy();

  const bypassList = ['<local>'];
  if (extraBypass) bypassList.push(extraBypass);
  const bypass = bypassList.join(';');

  try {
    execSync(
      `reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 1 /f`,
      { windowsHide: true },
    );
    execSync(
      `reg add "${REG_PATH}" /v ProxyServer /t REG_SZ /d "${host}:${port}" /f`,
      { windowsHide: true },
    );
    execSync(
      `reg add "${REG_PATH}" /v ProxyOverride /t REG_SZ /d "${bypass}" /f`,
      { windowsHide: true },
    );
    broadcastSettingsChange();
  } catch (error) {
    // 恢复失败时尝试回滚
    savedState = null;
    throw error;
  }
}

/**
 * 恢复原始系统代理状态
 */
function disable() {
  if (!isWindows) return;
  if (!savedState) return;

  const state = savedState;
  savedState = null;

  try {
    execSync(
      `reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d ${state.enabled ? 1 : 0} /f`,
      { windowsHide: true },
    );
    if (state.server) {
      execSync(
        `reg add "${REG_PATH}" /v ProxyServer /t REG_SZ /d "${state.server}" /f`,
        { windowsHide: true },
      );
    } else {
      execSync(
        `reg delete "${REG_PATH}" /v ProxyServer /f`,
        { windowsHide: true },
      );
    }
    if (state.bypass) {
      execSync(
        `reg add "${REG_PATH}" /v ProxyOverride /t REG_SZ /d "${state.bypass}" /f`,
        { windowsHide: true },
      );
    } else {
      try {
        execSync(
          `reg delete "${REG_PATH}" /v ProxyOverride /f`,
          { windowsHide: true },
        );
      } catch { /* 原本就没有 */ }
    }
    broadcastSettingsChange();
  } catch {
    // 恢复失败：至少确保代理关闭
    try {
      execSync(
        `reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 0 /f`,
        { windowsHide: true },
      );
      broadcastSettingsChange();
    } catch { /* 尽力了 */ }
  }
}

/**
 * 强制关闭代理（不依赖 savedState），用于进程退出时兜底。
 */
function forceDisable() {
  if (!isWindows) return;
  // 如果 savedState 存在，用 disable() 精确恢复；否则直接关掉代理
  if (savedState) {
    disable();
    return;
  }
  try {
    execSync(
      `reg add "${REG_PATH}" /v ProxyEnable /t REG_DWORD /d 0 /f`,
      { windowsHide: true },
    );
    broadcastSettingsChange();
  } catch { /* 尽力 */ }
}

module.exports = {
  enable,
  disable,
  forceDisable,
  isWindows: () => isWindows,
};