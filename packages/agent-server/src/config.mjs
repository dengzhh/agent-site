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

// 会话相关配置。默认值与 pi CLI / CC 自己的约定对齐，用户不改任何配置即可互通。
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionTtlMs() {
  const days = Number(process.env.ATBX_SESSION_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days * 86400_000 : DEFAULT_SESSION_TTL_MS;
}

// 会话转录的落盘目录（网关与 CLI 共用，CLI 用 ATBX_SESSION_DIR 指向同一处）。
export function sessionStoreDir() {
  return process.env.ATBX_SESSION_DIR
    ?? join(homedir(), '.config', 'agenttoolbox', 'sessions');
}

// 网站开的 pi 会话镜像到这个目录，本机 `pi --session-dir <此处> --session <id>` 打开。
// 缺省用 pi CLI 自己的默认位置，保证开箱互通。
export function piSessionDir() {
  return process.env.ATBX_PI_SESSION_DIR
    ?? join(homedir(), '.pi', 'agent', 'sessions');
}
