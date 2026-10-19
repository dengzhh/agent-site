// pi 工具（期 1 只读 + 期 2 写/执行）：read_file / list_dir / grep / write_file / bash。
// 硬边界：所有路径 resolve + realpath 后必须落在 cwd 内（同时防 ../ 穿越与符号链接
// 逃逸）；grep 跳过依赖/隐藏目录、单文件 1MB 上限、最多 50 条匹配。
// 错误一律捕获后以 isError 结果返回（而不是抛给 agent loop），消息里不泄漏 cwd
// 绝对路径。
// 写/执行工具（write_file / bash）每次执行前先过 requestApproval 审批闸（抽屉权限卡），
// 拒绝 → isError 结果 'denied by user'，绝不落盘/执行。
import { promises as fs, lstatSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join as pathJoin, resolve, sep } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', 'dist', 'build', '.next', '__pycache__']);
const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_GREP_MATCHES = 50;
// ReDoS 防护：恶意正则的灾难性回溯随输入长度指数增长，同步执行无法中断——
// 用时间预算硬性截断（超时返回部分结果），避免网站用户卡死单线程网关。
export const GREP_BUDGET_MS = 5000;
// bash：单条命令 60s 超时；输出（stdout+stderr 合并）截断到 8KB；单流
// buffer 上限 1MB；权限卡摘要里的命令预览截到 200 字符（截断时附剩余字数）。
export const BASH_TIMEOUT_MS = 60_000;
export const MAX_BASH_OUTPUT_CHARS = 8192;
const BASH_PREVIEW_CHARS = 200;

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

// 写路径边界：confine 的写场景变体。与只读的两点差异——
// ① 目标允许不存在（新建文件是常规场景，confine 的 realpath 会 ENOENT）：
//    父目录必须存在且 realpath 落在 cwd 内（不给 mkdir -p 语义——父目录链上任何
//    一环是外指符号链接都在这里被拦下，也不会替用户凭空建目录）；
// ② 目标已存在时对其本体做 realpath 检查：写会跟随符号链接，指向外部文件的
//    链接（期 1 只读工具管不到的硬链接/链接场景）必须在校验真实落点后才放行。
// 关键顺序：先 lstat 再判定「新文件」。悬空符号链接（指向尚不存在的外部文件）的
// realpath 同样抛 ENOENT，与真正的新文件不可区分——只看 realpath 会放行
// 「writeFile 跟随悬空链接在 cwd 外建文件」的逃逸。现在 lstat 命中 symlink 一律
// 拒绝；存在但 realpath 失败（ELOOP 链环等罕见情形）也拒绝（fail closed），
// 写永远不会跟随任何符号链接出 cwd。
// 返回的是词法路径（写入用），非 realpath。
// 已知局限（与 confine 的读侧注释同款）：指向 cwd 外文件的硬链接无法用 realpath
// 识别——经由 cwd 内的硬链接写入会改到外部的真身。本工具不做 inode 级防护。
// TOCTOU：校验与写入不是原子的——校验后本机竞争者仍可把目标换成外指符号链接。
// 单用户本地工具，这个窗口已知且接受；进程级隔离属于宿主（sandbox/容器）的职责。
export function confineForWrite(cwd, relPath) {
  const baseReal = realpath(cwd);
  const abs = resolve(baseReal, String(relPath ?? ''));
  if (abs !== baseReal && !abs.startsWith(baseReal + sep)) {
    throw new Error(`path escapes working directory: ${relPath}`);
  }
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    // 真正的新文件：本体无链接可逃，但父目录仍须在 cwd 内（防外指链接目录）
    const parentReal = realpath(dirname(abs));
    if (parentReal !== baseReal && !parentReal.startsWith(baseReal + sep)) {
      throw new Error(`path escapes working directory: ${relPath}`);
    }
    return abs;
  }
  if (st.isSymbolicLink()) {
    // 写会跟随链接：悬空链接、外指链接、链环——只要本体是符号链接就不放行
    throw new Error(`path escapes working directory: ${relPath}`);
  }
  const parentReal = realpath(dirname(abs));
  if (parentReal !== baseReal && !parentReal.startsWith(baseReal + sep)) {
    throw new Error(`path escapes working directory: ${relPath}`);
  }
  let targetReal;
  try {
    targetReal = realpath(abs);
  } catch {
    // 存在且不是符号链接，但 realpath 失败（父链上的 ELOOP 等）→ fail closed
    throw new Error(`path escapes working directory: ${relPath}`);
  }
  if (targetReal !== baseReal && !targetReal.startsWith(baseReal + sep)) {
    throw new Error(`path escapes working directory: ${relPath}`);
  }
  return abs;
}

