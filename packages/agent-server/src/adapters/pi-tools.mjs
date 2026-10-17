// pi 只读工具（期 1）：read_file / list_dir / grep。
// 硬边界：所有路径 resolve + realpath 后必须落在 cwd 内（同时防 ../ 穿越与符号链接
// 逃逸）；grep 跳过依赖/隐藏目录、单文件 1MB 上限、最多 50 条匹配。
// 错误一律捕获后以 isError 结果返回（而不是抛给 agent loop），消息里不泄漏 cwd
// 绝对路径。写/执行工具在期 2 另行实现并接入抽屉确认流。
import { promises as fs, realpathSync } from 'node:fs';
import { join as pathJoin, resolve, sep } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', 'dist', 'build', '.next', '__pycache__']);
const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_GREP_MATCHES = 50;
// ReDoS 防护：恶意正则的灾难性回溯随输入长度指数增长，同步执行无法中断——
// 用时间预算硬性截断（超时返回部分结果），避免网站用户卡死单线程网关。
export const GREP_BUDGET_MS = 5000;

// 路径硬边界：两层检查——
// ① 词法检查（realpath 之前）：穿越路径（../、绝对路径）resolve 后不在 base 内就立刻
//    拒绝。必须先行，否则不存在的穿越目标在 realpath 就抛 ENOENT，逃逸被错误掩盖；
// ② realpath 检查：base 本身也 realpath（macOS 的 /tmp 是 /private/tmp 的链接，直接
//    前缀比较会误判），cwd 内的符号链接指向外部时在此被挡下。目标不存在时无链接可解，
//    realpath 抛 ENOENT（err.realpath 已附原路径）——对只读工具足够（读/列/搜都以
//    存在为前提）。
// 已知局限：指向 cwd 外文件的硬链接无法用 realpath 识别（读工具的写场景才危险，
// 期 2 的写工具需另行处理）。
export function confine(cwd, relPath) {
  const baseReal = realpath(cwd);
  const abs = resolve(baseReal, String(relPath ?? ''));
  if (abs !== baseReal && !abs.startsWith(baseReal + sep)) {
    throw new Error(`path escapes working directory: ${relPath}`);
  }
  const absReal = realpath(abs);
  if (absReal !== baseReal && !absReal.startsWith(baseReal + sep)) {
    throw new Error(`path escapes working directory: ${relPath}`);
  }
  return absReal;
}

// 同步 realpath，失败时把原始路径挂在错误上（ENOENT 等情形调用方可定位到具体路径）
function realpath(p) {
  try { return realpathSync(p); } catch (err) { err.realpath = p; throw err; }
}

// 错误转模型可见文本：抹去 cwd 绝对路径（Node 的 fs 错误消息里带绝对路径，
// 泄漏到聊天里既冗余又暴露宿主机目录结构）
function errText(err, base) {
  let msg = String(err?.message ?? err);
  if (base) msg = msg.split(base + sep).join('').split(base).join('.');
  return msg;
}

export function makeReadFile(cwd) {
  return {
    name: 'read_file',
    label: 'Read file',
    description: 'Read a text file inside the working directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path within the working directory' } },
      required: ['path'],
    },
    execute: async (_id, params) => {
      let base = null;
      try {
        // 先取 realpath 的 cwd：confine 失败（含 ENOENT——Node 的错误消息带绝对路径）
        // 时 errText 也能完成去路径。与 confine 内部的那次 realpath 重复，开销可忽略。
        base = realpath(cwd);
        const abs = confine(cwd, params.path);
        const st = await fs.stat(abs);
        if (st.size > MAX_FILE_BYTES) throw new Error(`file too large (>1MB): ${params.path}`);
        const text = await fs.readFile(abs, 'utf8');
        return { content: [{ type: 'text', text }], details: { bytes: st.size } };
      } catch (err) {
        return { content: [{ type: 'text', text: errText(err, base) }], details: {}, isError: true };
      }
    },
  };
}

export function makeListDir(cwd) {
  return {
    name: 'list_dir',
    label: 'List directory',
    description: 'List entries of a directory inside the working directory ("dir/" suffix marks directories).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative directory path; empty string = working directory root' } },
    },
    execute: async (_id, params) => {
      let base = null;
      try {
        base = realpath(cwd);   // 同 read_file：confine 抛错时错误消息也能去绝对路径
        const abs = confine(cwd, params.path ?? '');
        const entries = await fs.readdir(abs, { withFileTypes: true });
        const lines = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
        return { content: [{ type: 'text', text: lines.join('\n') || '(empty)' }], details: { count: entries.length } };
      } catch (err) {
        return { content: [{ type: 'text', text: errText(err, base) }], details: {}, isError: true };
      }
    },
  };
}

export function makeGrep(cwd) {
  return {
    name: 'grep',
    label: 'Search text',
    description: 'Case-insensitive search across text files in the working directory. Returns up to 50 lines as "path:line: text".',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regex pattern' },
        include: { type: 'string', description: 'Optional filename substring filter, e.g. ".ts"' },
      },
      required: ['pattern'],
    },
    execute: async (_id, params) => {
      let base = null;
      try {
        base = realpath(cwd);
        // ReDoS 防护：pattern 长度上限（嵌套量词的灾难性回溯随长度指数增长）+
        // 时间预算（同步正则无法中断，超时截断遍历而非卡死单线程网关）。
        const pattern = String(params.pattern ?? '').slice(0, 200);
        if (!pattern) throw new Error('pattern required');
        const re = new RegExp(pattern, 'i');
        const started = Date.now();
        const matches = [];
        let truncated = false;
        await walkFiles(base, async (file) => {
          if (matches.length >= MAX_GREP_MATCHES || truncated) return false;   // false = 停止遍历
          if (Date.now() - started > GREP_BUDGET_MS) { truncated = true; return false; }
          const st = await fs.stat(file);
          if (st.size > MAX_FILE_BYTES) return;
          const rel = file.slice(base.length + 1).split(sep).join('/');
          if (params.include && !rel.includes(params.include)) return;
          const text = await fs.readFile(file, 'utf8').catch(() => null);      // 不可解码 → null 跳过
          // utf8 解码对二进制并不抛错（非法序列替换为 U+FFFD），靠 NUL 字节识别二进制
          if (text === null || text.includes('\u0000')) return;
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            // 单行截断到 1000 字符再匹配：灾难性回溯的耗时随行长增长
            if (re.test(lines[i].slice(0, 1000))) {
              matches.push(`${rel}:${i + 1}: ${lines[i].slice(0, 200)}`);
              if (matches.length >= MAX_GREP_MATCHES) { truncated = true; return false; }
            }
          }
        });
        const text = truncated ? `${matches.join('\n')}\n(结果截断)` : (matches.length ? matches.join('\n') : 'no matches');
        return { content: [{ type: 'text', text }], details: { matches: matches.length } };
      } catch (err) {
        return { content: [{ type: 'text', text: errText(err, base) }], details: {}, isError: true };
      }
    },
  };
}

// 期 1 三个只读工具，供后续 pi 适配器按 cwd 接入 initialState.tools
export function readOnlyTools(cwd) {
  return [makeReadFile(cwd), makeListDir(cwd), makeGrep(cwd)];
}

// 递归收集常规文件；跳过依赖/构建目录与隐藏目录。目录符号链接不被跟随
// （Dirent.isDirectory() 对 symlink 为 false），路径逃逸由此天然被挡住。
async function walkFiles(dir, cb) {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = pathJoin(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      await walkFiles(full, cb);
    } else if (e.isFile()) {
      if ((await cb(full)) === false) return;
    }
  }
}
