// 会话 transcript 的磁盘存储。与 SessionStore（内存、活跃会话）分工：
// 内存那份管「正在跑的回合、挂起的审批、SSE 连接」，磁盘这份管
// 「跨重启/跨逐出的历史」。会话被内存 LRU 逐出时内容留在这里，不删。
//
// 安全取向（spec Security 节）：transcript 含 full tier 的工具输出、读过的
// 文件、截图，故文件 0600 / 目录 0700。凭据永不进这里：save() 按字段白名单
// 组装记录（见 RECORD_FIELDS），黑名单式的「记得别把 apiKey 传进来」已经
// 被证明拦不住——嵌套一层、大小写一变、塞进 env 就都溜过去了。
// 读回时同样按白名单裁剪：写路径封死了入口，读路径就不该把来路不明的
// 字段（哪怕是手写的盘外文件）原样端给调用方。
import {
  mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, chmodSync, existsSync,
  openSync, writeSync, fsyncSync, closeSync,
} from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const FORMAT_VERSION = 1;

// id 直接参与拼路径，且 Task 6 起会由请求体提供，故必须先验形状。
// 限定为「字母数字/下划线/连字符」：够放 UUID（persistId 就是 UUID），
// 又天然排掉 `/`、`..`、前导点这些能逃出 dir 的片段。
// 导出给路由用：网关的 URL 分段与 store 的 id 校验必须是同一把尺子，
// 否则一处放宽（如 `bye`）另一处仍 404。
export const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const ID_SOURCE = '[A-Za-z0-9_-]{1,128}';

// 记录的完整字段表（spec 单文件格式），照抄而非推断。
// 只认这张表：不在上面的字段一律不落盘，凭据也就没地方藏。
// 代价是 spec 加字段必须同步这里——刻意用测试钉住往返来兜这个风险。
// configDir 是 cc 适配器的持久 config dir 路径，同样属于「本就该记下的」。
const RECORD_FIELDS = [
  'id', 'adapter', 'agent', 'provider', 'model', 'cwd', 'toolTier', 'title',
  'messages', 'piSessionId', 'ccSessionId', 'configDir',
];

// 存盘时额外盖的三个字段：格式版本与两个时间戳。
const STAMP_FIELDS = ['v', 'createdAt', 'lastUsed'];

// createdAt/lastUsed 由 store 盖章，不在 RECORD_FIELDS 里，却是从 rec 直取，
// 所以它们是绕过白名单的暗道：传个对象进去，嵌套的凭据就原样落盘了。
// 更糟的是传个非数字，sweep() 里 now - lastUsed 得 NaN，比较恒 false——
// 一条永生记录，TTL 直接失效。只收有限数字，两个问题一起解决。
function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

// 白名单只回答了「哪些键能落盘」，没回答「这些键里能装什么」。provider/model
// 等配置字段本身就该是字符串（'anthropic'、'claude-sonnet-5-5'），但 save()
// 原样拷贝，于是 provider: { apiKey } 照样把凭据写进 0600 文件——和上面
// createdAt 那条同一个洞，只是高了一层。这些字段只收字符串；null 是
// 「显式清空」（cc 的 ccSessionId 复位靠它），保留；其余形状整个丢掉。
// messages 是数组、不是凭据容器，不在此列。
const STRING_FIELDS = new Set([
  'id', 'adapter', 'agent', 'provider', 'model', 'cwd', 'toolTier', 'title',
  'piSessionId', 'ccSessionId', 'configDir',
]);

function shaped(k, v) {
  if (v === null) return null;
  if (STAMP_FIELDS.includes(k)) return num(v);
  if (STRING_FIELDS.has(k)) return typeof v === 'string' ? v : undefined;
  if (k === 'messages') return Array.isArray(v) ? v : undefined;
  return undefined;
}

