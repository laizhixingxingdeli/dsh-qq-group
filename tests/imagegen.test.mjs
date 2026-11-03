import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPrompt, fillWorkflow, drawImage, quotaLeft, readImageGenConfig, runComfy } from '../src/qq/imagegen.ts';
import { withTtsWindow, VramDaemon, readVramConfig } from '../src/qq/vram.ts';

// 1. 内容过滤
{
  assert.equal(checkPrompt('1girl, waving, park').ok, true);
  for (const bad of ['NSFW girl', '画个裸体', 'loli', '血腥场面', 'a Naked man', '萝莉']) {
    assert.equal(checkPrompt(bad).ok, false, `应拦截：${bad}`);
  }
  assert.equal(checkPrompt('').ok, false);
  assert.equal(checkPrompt('x'.repeat(401)).ok, false);
  assert.equal(checkPrompt('cat with hat', ['hat']).ok, false, '自定义拦截词生效');
  const cleaned = checkPrompt('a {{seed}} cat\nnext line');
  assert.ok(cleaned.ok && !cleaned.prompt.includes('{{') && !cleaned.prompt.includes('\n'), '不能借提示词注入占位符');
}

// 2. 工作流占位符：整段数字替换、部分字符串替换、深拷贝不改原模板
{
  const template = { '3': { inputs: { seed: '{{seed}}', text: 'masterpiece, {{prompt}}', w: '{{width}}', neg: '{{negative}}', keep: '{{unknown}}' } } };
  const out = fillWorkflow(template, { seed: 42, prompt: 'cat', width: 512, negative: 'bad' });
  assert.equal(out['3'].inputs.seed, 42);
  assert.equal(out['3'].inputs.w, 512);
  assert.equal(out['3'].inputs.text, 'masterpiece, cat');
  assert.equal(out['3'].inputs.keep, '{{unknown}}');
  assert.equal(template['3'].inputs.seed, '{{seed}}', '原模板不被修改');
}

