# 部署指南：角色卡 / 好感披露 / IndexTTS 语音 / ComfyUI 生图 / vram-switcher

本文写给**家用 Windows + NVIDIA 显卡（12GB 以上）**。对话模型走 DeepSeek 云端（或 DSH 登录的订阅），显卡只用来跑 IndexTTS 语音和 ComfyUI 生图。

> 功能说明（各字段含义、规则）见 [CHARACTER.md](CHARACTER.md)；人物档案见 [DOSSIER.md](DOSSIER.md)。本文只讲怎么装。

**建议按顺序做，每一步单独验收**，出问题容易定位：

| 步骤 | 内容 | 需要显卡 | 不做的话 |
|---|---|---|---|
| 0 | 装好插件本体（本分支） | 否 | — |
| 1 | 角色卡 + 好感披露 | 否 | 用原来的人设卡 |
| 2 | 本地语音：IndexTTS（2A）**或** CosyVoice3（2B），二选一 | 是 | 用 Edge 语音 |
| 3 | ComfyUI 生图 | 是 | 不能自拍/画图 |
| 4 | vram-switcher 串起来 | 是 | 2、3 同时常驻，12GB 卡容易爆显存 |

下文路径统一用：

```text
D:\AI\index-tts                      IndexTTS
D:\AI\voices                         参考音频
D:\AI\ComfyUI_windows_portable       ComfyUI 便携版
D:\AI\vram-switcher                  vram-switcher
%USERPROFILE%\.dsh\dsh-qq-group      插件数据目录（下文简称「数据目录」）
```

路径换成你自己的就行，但**不要有中文和空格**。

---

## 版本要求（2026-11 核对）

| 组件 | 要求 | 说明 |
|---|---|---|
| DeepSeek Harness | **0.2.0-rc.1 ≤ 版本 < 0.3.0**（已核对 0.2.1-rc.5 可装） | DSH 安装插件时会用 `includePrerelease` 检查插件对 `@deepseek-ai/dsh-*` 的 peerDependencies（本插件写的是 `^0.2.0-rc.1`）。DSH 升到 0.3.x 时会拒绝安装，需要等插件更新 |
| Node.js | ≥ 22.12（推荐装 LTS） | 插件 `engines` 要求；跑测试用的 TypeScript 去类型执行在 22.18+ 默认开启，22.12~22.17 要加 `--experimental-strip-types` |
| pnpm | ≥ 9 | DSH 用 PATH 里的 pnpm 管理插件 |
| NapCat | 支持 OneBot 11 正向 WebSocket 的版本 | 见主部署指南 |
| IndexTTS | **2.5（官方默认）或 2** | 用 uv 安装（官方要求）；CUDA Toolkit 12.8+；2.5 模型放 `checkpoints`，2 放 `checkpoints_2` |
| CosyVoice3 | **Fun-CosyVoice3-0.5B-2512** | 官方要求 conda + Python 3.10、torch 2.3.1；Windows 上不支持 TensorRT/DeepSpeed（requirements 已自动跳过），文本规整用 wetext，不需要 pynini |
| ComfyUI | 带 HTTP API 的版本（`/prompt`、`/history`、`/view`） | 便携版即可 |
| vram-switcher | Python ≥ 3.10，依赖 `psutil` | 只在 N 卡 Windows 上实测过 |
| 显卡 | N 卡 12GB+ | 8GB 也能跑，但要用 SD1.5 或低显存模式 |

如果 `dsh plugin add` 提示 `installation rejected … is incompatible with dsh x.y.z`，说明 DSH 版本超出了上表范围。DSH 给的临时绕过命令（`allow-version … --accept-risk`）**可能导致插件运行出错，不建议用**，先告诉我版本号，我来更新插件。

---

## 0. 插件本体

按主部署指南 / 安装提示词装好本分支（`laizhixingxingdeli/dsh-qq-group` 的 `feature/dossier`）。已经装过的，更新：

```bash
cd %USERPROFILE%\dafeiyu\dsh-qq-group
git pull
pnpm install
pnpm run build
```

然后完全退出并重开 DSH。

**验收**：

```bash
node tests/dossier.test.mjs
node tests/character.test.mjs
node tests/imagegen.test.mjs
```

三条都输出 `… passed`。

---

## 1. 角色卡 + 好感披露