// write_file：新建/覆盖 cwd 内的文本文件，上限 1MB（与 read 的单文件上限一致，
// 模型上下文也装不下更大的内容）。校验（边界/大小）先行——非法请求不弹权限卡；
// 校验过了才 requestApproval('write', 'write_file <relPath> (<n> bytes)')，
// 拒绝 → isError 'denied by user'。requestApproval 缺省拒绝（fail closed）：
// 没有审批闸的写工具绝不落盘。
export function makeWriteFile(cwd, requestApproval = async () => false) {
  return {
    name: 'write_file',
    label: 'Write file',
    description: 'Create or overwrite a text file inside the working directory (up to 1MB). Asks the user for approval first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path within the working directory' },
        content: { type: 'string', description: 'Full text content to write (overwrites any existing file)' },
      },
      required: ['path', 'content'],
    },
    execute: async (_id, params) => {
      let base = null;
      try {
        base = realpath(cwd);   // confine 抛错时 errText 也能去绝对路径（同 read_file）
        // content 在 schema 里已标 required，但执行层显式再校验（模型/客户端可能
        // 绕过 schema 省略它）——校验失败不弹审批卡，同「路径越界先于审批」的顺序
        if (params.content == null) throw new Error('content required');
        const relPath = String(params.path ?? '');
        const abs = confineForWrite(cwd, relPath);
        const content = String(params.content ?? '');
        const bytes = Buffer.byteLength(content, 'utf8');
        if (bytes > MAX_FILE_BYTES) throw new Error(`content too large (>1MB): ${relPath}`);
        const ok = await requestApproval('write', `write_file ${relPath} (${bytes} bytes)`);
        if (!ok) return { content: [{ type: 'text', text: 'denied by user' }], details: {}, isError: true };
        await fs.writeFile(abs, content, 'utf8');
        return {
          content: [{ type: 'text', text: `wrote ${relPath} (${bytes} bytes)` }],
          details: { bytes },
        };
      } catch (err) {
        return { content: [{ type: 'text', text: errText(err, base) }], details: {}, isError: true };
      }
    },
  };
}

// 输出截断：按字符数（utf8 解码后的文本；CJK 下字节数略超 8K，量级不变）
function truncateOutput(text, max = MAX_BASH_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n(输出截断，共 ${text.length} 字符)`;
}

// 审批卡预览截断：截到 max 字符，截断时附「… (+N chars)」——用户得知道预览
// 后面还藏着多少命令，才不至于批准一段被静默剪断的内容
function truncatePreview(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… (+${text.length - max} chars)`;
}

// bash：spawn('bash', ['-lc', cmd]) 在 cwd 内执行，detached 起独立进程组。
// 语义约定（与只读工具的 isError 约定对齐后刻意分流）：
//  - 非零退出码 = 命令自身的领域输出，正常结果返回 'exit <code>\n<输出>'
//    （不是 isError——对 agent 这是可用信息，和主流 agent harness 一致）；
//  - 超时 / bash 不可用等环境故障 → isError（工具没干成它承诺的事）；
//  - 单流输出超 maxBuffer（1MB，防子进程刷爆内存）→ 杀掉整个进程组，已捕获的
//    部分按截断结果正常返回（不是 isError——部分输出往往已够用）。不依赖
//    execFile 的错误码：maxBuffer 超限的错误码随 Node 版本变（ENOBUFS →
//    ERR_CHILD_PROCESS_STDIO_MAXBUFFER，按码匹配必成死分支），自己数着字节最稳；
//  - stdout 在前 stderr 在后合并，整体截断到 8KB；
//  - 执行前 requestApproval('bash', 命令预览)，拒绝 → isError 'denied by user'。

