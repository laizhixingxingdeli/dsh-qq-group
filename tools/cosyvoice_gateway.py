"""CosyVoice3（Fun-CosyVoice3-0.5B）→ dsh-qq-group 本地语音网关。

协议和 indextts_gateway.py 完全一样，插件那边不用改：
    GET  /health                        → 200 表示可以合成
    POST /tts  {"text","style","voice"}  → 返回 WAV 字节
模型加载完、音色预处理完之后才开始监听端口，所以「端口能连上 = 可以合成」，
vram-switcher 可以直接用端口判断就绪。

放到 CosyVoice 仓库根目录（和 webui.py、example.py 同级），在 CosyVoice 的 conda 环境里运行：
    conda activate cosyvoice
    python cosyvoice_gateway.py --model-dir pretrained_models/Fun-CosyVoice3-0.5B ^
        --voices D:\\AI\\voices --default-voice dafeiyu --port 7861

音色目录（--voices）：
    dafeiyu.wav   参考音频：3~10 秒、一个人、干净无背景音乐
    dafeiyu.txt   这段音频里说的话（逐字稿，UTF-8）。有它 → 零样本克隆（最像）；
                  没有 → 跨语种模式（不需要逐字稿，但像度差一些）

情绪：插件传来的 style 里含「开心/生气/难过…」时，换成 CosyVoice3 训练过的指令
（非常开心 / 非常伤心 / 非常生气 / 小声），走 inference_instruct2；认不出就按普通语气说。
--no-emotion 关掉。
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PROMPT_PREFIX = "You are a helpful assistant.<|endofprompt|>"

# CosyVoice3 训练过的指令（见 cosyvoice/utils/common.py 的 instruct_list），只用这些，效果最稳
INSTRUCTS = [
    (("开心", "高兴", "得意", "兴奋", "撒娇", "笑"), "You are a helpful assistant. 请非常开心地说一句话。<|endofprompt|>"),
    (("生气", "愤怒", "不耐烦", "凶"), "You are a helpful assistant. 请非常生气地说一句话。<|endofprompt|>"),
    (("难过", "伤心", "哭", "委屈", "失落", "丧"), "You are a helpful assistant. 请非常伤心地说一句话。<|endofprompt|>"),
    (("小声", "悄悄", "温柔", "困", "害羞"), "You are a helpful assistant. Please say a sentence in a very soft voice.<|endofprompt|>"),
]

LOCK = threading.Lock()
ENGINE = None
VOICES: dict[str, dict] = {}
ARGS: argparse.Namespace


def instruct_for(style: str) -> str | None:
    for words, instruct in INSTRUCTS:
        if any(word in style for word in words):
            return instruct
    return None


def safe_name(name: str) -> str:
    return "".join(ch for ch in (name or "") if ch.isalnum() or ch in "-_")


def load_voices(voices_dir: str) -> None:
    """扫描音色目录；有逐字稿的预先注册成零样本说话人（之后每次合成不用重新提特征）。"""
    VOICES.clear()
    for wav in sorted(Path(voices_dir).glob("*.wav")):
        name = safe_name(wav.stem)
        if not name:
            continue
        txt = wav.with_suffix(".txt")
        transcript = txt.read_text(encoding="utf-8").strip() if txt.is_file() else ""
        entry = {"wav": str(wav), "transcript": transcript, "spk": ""}
        if transcript:
            spk = f"gw_{name}"
            ENGINE.add_zero_shot_spk(PROMPT_PREFIX + transcript, str(wav), spk)
            entry["spk"] = spk
        VOICES[name] = entry
        mode = "零样本（有逐字稿）" if transcript else "跨语种（没有逐字稿，像度较低）"
        print(f"[gateway] 音色 {name}：{mode}", flush=True)
    if not VOICES:
        raise SystemExit(f"[gateway] {voices_dir} 里没有 .wav 参考音频")


def load_engine(args: argparse.Namespace) -> None:
    global ENGINE
    model_dir = Path(args.model_dir)
    if not (model_dir / "cosyvoice3.yaml").is_file():
        raise SystemExit(
            f"[gateway] {model_dir} 里没有 cosyvoice3.yaml：--model-dir 要指向 Fun-CosyVoice3-0.5B 模型目录"
        )
    # CosyVoice 依赖仓库里的 Matcha-TTS 子模块
    sys.path.insert(0, str(Path.cwd() / "third_party" / "Matcha-TTS"))
    from cosyvoice.cli.cosyvoice import AutoModel  # type: ignore

    ENGINE = AutoModel(model_dir=str(model_dir), fp16=args.fp16)
    print(f"[gateway] CosyVoice3 已加载：{model_dir}（采样率 {ENGINE.sample_rate}）", flush=True)


def encode_wav(chunks, sample_rate: int) -> bytes:
    """把模型输出的若干段 tts_speech（[1, T] 浮点张量）拼成 16bit 单声道 WAV。"""
    import numpy as np

    parts = [np.asarray(chunk.cpu().numpy(), dtype=np.float32).reshape(-1) for chunk in chunks]
    if not parts:
        raise RuntimeError("CosyVoice 没有输出音频")
    audio = np.clip(np.concatenate(parts), -1.0, 1.0)
    pcm = (audio * 32767.0).astype("<i2").tobytes()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(int(sample_rate))
        out.writeframes(pcm)
    return buffer.getvalue()


def synthesize(text: str, style: str, voice: str) -> bytes:
    entry = VOICES.get(safe_name(voice)) or VOICES.get(ARGS.default_voice) or next(iter(VOICES.values()))
    instruct = None if ARGS.no_emotion else instruct_for(style)
    with LOCK:  # 一张卡一次只合成一句
        if instruct is not None:
            outputs = ENGINE.inference_instruct2(text, instruct, entry["wav"], stream=False, speed=ARGS.speed)
        elif entry["spk"]:
            outputs = ENGINE.inference_zero_shot(text, "", "", zero_shot_spk_id=entry["spk"], stream=False, speed=ARGS.speed)
        else:
            outputs = ENGINE.inference_cross_lingual(PROMPT_PREFIX + text, entry["wav"], stream=False, speed=ARGS.speed)
        chunks = [item["tts_speech"] for item in outputs]
    return encode_wav(chunks, ENGINE.sample_rate)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # 安静一点
        if ARGS.verbose:
            super().log_message(fmt, *args)

    def _send(self, code: int, body: bytes, kind: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.rstrip("/") == "/health":
            body = {"ok": True, "engine": "cosyvoice3", "voices": sorted(VOICES)}
            self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), "application/json")
        else:
            self._send(404, b"not found", "text/plain")

    def do_POST(self) -> None:  # noqa: N802
        if self.path.rstrip("/") != "/tts":
            self._send(404, b"not found", "text/plain")
            return
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 64 * 1024)
            payload = json.loads(self.rfile.read(length) or b"{}")
            text = str(payload.get("text") or "").strip()[: ARGS.max_chars]
            if not text:
                self._send(400, "text 为空".encode("utf-8"), "text/plain; charset=utf-8")
                return
            started = time.time()
            data = synthesize(text, str(payload.get("style") or ""), str(payload.get("voice") or ""))
            print(f"[gateway] 合成 {len(text)} 字，用时 {time.time() - started:.1f}s", flush=True)
            self._send(200, data, "audio/wav")
        except Exception as exc:  # 把错误告诉插件，插件会回退 Edge
            print(f"[gateway] 合成失败：{exc}", file=sys.stderr, flush=True)
            self._send(500, str(exc).encode("utf-8", "replace"), "text/plain; charset=utf-8")


def main() -> None:
    global ARGS
    parser = argparse.ArgumentParser(description="CosyVoice3 gateway for dsh-qq-group")
    parser.add_argument("--model-dir", default="pretrained_models/Fun-CosyVoice3-0.5B")
    parser.add_argument("--voices", default="voices", help="参考音频目录：<音色名>.wav + 可选 <音色名>.txt 逐字稿")
    parser.add_argument("--default-voice", default="default")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7861)
    parser.add_argument("--fp16", action="store_true", help="半精度，省显存（没有 CUDA 时自动关闭）")
    parser.add_argument("--speed", type=float, default=1.0, help="语速倍率")
    parser.add_argument("--no-emotion", action="store_true", help="不按 style 切换语气")
    parser.add_argument("--max-chars", type=int, default=200)
    parser.add_argument("--verbose", action="store_true")
    ARGS = parser.parse_args()
    if ARGS.host not in ("127.0.0.1", "localhost", "::1"):
        print("[gateway] 只建议监听本机地址", file=sys.stderr)
    load_engine(ARGS)
    load_voices(ARGS.voices)
    server = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)  # 模型和音色都准备好才开端口
    print(f"[gateway] 监听 http://{ARGS.host}:{ARGS.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
