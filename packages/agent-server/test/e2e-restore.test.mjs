// 端到端：① 跨进程恢复（杀网关→重启→第三轮记得第一轮）
//        ② 网站会话本机可打开（pi CLI resume 我们写出的 JSONL）
// 两条都跑真实 CLI，故本机没装 claude / pi 时 skip，不让 CI 因环境缺失而红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCcAdapter } from '../src/adapters/cc.mjs';
import { TranscriptStore } from '../src/transcripts.mjs';
import { withUsage, buildPiSessionLines, renderPiSession } from '../src/pi-session-writer.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const collect = async (iter) => { const out = []; for await (const e of iter) out.push(e); return out; };
const withTimeout = (promise, ms, label) => {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

// 起假上游（与 cc-adapter.test.mjs 同一夹具）：读端口文件，不改夹具本身。
async function startFakeAnthropic(t) {
  const portFile = join(tmpdir(), `atbx-e2e-port-${process.pid}-${Date.now()}.port`);
  const child = spawn(process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'fixtures/fake-anthropic.mjs')],
    { env: { ...process.env, FAKE_ANTHROPIC_PORT_FILE: portFile }, stdio: 'ignore', detached: true });
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ } rmSync(portFile, { force: true }); });
  let port = null;
  for (let i = 0; i < 60 && !port; i++) {
    try { const p = Number(readFileSync(portFile, 'utf8').trim()); if (p) port = p; } catch { /* 还没写 */ }
    await delay(100);
  }
  assert.ok(port, 'fake upstream started');
  return `http://127.0.0.1:${port}`;
}

// ── ① 跨进程恢复：cc 适配器 + 真实 CLI + 假上游 ────────────────────────────
// 「重启网关」= 磁盘目录不变，store 与适配器全换新实例。store 必须传给
// createCcAdapter，否则 restore() 恒 null。
test('cc session survives a gateway restart and resumes on the third turn', async (t) => {
  // skip 判定放最前：没装 CLI 就不该起上游、建目录。
  if (!(await createCcAdapter().available())) { t.skip('claude CLI not installed'); return; }
  const baseUrl = await startFakeAnthropic(t);

  const storeDir = mkdtempSync(join(tmpdir(), 'atbx-e2e-store-'));
  const cwd = mkdtempSync(join(tmpdir(), 'atbx-e2e-cwd-'));
  t.after(() => rmSync(storeDir, { recursive: true, force: true }));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const SID = 'e2e-restore-1';
  const boot = () => {
    const store = new TranscriptStore({ dir: storeDir });
    return { store, cc: createCcAdapter({ transcripts: store }) };
  };
  const runTurn = (cc, text, resumeSessionId) => collect(cc.run({
    messages: [{ role: 'user', content: text }],
    model: 'claude-sonnet-4-5', apiKey: 'k', baseUrl, cwd, allowedTools: [],
    resumeSessionId, sessionId: SID,
  }));

  const first = boot();
  const t1 = await withTimeout(runTurn(first.cc, 'turn one', null), 90_000, 'turn 1');
  assert.equal(t1.at(-1).type, 'turn_end', `turn 1 errored: ${t1.at(-1).message}`);
  const ccSessionId = first.store.get(SID)?.ccSessionId;
  assert.ok(ccSessionId, 'cc session id persisted');
  const configDir = first.store.get(SID).configDir;
  assert.ok(configDir, 'config dir persisted (without it --resume cannot find the transcript)');

  const second = boot();
  assert.notEqual(second.cc, first.cc, 'adapter instance really is new');
  const restored = second.cc.restore(SID);
  assert.ok(restored, 'restore finds the record after a cold start');
  assert.equal(restored.ccSessionId, ccSessionId);
  assert.equal(restored.configDir, configDir);

  const t3 = await withTimeout(runTurn(second.cc, 'turn three', restored.ccSessionId), 90_000, 'turn 3');
  assert.equal(t3.at(-1).type, 'turn_end', `turn 3 after restart errored: ${t3.at(-1).message}`);
  assert.equal(t3.find((e) => e.sessionId)?.sessionId, ccSessionId, 'resumed turn reused the cc session');
});

// ── ② 网站会话本机可打开 ──────────────────────────────────────────────────
test('a session file we write can be resumed by the real pi CLI', async (t) => {
  const hasPi = await new Promise((resolve) => execFile('pi', ['--version'], (err) => resolve(!err)));
  if (!hasPi) { t.skip('pi CLI not installed'); return; }

  const shared = mkdtempSync(join(tmpdir(), 'atbx-e2e-shared-'));
  const cwd = mkdtempSync(join(tmpdir(), 'atbx-e2e-picwd-'));
  t.after(() => rmSync(shared, { recursive: true, force: true }));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const piSessionId = '01e2e000-0000-7000-8000-0000000000ff';
  const lines = buildPiSessionLines({
    piSessionId, cwd, name: 'e2e',
    // withUsage：assistant 缺 usage 时真 CLI 崩在 totalTokens 上
    messages: withUsage([
      { role: 'user', content: [{ type: 'text', text: '记住暗号是 木瓜' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: '好的。' }], timestamp: 2 },
    ]),
  });
  writeFileSync(join(shared, `${piSessionId}.jsonl`), renderPiSession(lines), { mode: 0o600 });

  // 跑 pi：输出重定向到文件再读。不要用 execFile 的 timeout（被杀后输出可能全空、
  // 看起来像「CLI 没说话」）。刻意不加 --no-session：它会让 CLI 读不到会话（实测）。
  const ask = (argv, runCwd, outFile) => new Promise((resolve) => {
    execFile('sh', ['-c', `"$@" > "${outFile}" 2>&1 </dev/null`, 'sh', ...argv],
      { cwd: runCwd, timeout: 180_000 }, () => resolve(readFileSync(outFile, 'utf8')));
  });

  // ②a 同 cwd + --session：原地续
  const same = await withTimeout(
    ask(['pi', '--session-dir', shared, '--session', piSessionId, '--print', '暗号是什么'], cwd, join(shared, 'out-same.log')),
    190_000, 'pi same-cwd resume');
  assert.match(same, /木瓜/, `pi --session did not recall the seeded context. output: ${same.slice(-300)}`);

  // ②b 跨 cwd + --session-dir + --fork：用户从别的目录粘贴命令的场景
  const other = mkdtempSync(join(tmpdir(), 'atbx-e2e-other-'));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const forked = await withTimeout(
    ask(['pi', '--session-dir', shared, '--fork', piSessionId, '--print', '暗号是什么'], other, join(other, 'out-fork.log')),
    190_000, 'pi cross-cwd fork');
  assert.match(forked, /木瓜/, `pi --fork did not recall the seeded context. output: ${forked.slice(-300)}`);
});