// 跑一条 bash 命令（独立进程组），收集输出直到进程组整体退出。超时与超 buffer
// 都直接对进程组 SIGKILL：execFile 的 timeout 只 SIGTERM bash 本身——后台孙子
// 进程变孤儿继续跑（sleep 30 & 之类），而 trap '' TERM 的命令连 bash 都杀不死、
// 调用方永远挂起。组级 SIGKILL 一并解决（SIGKILL 无法被 trap）。
function runBashGroup(command, cwd, timeoutMs, maxBuffer = 1024 * 1024) {
  return new Promise((done) => {
    const child = spawn('bash', ['-lc', command], { cwd, detached: true });
    let stdout = '';
    let stderr = '';
    let outBytes = 0;
    let errBytes = 0;
    let capped = false;     // 某一流超 maxBuffer（execFile 语义：按流各算 1MB）
    let timedOut = false;
    let settled = false;

    const killGroup = () => {
      // detached ⇒ bash 是进程组长：负 pid 对整组发信号，后台孙子一起死。
      // 组已退出时 kill 抛 ESRCH，忽略；child.kill 兜底（防御性双保险）。
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程组已退出 */ }
      try { child.kill('SIGKILL'); } catch { /* 进程已退出 */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    const onChunk = (isOut) => (chunk) => {
      if (capped) return;   // 已超限：尾包丢弃（进程组正在被杀）
      if (isOut) { outBytes += Buffer.byteLength(chunk); stdout += chunk; }
      else { errBytes += Buffer.byteLength(chunk); stderr += chunk; }
      if ((isOut ? outBytes : errBytes) > maxBuffer) { capped = true; killGroup(); }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', onChunk(true));
    child.stderr.on('data', onChunk(false));
    child.on('error', (err) => finish({ error: err }));   // bash 缺失等 spawn 失败
    child.on('close', (code) => finish({ code, stdout, stderr, timedOut, capped }));
  });
}

export function makeBash(cwd, requestApproval = async () => false, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? BASH_TIMEOUT_MS;
  return {
    name: 'bash',
    label: 'Run shell command',
    description: `Run a shell command (bash -lc) inside the working directory. ${Math.round(timeoutMs / 1000)}s timeout, output truncated to 8KB. Asks the user for approval first.`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute' },
      },
      required: ['command'],
    },
    execute: async (_id, params) => {
      let base = null;
      try {
        base = realpath(cwd);
        const command = String(params.command ?? '').trim();
        if (!command) throw new Error('command required');
        const ok = await requestApproval('bash', truncatePreview(command, BASH_PREVIEW_CHARS));
        if (!ok) return { content: [{ type: 'text', text: 'denied by user' }], details: {}, isError: true };
        const r = await runBashGroup(command, base, timeoutMs);
        if (r.error) throw r.error;   // bash 缺失等环境错误 → 外层 isError
        if (r.timedOut) throw new Error(`command timed out after ${timeoutMs}ms`);
        if (r.capped) {
          // 输出超 maxBuffer：进程组已中止，已捕获部分照常返回（截 8KB）——
          // 对 agent 这是领域输出不是工具故障（exit 行注明被 buffer 上限截停）
          const text = `exit ${r.code ?? 'null'} (output exceeded the 1MB buffer cap, process group killed)\n`
            + `${truncateOutput(r.stdout + r.stderr)}\n(输出超限中止)`;
          return { content: [{ type: 'text', text }], details: { exitCode: r.code ?? null, truncated: true } };
        }
        const output = truncateOutput(r.stdout + r.stderr);
        const text = r.code === 0
          ? (output || '(no output)')
          : `exit ${r.code}\n${output}`;
        return { content: [{ type: 'text', text }], details: { exitCode: r.code } };
      } catch (err) {
        return { content: [{ type: 'text', text: errText(err, base) }], details: {}, isError: true };
      }
    },
  };
}

// 期 2 完整工具集：只读三件套 + 写/执行（写/执行经 requestApproval 审批闸）。
export function fullTools(cwd, requestApproval) {
  return [
    ...readOnlyTools(cwd),
    makeWriteFile(cwd, requestApproval),
    makeBash(cwd, requestApproval),
  ];
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
