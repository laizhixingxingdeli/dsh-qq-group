# 酒馆角色卡、好感度披露、IndexTTS 语音、ComfyUI 生图

四个功能互相独立，各自一个配置目录（都在 `$DSH_HOME/dsh-qq-group/` 下，Windows 默认 `%USERPROFILE%\.dsh\dsh-qq-group\`）：

| 功能 | 目录 | 没有配置时 |
|---|---|---|
| 酒馆角色卡 + 好感披露 | `character/` | 没有卡就用原来的人设卡 |
| ComfyUI 生图 | `imagegen/` | 关闭 |
| vram-switcher 显卡调度 | `vram/` | 关闭（TTS/生图直接调用，不协调显卡） |
| IndexTTS 语音 | 插件 TTS 设置 + `tools/indextts_gateway.py` | 用原来的 Edge/GPT-SoVITS |

示例文件都在仓库的 `examples/dafeiyu/` 里；**一步步怎么装见 [DEPLOY.md](DEPLOY.md)**。

---

## 1. 酒馆角色卡

把卡放到 `character/card.json` 或 `character/card.png`（SillyTavern / Chub 导出的 V1、V2、V3 卡都行；PNG 卡里的 `chara` / `ccv3` 数据会被读出来）。保存后下一条消息生效，不用重启。

- 卡的 `description / personality / scenario / mes_example / system_prompt / post_history_instructions` 组成人设；`{{char}}`、`{{user}}` 会替换成她的名字和当前说话的人。
- **世界书**（`character_book`）：条目的关键词在最近几条消息里出现时才注入；`constant: true` 的条目一直在。
- `character/config.json`（可选）：

```json
{ "enabled": true, "replacePersona": true, "loreChars": 2500, "scanTurns": 8 }
```

`replacePersona: false` 表示角色卡追加在插件原有人设卡后面，而不是替换。

## 2. 好感度披露：按好感慢慢说出自己的设定

在卡里加 `extensions.dafeiyu`（酒馆会忽略这些字段，卡在酒馆里照常用）：

```jsonc
"extensions": { "dafeiyu": {
  "groupMaxAffinity": 60,   // 群里最多按 60 的好感解锁（一群人面前不说最私密的事）
  "newRevealTurns": 3,      // 新解锁的设定，接下来 3 次回复里提示她找机会说
  "appearance": "1girl, blue hair, whale fin ears, tail",   // 自拍用的外形 tag（别写 whale tail：在 Danbooru 里是内衣 tag）
  "tiers": [ { "min": 0, "name": "普通", "tone": "…" }, { "min": 40, "name": "朋友", "tone": "…" } ]
}}
```

世界书条目里加门槛：

```jsonc
{ "name": "想看海", "content": "她的愿望是…",
  "extensions": { "dafeiyu": { "minAffinity": 75, "privateOnly": true,
                               "lockedHint": "被问有什么愿望，就说想吃一整盆虾糊弄过去" } } }