/**
 * 这条记录「说过话」吗——即它有没有可恢复的内容？
 *
 * 判据刻意**不**看 messages：每个适配器的历史放在不同的地方。
 *   · pi： Agent 状态由我们持有（库自己不落盘），成功的 turn 把整份
 *     messages 写进记录——有 messages 就是说过话。
 *   · cc： 历史在 CLI 自己的 projects/<slug>/<id>.jsonl 里，靠 --resume 续；
 *     我们的记录只留 configDir + ccSessionId 两个指针，**永远**没有
 *     messages。cc 建目录时写的桩记录 ccSessionId 显式为 null，那是没说过话。
 *   · acp：每轮都是全新 session（newSession），不落任何东西，天然不可恢复
 *     ——它的记录永远不算说过话，列表里也不该出现。
 * 这与前端 canRestore()（pi | cc）是同一把尺子：列表里出现的每条都点得开。
 * @param {object} rec 记录（可含 messages，也可不含）
 * @returns {boolean}
 */
export function spoke(rec) {
  if (!rec) return false;
  if (Array.isArray(rec.messages) && rec.messages.length > 0) return true;
  // ccSessionId 是「这一轮真的跑完了」的唯一凭据（见 cc.mjs 的 turn_end 写入）。
  // 桩记录里它是 null，正常记录里它是个 UUID 字符串。
  return typeof rec.ccSessionId === 'string' && rec.ccSessionId.length > 0;
}