// 3. 假 ComfyUI：提交 → 轮询 → 下载；租约成对调用；次数限制
{
  const dir = mkdtempSync(join(tmpdir(), 'img-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: true, perUserDaily: 2, totalDaily: 10, scope: 'all' }));
    writeFileSync(join(dir, 'workflow.json'), JSON.stringify({ '6': { inputs: { text: '{{prompt}}' } }, '7': { inputs: { text: '{{negative}}' } }, '3': { inputs: { seed: '{{seed}}' } } }));
    const cfg = readImageGenConfig(dir);
    let submitted;
    let polls = 0;
    const fetchImpl = async (url, init) => {
      if (url.endsWith('/prompt')) {
        submitted = JSON.parse(init.body).prompt;
        return { ok: true, status: 200, json: async () => ({ prompt_id: 'p1' }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (url.includes('/history/')) {
        polls += 1;
        const body = polls < 2 ? {} : { p1: { status: { status_str: 'success' }, outputs: { '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] } } } };
        return { ok: true, status: 200, json: async () => body, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
      }
      if (url.includes('/view?')) {
        assert.ok(url.includes('filename=a.png'));
        return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer };
      }
      throw new Error(`unexpected ${url}`);
    };
    const calls = [];
    const lease = { acquire: async (r) => calls.push(`acquire:${r}`), release: async (r) => calls.push(`release:${r}`) };
    const r1 = await drawImage(dir, cfg, { kind: 'selfie', prompt: 'waving', requesterQq: '20002' }, { appearance: '1girl, blue hair', lease, fetchImpl, pollMs: 1 });
    assert.ok(r1.ok && existsSync(r1.file), '出图并保存');
    assert.equal(readFileSync(r1.file)[0], 137);
    assert.ok(submitted['6'].inputs.text.startsWith('1girl, blue hair, selfie, waving'), '自拍带上外形描述');
    assert.ok(submitted['7'].inputs.text.includes('nsfw'), '反向提示词带安全词');
    assert.equal(typeof submitted['3'].inputs.seed, 'number');
    assert.deepEqual(calls, ['acquire:qq-selfie', 'release:qq-selfie'], '租约成对');

    polls = 0;
    await drawImage(dir, cfg, { kind: 'request', prompt: 'a cat', requesterQq: '20002' }, { lease, fetchImpl, pollMs: 1 });
    const r3 = await drawImage(dir, cfg, { kind: 'request', prompt: 'a dog', requesterQq: '20002' }, { lease, fetchImpl, pollMs: 1 });
    assert.equal(r3.ok, false);
    assert.equal(r3.userFacing, true, '超出每人次数，告诉对方');
    assert.equal(quotaLeft(dir, cfg, '30003').ok, true, '别人还能画');

    const bad = await drawImage(dir, cfg, { kind: 'request', prompt: 'nude', requesterQq: '30003' }, { lease, fetchImpl, pollMs: 1 });
    assert.ok(!bad.ok && bad.userFacing, '违规内容直接拒绝');
    assert.equal(calls.length, 4, '被拒绝的请求不会去占显卡');

    // ComfyUI 报错时也要释放租约
    const broken = async (url) => {
      if (url.endsWith('/prompt')) return { ok: true, status: 200, json: async () => ({ prompt_id: 'p2' }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
      return { ok: true, status: 200, json: async () => ({ p2: { status: { status_str: 'error' }, outputs: {} } }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    };
    const r4 = await drawImage(dir, cfg, { kind: 'request', prompt: 'a bird', requesterQq: '30003' }, { lease, fetchImpl: broken, pollMs: 1 });
    assert.ok(!r4.ok && !r4.userFacing);
    assert.equal(calls[calls.length - 1], 'release:qq-draw', '失败也释放显卡');

    // 只许自拍时拒绝帮人画
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ enabled: true, scope: 'selfie' }));
    const r5 = await drawImage(dir, readImageGenConfig(dir), { kind: 'request', prompt: 'a cat', requesterQq: '1' }, { fetchImpl, pollMs: 1 });
    assert.ok(!r5.ok && r5.userFacing);
    await assert.rejects(runComfy('http://x', {}, { timeoutMs: 5, pollMs: 1, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom', arrayBuffer: async () => new ArrayBuffer(0) }) }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 4. vram 文件协议：写 busy；等到 ready 且端口通才执行；结束删 busy；超时不执行
{
  const dir = mkdtempSync(join(tmpdir(), 'vram-'));
  try {
    const flags = { busy: join(dir, 'tts_busy.flag'), ready: join(dir, 'tts_ready.flag'), port: 1, waitMs: 2000 };
    let sawBusy = false;
    const pending = withTtsWindow(flags, async () => {
      sawBusy = existsSync(flags.busy);
      return 'done';
    }, { pollMs: 5, isReady: async () => true });
    // 调度器看到 busy 才腾显卡、写 ready
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(existsSync(flags.busy), true, '等待期间 busy 存在');
    writeFileSync(flags.ready, 'new');
    assert.equal(await pending, 'done');
    assert.equal(sawBusy, true, '合成时 busy 存在');
    assert.equal(existsSync(flags.busy), false, '结束后删 busy');

    // 紧接着又一句：调度器 2 秒才看一次 busy，没看到中间那次「没有 busy」，还当是同一轮，不会再写 ready。
    // 上一轮的 ready 还在就直接用（实测里第二句因此干等了 150 秒）
    const started = Date.now();
    assert.equal(await withTtsWindow(flags, async () => 'again', { pollMs: 5, isReady: async () => true }), 'again');
    assert.ok(Date.now() - started < 1000, '紧接着的第二句不该等');

    // ready 在但端口不通（语音被停去生图了，或者还在加载）：不合成
    let ran = false;
    await assert.rejects(withTtsWindow({ ...flags, waitMs: 30 }, async () => { ran = true; }, { pollMs: 5, isReady: async () => false }));
    assert.equal(ran, false, '端口不通不合成');

    // 调度器收尾时会删 ready：之后没等到新的 ready 就不合成
    rmSync(flags.ready);
    await assert.rejects(withTtsWindow({ ...flags, waitMs: 30 }, async () => { ran = true; }, { pollMs: 5, isReady: async () => true }));
    assert.equal(ran, false, '没等到 ready 不合成');
    assert.equal(existsSync(flags.busy), false, '超时也删 busy');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}


// 5. daemon 协议：一行一个 JSON，按 id 配对；出错能 reject；shutdown 后进程退出
{
  const script = `
    const rl = require('node:readline').createInterface({ input: process.stdin });
    rl.on('line', (line) => {
      const m = JSON.parse(line);
      if (m.op === 'acquire' && m.mode === 'bad') { process.stdout.write(JSON.stringify({ id: m.id, ok: false, error: 'no gpu' }) + '\\n'); return; }
      process.stdout.write(JSON.stringify({ id: m.id, ok: true, data: { op: m.op, mode: m.mode, lease: m.lease_seconds } }) + '\\n');
      if (m.op === 'shutdown') process.exit(0);
    });`;
  const cfg = { ...readVramConfig('/nonexistent'), enabled: true, leaseSeconds: 321 };
  const daemon = new VramDaemon(cfg, () => undefined, { file: process.execPath, args: ['-e', script] });
  const [a, b] = await Promise.all([daemon.request('acquire', { mode: 'image', lease_seconds: 321 }), daemon.request('status')]);
  assert.deepEqual(a, { op: 'acquire', mode: 'image', lease: 321 });
  assert.equal(b.op, 'status');
  await daemon.acquire('image', 'x');
  await assert.rejects(daemon.request('acquire', { mode: 'bad' }), /no gpu/);
  await daemon.release('x');
  await daemon.stop();
  assert.equal(readVramConfig('/nonexistent').enabled, false, '没有配置文件 = 关闭');
}

console.log('imagegen + vram tests passed');