1. 建目录 `数据目录\character\`。
2. 把仓库里的 `examples\dafeiyu\card.json` 复制进去，名字保持 `card.json`。
   也可以用你自己的酒馆卡：PNG 卡直接改名成 `card.png` 放进去。
3. 不用重启：下一条消息就会生效，DSH 日志会出现 `角色卡已载入：大肥鱼（世界书 16 条）`。
4. 可选：`数据目录\character\config.json`

```json
{ "enabled": true, "replacePersona": true, "loreChars": 2500, "scanTurns": 8 }
```

`replacePersona: true` 表示角色卡**代替**设置页里的人设卡；想保留原人设、角色卡追加在后面，就设成 `false`。

**验收**（群里和私聊各试一次）：

| 操作 | 预期 |
|---|---|
| 群里叫她「大肥鱼」 | 嘴硬否认 |
| 群里一个好感普通的人问「你怕打雷吗」 | 说「才不怕」并岔开话题（没解锁） |
| 私聊里让主人问「你有什么愿望」 | 主人初始好感是 60，「想看海」需要 75，所以应该搪塞「想吃一整盆虾」 |
| 打开 `数据目录\character\revealed.json` | 能看到每个人解锁了哪些条目的 id |

**想测试高好感的效果**：完全退出 DSH，备份 `数据目录\profiles.json` 后，把测试账号某个会话里的 `affinity` 临时改成 90，重开 DSH 私聊她；测完把备份换回来。想让某人"从头开始"，删掉 `revealed.json` 里这个人 QQ 号那一段即可。

**改人设**：直接改 `card.json`（用记事本另存为 UTF-8）。改完可以拖进 SillyTavern 看看能不能正常识别，用来检查格式。

---

## 2. 本地语音（二选一）

| | IndexTTS（2A） | CosyVoice3（2B） |
|---|---|---|
| 安装方式 | uv（官方） | conda + Python 3.10（官方） |
| 音色 | 一段参考音频 | 参考音频 **+ 逐字稿**（没有逐字稿也能用，但像度差一些） |
| 情绪 | 8 维情绪向量，比较细 | 训练过的几种指令：非常开心 / 非常伤心 / 非常生气 / 小声 |
| 网关脚本 | `tools/indextts_gateway.py` | `tools/cosyvoice_gateway.py` |

两个网关对插件来说完全一样（同一个协议、同一个端口 7861），**插件设置不用改**，换网关只需要换启动命令。只装一个就行。

## 2A. IndexTTS 语音

### 2A.1 安装 IndexTTS（官方方式：uv）

```bash
cd D:\AI
git clone https://github.com/index-tts/index-tts.git
cd index-tts
pip install -U uv
uv sync --extra webui --default-index "https://mirrors.aliyun.com/pypi/simple"
```

- Windows 上 DeepSpeed 很难装，所以这里没用 `--all-extras`。
- 安装时如果出现 CUDA 报错，先装 NVIDIA **CUDA Toolkit 12.8 或更新版本**。

### 2A.2 下载模型（2.5）

```bash
uv tool install "huggingface-hub"
set HF_ENDPOINT=https://hf-mirror.com
hf download IndexTeam/IndexTTS-2.5 --local-dir=checkpoints
```

用 ModelScope 下载也行：`uv tool install modelscope-hub`，然后 `modelscope download --model IndexTeam/IndexTTS-2.5 --local_dir checkpoints`。

检查显卡能不能用：

```bash
uv run tools/gpu_check.py
```

### 2A.3 准备音色

`D:\AI\voices\dafeiyu.wav`：3~10 秒、一个人说话、没有背景音乐的干净录音。**只用你有权使用的声音**，不要拿真人声优或主播的声音做音色。

### 2A.4 启动网关

把仓库里的 `tools\indextts_gateway.py` 复制到 `D:\AI\index-tts\`（和 `webui.py` 放在同一级），然后运行：

```bash
cd D:\AI\index-tts
.venv\Scripts\python.exe indextts_gateway.py --version 2.5 --model-dir checkpoints --voices D:\AI\voices --default-voice dafeiyu --port 7861 --half
```

看到 `[gateway] 监听 http://127.0.0.1:7861` 就说明启动好了。第一次启动加载模型需要一两分钟。

- 用 IndexTTS-2 的话：`--version 2 --model-dir checkpoints_2`。
- 情绪默认用「情绪向量」，不额外占显存。想让 IndexTTS 自己从文字理解情绪，加 `--emo-text`（2.5 会多加载一个 Qwen 情绪模型）。

