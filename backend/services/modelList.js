import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * 读取 DSH 设置文件，提取可用模型列表 + 当前默认模型标记。
 */
export function getAvailableModels() {
  const profile = config.dsh.userProfile || '';
  if (!profile) return [];

  const settingsFile = path.join(profile, '.dsh', 'settings.yaml');
  try {
    const content = fs.readFileSync(settingsFile, 'utf8');
    const lines = content.split(/\r?\n/);

    // 第一步：找 agent-default-model
    let defaultProvider = '';
    let defaultModel = '';
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === 'agent-default-model:') {
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const l = lines[j];
          if (/^  provider:\s*(.+)$/.test(l)) defaultProvider = l.match(/^  provider:\s*(.+)$/)[1].trim();
          if (/^  model:\s*(.+)$/.test(l)) defaultModel = l.match(/^  model:\s*(.+)$/)[1].trim();
        }
        break;
      }
    }

    // 第二步：解析 llm-pi-ai.providers 节
    const models = [];
    let inLLM = false, inProviders = false;
    let prov = '', inModels = false;

    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trimEnd();

      if (l === 'llm-pi-ai:') { inLLM = true; continue; }
      if (inLLM && l === '  providers:') { inProviders = true; continue; }

      // 退出 providers 节（遇到非缩进行）
      if (inProviders && l && !lines[i].startsWith('    ') && !lines[i].startsWith('  ')) {
        inProviders = false;
        continue;
      }

      if (!inProviders) continue;

      // 新提供商（4空格缩进）
      const pm = /^    ([a-z][a-z0-9_-]*):/.exec(l);
      if (pm) { prov = pm[1]; inModels = false; continue; }

      // 进入 models 列表（6空格缩进）
      if (prov && l === '      models:') { inModels = true; continue; }
      if (prov && inModels && lines[i].startsWith('      ') && !lines[i].startsWith('        ')) {
        inModels = false;
        continue;
      }

      // 提取模型 ID（8空格缩进的 - id:）
      if (prov && inModels) {
        const mm = /^        - id:\s*(.+?)\s*$/.exec(l);
        if (mm) {
          const id = mm[1];
          let name = id;
          if (i + 1 < lines.length) {
            const nm = /^          name:\s*(.+?)\s*$/.exec(lines[i + 1]);
            if (nm) name = nm[1];
          }
          models.push({
            provider: prov,
            model: id,
            name,
            label: prov + ' / ' + name,
            free: /:free$|-free$/.test(id),
            current: (prov === defaultProvider && id === defaultModel)
          });
        }
      }
    }

    return models;
  } catch {
    return [];
  }
}
