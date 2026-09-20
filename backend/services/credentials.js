import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * 从 DSH 凭证文件（~/.dsh/.credentials.yaml）读取 API Keys + 用户环境变量，
 * 用于注入 headless 进程（LocalSystem 上下文下 DSH 找不到用户目录）。
 */
export function readDshCredentials() {
  const profile = config.dsh.userProfile || '';
  if (!profile) return {};

  // 用户环境（让 DSH 能定位 .dsh 目录）
  const drive = (profile.match(/^[A-Za-z]:/) || ['C:'])[0];
  const env = {
    HOME: profile,
    USERPROFILE: profile,
    HOMEDRIVE: drive + '\\',
    HOMEPATH: profile.replace(/^[A-Za-z]:\\?/, '\\') || '\\',
    LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
    APPDATA: path.join(profile, 'AppData', 'Roaming'),
    npm_config_cache: path.join(profile, 'AppData', 'Local', 'npm-cache'),
  };

  // 解析 .credentials.yaml 的 refs 节，提取所有 *_API_KEY
  const credFile = path.join(profile, '.dsh', '.credentials.yaml');
  try {
    const content = fs.readFileSync(credFile, 'utf8');
    const lines = content.split(/\r?\n/);
    let inRefs = false;
    for (const line of lines) {
      if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
      if (inRefs && line.trim() !== '' && !line.startsWith(' ')) break; // 退出 refs 节
      if (inRefs && line.trim() !== '') {
        const m = /^\s{2,}([A-Z][A-Z0-9_]+):\s*(.+?)\s*$/.exec(line);
        if (m) {
          let val = m[2];
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          env[m[1]] = val;
        }
      }
    }
  } catch { /* 凭证文件不存在，仅返回用户环境 */ }

  return env;
}