**单独验收网关**（另开一个窗口）：

```bash
curl --noproxy "*" http://127.0.0.1:7861/health
curl --noproxy "*" -X POST http://127.0.0.1:7861/tts -H "content-type: application/json" -d "{\"text\":\"你好呀\",\"style\":\"开心\",\"voice\":\"dafeiyu\"}" --output test.wav
```

能播放 `test.wav` 就说明网关没问题。

### 2A.5 插件设置

DSH 设置 →「QQ 群聊」→ 语音：

- 引擎：**GPT-SoVITS（本地网关）**。插件把所有本地网关都归在这一项下，选它就行。
- 网关地址：`http://127.0.0.1:7861`
- 音色：`dafeiyu`
- 语气（style）留空：留空时会自动用每条回复的情绪。

**验收**：在群里说「发条语音」，她发来的应该是 IndexTTS 的音色。如果听到的是 Edge 的标准女声，说明网关没连上，去 DSH 日志里搜「本地 TTS 失败」查原因。

---

## 2B. CosyVoice3 语音

### 2B.1 安装 CosyVoice（官方方式：conda）

```bash
cd D:\AI
git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git
cd CosyVoice
git submodule update --init --recursive
conda create -n cosyvoice -y python=3.10
conda activate cosyvoice
pip install -r requirements.txt -i https://mirrors.aliyun.com/pypi/simple/ --trusted-host=mirrors.aliyun.com
```

- `--recursive` 和 `git submodule update` 不能省：网关依赖子模块 `third_party\Matcha-TTS`。
- requirements 里的 deepspeed、tensorrt、onnxruntime-gpu 只在 Linux 上装，Windows 会自动跳过，这是正常的。
- 如果 torch 装成了 CPU 版（`python -c "import torch;print(torch.cuda.is_available())"` 输出 False），按 requirements 顶部的 `--extra-index-url https://download.pytorch.org/whl/cu121` 重新装 `torch==2.3.1 torchaudio==2.3.1`。

### 2B.2 下载模型

```bash
conda activate cosyvoice
python -c "from modelscope import snapshot_download; snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512', local_dir='pretrained_models/Fun-CosyVoice3-0.5B')"
```

下载完，`pretrained_models\Fun-CosyVoice3-0.5B\cosyvoice3.yaml` 应该存在。`CosyVoice-ttsfrd` 只能在 Linux 上用，Windows 不用下载。

### 2B.3 准备音色

```text
D:\AI\voices\dafeiyu.wav   3~10 秒、一个人、干净无背景音乐（只用你有权使用的声音）
D:\AI\voices\dafeiyu.txt   这段音频里说的话，一字不差，UTF-8 编码
```

有逐字稿，网关会做**零样本克隆**，音色最像；没有逐字稿，会退回**跨语种模式**，能用但像度差一些。启动日志会写明每个音色用的是哪种模式。

### 2B.4 启动网关

把仓库里的 `tools\cosyvoice_gateway.py` 复制到 `D:\AI\CosyVoice\`（和 `webui.py` 放在同一级），然后运行：

```bash
cd D:\AI\CosyVoice
conda activate cosyvoice
python cosyvoice_gateway.py --model-dir pretrained_models/Fun-CosyVoice3-0.5B --voices D:\AI\voices --default-voice dafeiyu --port 7861 --fp16
```

看到 `[gateway] 监听 http://127.0.0.1:7861` 就说明启动好了。

- `--speed 1.1`：语速稍快一点。
- `--no-emotion`：不切换语气，一直用零样本克隆，音色最稳。

**单独验收**：和 2A.4 一样，用 `curl --noproxy "*"` 调 `/health` 和 `/tts`。`/health` 的返回里会列出识别到的音色。

### 2B.5 插件设置

和 2A.5 完全一样：引擎选 **GPT-SoVITS（本地网关）**，地址 `http://127.0.0.1:7861`，音色 `dafeiyu`。

## 3. ComfyUI 生图

### 3.1 安装

1. 下载 ComfyUI Windows 便携版（官方 GitHub Releases），解压到 `D:\AI\ComfyUI_windows_portable`。
2. 把一个 **SDXL 动漫风格模型**（`.safetensors`）放进 `ComfyUI\models\checkpoints\`。
3. 双击 `run_nvidia_gpu.bat`，浏览器打开 `http://127.0.0.1:8188`，先手动生成一张图，确认能出图。