export class TranscriptStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir          存储目录（测试传临时目录）
   * @param {number} [opts.ttlMs]      TTL；缺省 7 天
   */
  constructor({ dir, ttlMs = 7 * 24 * 60 * 60 * 1000 }) {
    if (!dir) throw new TypeError('TranscriptStore requires a dir');
    if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs < 0) {
      throw new TypeError(`ttlMs must be a finite non-negative number, got ${ttlMs}`);
    }
    this.dir = dir;
    this.ttlMs = ttlMs;
    // 目录可能已存在且权限偏松（例如用户预先建的），统一收紧。
    // 新建的用 mode 0700 直接建对：mode 会再被 umask 削，0700 削不出别的位，
    // 所以新建的这一路不必事后 chmod（事后 chmod 会把「建的时候就是 0700」
    // 这件事盖住，测不出来）。
    const existed = existsSync(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existed) {
      try { chmodSync(dir, 0o700); } catch { /* 非 posix：忽略 */ }
    }
  }

  #path(id) { return join(this.dir, `${id}.json`); }

  /**
   * cc 适配器的持久 config dir 位置：与 json 并排，<id>.cc/。
   * 它是一个路径（由 store 派生），不是记录里的值，故不占白名单名额。
   * @returns {string|null} id 不合法时返回 null
   */
  companionDir(id) {
    return this.#readableId(id) ? join(this.dir, `${id}.cc`) : null;
  }

  // id 校验的两套失败模式，按「谁来写这个 id」区分：
  //   save 抛 TypeError —— id 由内部代码生成，写不进去是程序员 bug，响亮地炸；
  //   get/remove 返回空 —— id 可能来自 HTTP 请求体，用户传了脏值不是异常，
  //                        让路由层自然得到「查无此项」，不必包 try/catch。
  #assertId(id) {
    if (typeof id !== 'string' || !SAFE_ID.test(id)) {
      // id 可能很长或是对象，截断后再进错误消息
      throw new TypeError(`unsafe transcript id: ${String(id).slice(0, 32)}`);
    }
  }
  #readableId(id) { return typeof id === 'string' && SAFE_ID.test(id); }

  // 原子写：先写同目录临时文件再 rename。进程在写一半时被杀，不会留下半截 JSON。
  // 临时文件用 0600 建（不给 umask 留窗口），写完 fsync 再 rename。
  #writeFile(id, obj) {
    const final = this.#path(id);
    const tmp = `${final}.tmp`;
    // 上次崩溃可能留下残 tmp：先清掉，否则 'wx' 会一直 EEXIST
    rmSync(tmp, { force: true });
    let fd;
    try {
      fd = openSync(tmp, 'wx', 0o600);
      writeSync(fd, JSON.stringify(obj, null, 2) + '\n');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      // 不再事后 chmod：open 时的 0600 已经对（mode 只被 umask 削，
      // 而 umask 不会削属主位），事后 chmod 只会把「建的时候就是 0600」
      // 这件事盖住，反而测不出来。rename 保留 mode，最终文件仍是 0600。
      renameSync(tmp, final);   // 同文件系统内原子替换
    } catch (err) {
      // 序列化失败（如循环引用）会停在写临时文件那步。不清掉的话，
      // 下次 list() 会看到它、用户也会在目录里看到一个莫名其妙的残留文件。
      try { if (fd !== undefined) closeSync(fd); } catch { /* 已经关了 */ }
      try { rmSync(tmp, { force: true }); } catch { /* 已经没了 */ }
      throw err;
    }
  }

  /**
   * 写入或更新一条记录。逐字段合并：本次没给的字段保留上次落盘的值。
   * 两处写入方（网关记配置、适配器记自己的东西）因此可以各写各的字段，
   * 不会互相抹掉。null 是「显式值」，不是「没给」——要清掉某字段请删记录。
   * createdAt 保持首次值；lastUsed 缺省刷新为当前时间，
   * 但调用方显式给了就尊重那个值（导入既有记录 / 回填 / 测试造时间线）。
   * @param {object} rec 至少含 id；其余字段见 spec 的单文件格式
   * @throws {TypeError} rec 缺 id，或 id 不满足 SAFE_ID
   */
  save(rec) {
    this.#assertId(rec?.id);
    const prev = this.#read(this.#path(rec.id), rec.id);
    const now = Date.now();
    // 显式按白名单挑字段，而不是 {...rec} 再删几个键：黑名单永远少一种拼法
    // （大小写、嵌套一层、塞进 env），白名单则天然封死——只要不在这张表上，
    // 就碰不到磁盘。凭据的保证因此是结构性的，不依赖调用方的自觉。
    const merged = { v: FORMAT_VERSION, createdAt: 0, lastUsed: 0 };
    for (const k of RECORD_FIELDS) {
      // 形状不对（非字符串的 provider 之类）不能落盘，也不能覆盖已有的好值。
      // 判断用 k in rec（而不是 rec[k] !== undefined）：null 是显式清空。
      if (k in rec) {
        if (shaped(k, rec[k]) !== undefined) merged[k] = shaped(k, rec[k]);
        else if (prev?.[k] !== undefined) merged[k] = prev[k];
      } else if (prev?.[k] !== undefined) merged[k] = prev[k];
    }
    merged.createdAt = num(prev?.createdAt) ?? num(rec.createdAt) ?? now;
    // 调用方显式给了 lastUsed 就尊重它（导入/迁移既有记录、测试造时间线）；
    // 没给才盖当前时间。永远用 now 会把导入的历史全部「刷新」成当下。
    merged.lastUsed = num(rec.lastUsed) ?? now;
    this.#writeFile(rec.id, merged);
    return merged;
  }

  // 读一条记录，任何不合规都按「损坏」处置：隔离后返回 null。
  // expectedId 是文件名里的 id：payload 自报的 id 与文件名不一致说明这份
  // 文件被人动过或曾经被复制，不能拿它当身份用。
  #read(path, expectedId) {
    let raw;
    try { raw = readFileSync(path, 'utf8'); } catch { return null; }
    let obj;
    try { obj = JSON.parse(raw); } catch {
      this.#quarantine(path);
      return null;
    }
    // 版本不符一律当损坏：绝不猜测未来格式的形状（spec 边界情况节）
    if (obj?.v !== FORMAT_VERSION || typeof obj.id !== 'string') {
      this.#quarantine(path);
      return null;
    }
    // 身份以文件名为准：payload 自报的 id 与文件名不一致说明这份
    // 文件被人动过或曾经被复制，不能拿它当身份用。这一条同时替掉了
    // 「payload.id 也要过 SAFE_ID」——文件名那份已经过了白名单，
    // 两边对不上就是坏文件。
    if (expectedId !== undefined && obj.id !== expectedId) {
      this.#quarantine(path);
      return null;
    }
    // 时间戳必须是有限数字：非数字的 lastUsed 会让 sweep 的 NaN 比较恒为假，
    // 那等于一条永生记录，TTL 形同虚设。写路径已经挡了，读路径也得挡——
    // 否则一个手写的文件就能在 store 之外给自己续命。
    if (!Number.isFinite(obj.createdAt) || !Number.isFinite(obj.lastUsed)) {
      this.#quarantine(path);
      return null;
    }
    // 读回时按同一张白名单裁剪，并按同一套形状规则挡掉盘外来路不明的值：
    // 写路径封死了入口，读路径也不该把（手写的）嵌套对象原样端给调用方。
    const out = {};
    for (const k of [...STAMP_FIELDS, ...RECORD_FIELDS]) {
      if (!(k in obj)) continue;
      const v = shaped(k, obj[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  // 不带副作用地读一份原始 JSON：remove() 用它取 configDir，
  // 又不想因为文件损坏而触发隔离（用户点名删的就是要删掉）。
  #readRaw(path) {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  }

  // 隔离而非删除：文件可能只是被一次崩溃写坏了，用户还想抢救里面的内容。
  // 目标是固定名 <id>.corrupt.json —— 不叠加后缀，因为 list() 会跳过这个后缀，
  // 叠加既没意义又会让文件名无界增长（.corrupt.corrupt.corrupt…）。
  #quarantine(path) {
    const dest = `${path.replace(/\.json$/, '')}.corrupt.json`;
    try { renameSync(path, dest); } catch { /* 已移动/已删 */ }
  }

  get(id) {
    if (!this.#readableId(id)) return null;
    return this.#read(this.#path(id), id);
  }

  /**
   * 列某配置下的历史。messages 一律剥掉——列表只该看到元数据，
   * 否则几百条消息的会话会把列表响应撑爆。
   * @param {object} filter {agent, cwd, provider, model} 全部可选，给的都需匹配
   * @param {object} [opts]
   * @param {boolean} [opts.hideEmpty] 滤掉「没说过话」的空壳。网关建会话时
   *   就必须落盘（筛选键（agent/cwd）与恢复要用的字段要立即可查，否则自动恢复
   *   命中 0 条），于是每开一次抽屉就多一条空壳；落盘时机改不了，故在读取侧
   *   过滤。默认 false：sweep/remove/CLI 等内部调用要看得见空壳。
   *   判据是「这条记录能不能被恢复」（见 spoke()），**不是**「记录里有没有
   *   messages」：cc 的历史在 CLI 自己的 jsonl 里，我们的记录只留
   *   configDir/ccSessionId，永远没有 messages——按 messages 判会把 cc/acp
   *   的真会话全部筛掉，只剩 pi 的空壳（正是 9e35bb7 那次回归）。
   * @returns {object[]} 按 lastUsed 降序
   */
  list(filter = {}, { hideEmpty = false } = {}) {
    let names;
    try { names = readdirSync(this.dir); } catch { return []; }
    const out = [];
    for (const name of names) {
      // 隔离区不是历史：用户没修好之前它不该出现在列表里，也不该被再次隔离
      if (name.endsWith('.corrupt.json')) continue;
      // 临时文件（<id>.json.tmp）不以此结尾，自然被挡在外面
      if (!name.endsWith('.json')) continue;
      const id = basename(name, '.json');
      if (!SAFE_ID.test(id)) {
        this.#quarantine(join(this.dir, name));
        continue;
      }
      const rec = this.#read(join(this.dir, name), id);
      if (!rec) continue;
      if (filter.agent != null && rec.agent !== filter.agent) continue;
      if (filter.cwd != null && rec.cwd !== filter.cwd) continue;
      if (filter.provider != null && rec.provider !== filter.provider) continue;
      if (filter.model != null && rec.model !== filter.model) continue;
      // 空会话（含 cc 建目录时留的桩记录）不进历史列表。判断必须在剥掉
      // messages 之前；cc 的桩记录 ccSessionId 显式为 null，也算没说过话。
      if (hideEmpty && !spoke(rec)) continue;
      const { messages, ...meta } = rec;
      out.push(meta);
    }
    return out.sort((a, b) => b.lastUsed - a.lastUsed);
  }

  /**
   * 删一条历史：json + cc 的持久 config dir（若有）。幂等。
   * @returns {boolean} 是否真的删掉过 json（用于区分「删了」与「本来就没有」）
   */
  remove(id) {
    if (!this.#readableId(id)) return false;
    const path = this.#path(id);
    // rmSync 的 force 只是不抛异常，不等于文件存在；返回值必须看存在性
    const existed = existsSync(path);
    // 先取记录里的 configDir：cc 的 config dir 可能不在 <id>.cc（历史记录
    // 指向别处），那也得一起收，否则 cc 的 transcript 留在盘上没人管。
    const rec = this.#readRaw(path);
    rmSync(path, { force: true });
    const companion = this.companionDir(id);
    if (companion) rmSync(companion, { recursive: true, force: true });
    const extra = typeof rec?.configDir === 'string' ? rec.configDir : null;
    // 只删「我们造得出来的」目录：store 目录内或系统临时目录下的子目录。
    // 记录文件是可以被人手写的，不能让它把 rmSync 指到任意路径。
    if (extra && extra !== companion && this.#isDisposableDir(extra)) {
      rmSync(extra, { recursive: true, force: true });
    }
    return existed;
  }

  // extra 是不是「我们可以放心删的目录」：必须在 store 目录或系统临时目录
  // 之下，且不能就是这两个根目录本身。
  #isDisposableDir(p) {
    const target = resolve(p);
    for (const root of [resolve(this.dir), resolve(tmpdir())]) {
      if (target === root) continue;
      if (target.startsWith(root + sep)) return true;
    }
    return false;
  }

  /**
   * 按筛选范围清空，返回删掉的条数。
   * 必须给非空筛选：web 路由只允许删「某一组配置的历史」，
   * 全量清空是 CLI 的权力（见 clearAll）。
   * @param {{ skipActive?: (id: string) => boolean }} [opts]
   *   skipActive：返回 true 的 id 不删（活跃会话的记录，见 server 的 /sessions/clear）。
   * @returns {number} 实际删掉的条数
   * @throws {TypeError} filter 缺省或没有有效维度
   */
  clear(filter, { skipActive } = {}) {
    if (!filter || typeof filter !== 'object'
      || !Object.values(filter).some((v) => v != null)) {
      throw new TypeError('clear() requires a non-empty filter; use clearAll() to wipe everything');
    }
    const ids = this.list(filter).map((r) => r.id);
    let n = 0;
    for (const id of ids) {
      if (skipActive?.(id)) continue;
      this.remove(id);
      n++;
    }
    return n;
  }

  /**
   * 全量清空（CLI 的「清空全部历史」）。返回删掉的条数。
   * 隔离区里的 .corrupt.json 不在其中——那是留给用户抢救的副本。
   */
  clearAll() {
    const ids = this.list({}).map((r) => r.id);
    for (const id of ids) this.remove(id);
    return ids.length;
  }

  /**
   * TTL 清扫：删掉 lastUsed 超期的记录。网关启动时调一次。
   * @param {number} [now] 可注入的当前时间（测试用）
   * @returns {string[]} 被删掉的 id
   */
  sweep(now = Date.now()) {
    const dropped = [];
    for (const rec of this.list({})) {
      if (now - rec.lastUsed > this.ttlMs) {
        this.remove(rec.id);
        dropped.push(rec.id);
      }
    }
    return dropped;
  }
}