```

规则：

| 情况 | 她看到的 |
|---|---|
| 好感够、场合对 | 条目正文（解锁后一直知道，可以自然流露） |
| 刚解锁 | 额外提示「你最近更信任 TA 了，找个自然的时机慢慢说」 |
| 好感不够或 `privateOnly` 在群里，但被问到了 | 只有 `lockedHint`（怎么搪塞），**看不到正文**，所以不会说漏 |
| 主动开口（没有对话对象） | 有门槛的条目一律不带 |

- 好感用的是插件原有的好感度（每群每人），档位语气 `tiers` 会代替插件内置的五档。
- 解锁是**按人记录**的（`character/revealed.json`）：告诉过小王的秘密，阿杰那边仍然是秘密。想让某人「重新开始」，删掉这个文件里他的 QQ 号那一段即可。

`examples/dafeiyu/card.json` 是一张完整的大肥鱼卡（v3，活人感版）：约 2900 字人设（外形、一天的作息、最近在玩/在看、自己的口味和观点、情绪惯性、不完美的说话方式）、16 段示范对话（含群聊多人场景和她主动开口）、7 档好感语气、24 条世界书——15 条人人可见（提到关键词才出现）、1 条常驻（她自己的小日常，给冷场和主动开口用）、8 条按好感 20→92 逐步解锁（其中 3 条只在私聊说）。

## 3. 本地语音：IndexTTS 或 CosyVoice3

两个网关协议相同，插件设置一样，二选一即可。CosyVoice3 用 `tools/cosyvoice_gateway.py`：参考音频配逐字稿时做零样本克隆，没有逐字稿退回跨语种模式；情绪映射到 CosyVoice3 训练过的指令（非常开心 / 非常伤心 / 非常生气 / 小声）。下面是 IndexTTS 的说明。


`tools/indextts_gateway.py` 把 IndexTTS（2.5 或 2）包成插件的「本地 TTS 网关」协议（`GET /health`、`POST /tts`）。模型加载完才开端口，所以「端口能连上 = 可以合成」，正好对应 vram-switcher 的就绪判断。

- `--version 2.5 --model-dir checkpoints`（官方默认）或 `--version 2 --model-dir checkpoints_2`；
- 回复的情绪（开心/生气/委屈…）默认转成 IndexTTS 的 8 维情绪向量，2 和 2.5 都支持，不额外占显存；`--emo-text` 改为让 IndexTTS 从文字理解情绪（2.5 会加载 Qwen 情绪模型）；
- 情绪参数被当前版本拒绝时，自动退回无情绪合成；网关挂了，插件自动退回 Edge。

安装和启动步骤见 [DEPLOY.md](DEPLOY.md#2a-indextts-语音)（CosyVoice3 见 [2B](DEPLOY.md#2b-cosyvoice3-语音)）。

## 4. ComfyUI 生图（自拍 + 帮人画）

1. 在 ComfyUI 里搭好工作流，菜单「导出（API）」存为 `imagegen/workflow.json`；自拍想用单独的工作流（比如带角色 LoRA）就再存一份 `imagegen/workflow-selfie.json`。
   工作流里写占位符：`{{prompt}}`、`{{negative}}`、`{{seed}}`、`{{width}}`、`{{height}}`。`examples/dafeiyu/workflow.json` 是最简单的 SDXL 文生图，**记得把 `ckpt_name` 换成你自己的模型文件名**。
2. 把 `examples/dafeiyu/imagegen.config.json` 复制成 `imagegen/config.json`，`enabled: true`。
3. 她在回复里决定画不画（`draw` 字段）：对方说「自拍一张」「画只猫」时，她先回一句「等我画一下」，画好再发图。

安全与限制：

- 提示词先过黑名单（色情、裸露、血腥、未成年相关），命中直接拒绝，**不会去占显卡**；反向提示词永远带 `safetyNegative`；可以在 `blockWords` 里加词。
- `perUserDaily`（每人每天）、`totalDaily`（全局每天）次数上限；同一时间只画一张。
- `scope: "selfie"` 只允许自拍。
- 自拍会在提示词前面加上角色卡的 `appearance`（没有就用配置里的 `appearance`）。

## 5. vram-switcher：语音和生图轮流用一张卡

对话走 DeepSeek 云端，显卡只给 IndexTTS 和 ComfyUI 用。12GB 卡两个同时常驻会爆显存，[vram-switcher](https://github.com/xiaoxiao150/vram-switcher) 负责轮流：

- 生图前：插件 `acquire(image)` → 它停掉 TTS 网关、拉起 ComfyUI、等端口就绪 → 出图 → `release` → 它等队列跑空、停 ComfyUI。
- 语音前：插件写 `tts_busy.flag` → 它确保 TTS 网关在线后写 `tts_ready.flag` → 插件合成 → 删 busy。
- daemon 由插件启动，语音和生图共用。用本地语音时插件一启动就拉起 daemon 并让它把语音网关预热起来（CosyVoice 开机后第一次加载可能要几分钟），不等第一句语音。`tts_busy.flag` 是 daemon 在盯，它没启动就没人响应，只能干等到 `ttsWaitSeconds` 超时。
- 上一轮留下的 `tts_ready.flag` 插件不删：两句语音间隔不到 2 秒时，daemon 看不到中间 busy 消失，不会再写一次 ready。ready 在、端口也通，就直接合成。
- 上游 vram-switcher 要先打 `examples/dafeiyu/vram-switcher-fixes.patch`，原因见 [DEPLOY.md](DEPLOY.md#41-安装)。

配置：

1. `git clone https://github.com/xiaoxiao150/vram-switcher D:\AI\vram-switcher`，按它的 README 建虚拟环境、装依赖。
2. 把 `examples/dafeiyu/vram-switcher.profile.local.json` 复制成 `D:\AI\vram-switcher\profile.local.json`，改成你的实际路径（`llm.enabled` 保持 `false`）。
3. 把 `examples/dafeiyu/vram.config.json` 复制成 `vram/config.json`，路径对上；`ttsBusyFlag/ttsReadyFlag` 不写时默认是 `<dataDir>/tts_busy.flag`、`tts_ready.flag`，**必须和 profile 里的一致**。
4. **不要再安装 vram-switcher 的 DSH 插件**——daemon 由本插件启动，两个调度器会抢同一套进程。

## 测试

```bash
node tests/character.test.mjs
node tests/imagegen.test.mjs
```