### 3.2 工作流

最简单的做法：把 `examples\dafeiyu\workflow.json` 复制到 `数据目录\imagegen\workflow.json`，然后**把里面的 `ckpt_name` 改成你的模型文件名**。

用自己的工作流：

1. 在 ComfyUI 里搭好工作流，菜单 → **导出（API）**。
2. 把正向提示词改成 `{{prompt}}`，可以前后加固定内容，比如 `masterpiece, {{prompt}}`；反向提示词改成 `{{negative}}`；种子填 `{{seed}}`；宽高填 `{{width}}`、`{{height}}`。
3. 存成 `数据目录\imagegen\workflow.json`。自拍想用另一套工作流（比如带角色 LoRA、IPAdapter 保持长相一致），就另存一份 `workflow-selfie.json`。

### 3.3 配置

把 `examples\dafeiyu\imagegen.config.json` 复制成 `数据目录\imagegen\config.json`。**还没装 vram-switcher 时，先把 `useVram` 改成 `false`**：

```json
{
  "enabled": true,
  "endpoint": "http://127.0.0.1:8188",
  "scope": "all",
  "width": 832,
  "height": 1216,
  "perUserDaily": 5,
  "totalDaily": 30,
  "useVram": false
}
```

- `scope: "selfie"` 表示只允许自拍，不帮人画图。
- 自拍会自动在提示词前面加上角色卡里的 `appearance` 外形描述。

**验收**（ComfyUI 要开着）：

| 操作 | 预期 |
|---|---|
| 群里说「自拍一张」 | 她先回「等我画一下」之类的话，几十秒后发图 |
| 说「画一只戴帽子的猫」 | 画猫 |
| 说「画个色图」 | 直接拒绝，**不会调用 ComfyUI** |
| 同一个人一天要第 6 张 | 回「你今天已经让我画好几张了」 |

