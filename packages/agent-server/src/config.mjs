// 网关自有配置（与用户的 Claude 配置完全隔离）。
// 默认位置：~/.config/agenttoolbox/config.json（可用 ATBX_CONFIG_PATH 覆盖，
// 供测试与 CLI 子命令重定向）。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_CONFIG_PATH =
  process.env.ATBX_CONFIG_PATH ?? join(homedir(), '.config', 'agenttoolbox', 'config.json');

// 文件缺失、损坏、或形状不对 → 一律回退到空配置，绝不抛
export function loadConfig(configPath = DEFAULT_CONFIG_PATH) {
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    return { grantedDirs: Array.isArray(raw?.grantedDirs) ? raw.grantedDirs : [] };
  } catch {
    return { grantedDirs: [] };
  }
}

function save(configPath, cfg) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');
}

export function grantDir(targetDir, configPath = DEFAULT_CONFIG_PATH) {
  const cfg = loadConfig(configPath);
  if (!cfg.grantedDirs.includes(targetDir)) cfg.grantedDirs.push(targetDir);
  save(configPath, cfg);
  return cfg.grantedDirs;
}

export function revokeDir(targetDir, configPath = DEFAULT_CONFIG_PATH) {
  const cfg = loadConfig(configPath);
  cfg.grantedDirs = cfg.grantedDirs.filter((d) => d !== targetDir);
  save(configPath, cfg);
  return cfg.grantedDirs;
}