生成的图会保存在 `数据目录\imagegen\out\`。

---

## 4. vram-switcher：语音和生图轮流用显卡

12GB 显卡上，IndexTTS（2~5GB）和 ComfyUI（6~7GB）再加上桌面占用，同时常驻会爆显存。爆显存时 Windows 不会报错，而是**慢一百倍**。vram-switcher 负责让两者轮流使用显卡：

- 画图时：停掉语音网关 → 拉起 ComfyUI → 画完等队列跑空 → 停掉 ComfyUI；
- 说话时：确保语音网关在线 → 合成。

### 4.1 安装

```bash
cd D:\AI
git clone https://github.com/xiaoxiao150/vram-switcher
cd vram-switcher
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
mkdir data
```

这里的 Python 版本要 ≥ 3.10。

### 4.2 profile

1. 把本仓库的 `examples\dafeiyu\vram-switcher.profile.local.json`（IndexTTS 用）或 `vram-switcher.profile.cosyvoice.json`（CosyVoice3 用），复制成 `D:\AI\vram-switcher\profile.local.json`。
2. 按你的实际情况改：
   - 文件里所有 `D:/AI/...` 路径（**用正斜杠**）；
   - `services.tts.versions` 里的启动命令，要和你在 2A.4 或 2B.4 里手动启动网关的命令一致。CosyVoice3 要写 conda 环境里 `python.exe` 的完整路径，比如 `C:/Users/你的用户名/miniconda3/envs/cosyvoice/python.exe`；
   - `services.image.start.args`，ComfyUI 便携版的 `python_embeded\python.exe` 和 `main.py`。
3. `services.llm.enabled` 保持 `false`：对话走云端，不需要调度本地大模型。

先检查 profile 能不能被读取：

```bash
.venv\Scripts\python.exe -c "from vram_switcher import load_config; c=load_config({'profile_path':'profile.local.json'}, plugin_dir='.', data_dir='data'); print('errors:', c.errors); print('warnings:', c.warnings)"
```

`errors` 必须是空列表。

### 4.3 插件配置

把 `examples\dafeiyu\vram.config.json` 复制成 `数据目录\vram\config.json`：

```json
{
  "enabled": true,
  "python": "D:/AI/vram-switcher/.venv/Scripts/python.exe",
  "switcherDir": "D:/AI/vram-switcher",
  "profile": "D:/AI/vram-switcher/profile.local.json",
  "dataDir": "D:/AI/vram-switcher/data",
  "ttsPort": 7861,
  "ttsWaitSeconds": 150,
  "leaseSeconds": 900
}
```

- `dataDir` 必须和 profile 里 `busy_flag`、`ready_flag` 所在的目录一致。默认这两个文件是 `data/tts_busy.flag` 和 `data/tts_ready.flag`。
- 回到 `数据目录\imagegen\config.json`，把 `useVram` 改回 `true`。
- **不要再安装 vram-switcher 自带的 DSH 插件**。它的后台进程由本插件负责启动，装两份会有两个调度器抢着停/起同一批进程。
- 改完重启 DSH。

### 4.4 验收

1. **先手动关掉** IndexTTS 网关和 ComfyUI，之后交给 vram-switcher 去启动。
2. 群里说「发条语音」：vram-switcher 会自动拉起语音网关，第一次要等 1~2 分钟，之后正常发出语音。
3. 说「自拍一张」：语音网关被停掉、ComfyUI 被拉起，出图后 ComfyUI 被停掉。
4. 再说「发条语音」：语音网关重新被拉起。
5. 整个过程打开任务管理器 →「性能」→ GPU，专用显存不应该接近占满。

DSH 日志里以 `[vram]` 开头的行是 vram-switcher 的输出，有问题先看这里。

---

## 5. 备份

`backup.ps1` 备份的是整个 `数据目录`，里面已经包含 `character\`（包括 `revealed.json` 披露记录）、`imagegen\config.json` 和工作流、`vram\config.json`。

下面这些**不在数据目录里**，需要另外备份：
- `D:\AI\voices\`（音色）；
- `D:\AI\vram-switcher\profile.local.json`；
- 你自己的 ComfyUI 工作流原件。

---

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 测试或 curl 访问 `127.0.0.1` 返回 502 Bad Gateway | 开着代理软件（Clash 等），本机请求被转给了代理。curl 加 `--noproxy "*"`；或在代理软件里把 `127.0.0.1`、`localhost` 设为直连 |
| `dsh plugin add` 报 `installation rejected … incompatible with dsh` | DSH 版本超出 `0.2.x` 范围，见「版本要求」 |
| 日志：`角色卡解析失败` | `card.json` 不是合法 JSON（多半是逗号或引号问题），或者文件编码不是 UTF-8 |
| 她说出了还没解锁的秘密 | 检查那条设定的 `minAffinity` 是否写在 `extensions.dafeiyu` 里面，写在别处不生效；再看 `revealed.json` 里这个人是不是早就解锁过 |
| 语音一直是 Edge 的声音 | 网关没启动或端口不对；或者接了 vram-switcher 后 150 秒内没就绪（看 `tts.log`） |
| CosyVoice 网关报 `没有 cosyvoice3.yaml` | `--model-dir` 没指向 Fun-CosyVoice3-0.5B 目录，或者模型没下载完 |
| CosyVoice 网关报 `No module named 'matcha'` | 克隆时没加 `--recursive`：在 CosyVoice 目录运行 `git submodule update --init --recursive` |
| CosyVoice 音色不像 | 给参考音频配上逐字稿 `.txt`，并确认内容一字不差 |
| 网关启动报 `找不到 …config.yaml` | `--model-dir` 指错了：2.5 用 `checkpoints`，2 用 `checkpoints_2` |
| 网关日志：`情绪参数被拒` | 当前 IndexTTS 版本不接受情绪参数，网关会自动退回无情绪合成，语音不受影响 |
| 生图回「画崩了」 | 看 ComfyUI 窗口的报错，最常见的是 `ckpt_name` 和模型文件名对不上 |
| 生图很慢（几分钟一张） | 显存爆了在换页：没接 vram-switcher，或者 profile 里语音网关的进程匹配不上，导致没停掉 |
| 日志：`vram-switcher daemon 退出` | `python` 或 `switcherDir` 路径不对，或者 vram-switcher 的依赖没装 |

## 7. 测试命令汇总

```bash
node tests/dossier.test.mjs
node tests/character.test.mjs
node tests/imagegen.test.mjs
python tests/test_indextts_gateway.py
python tests/test_cosyvoice_gateway.py
```

最后两条用假引擎测网关协议，不需要显卡，用系统里任意 Python 3.10+ 都能跑。
