"""IndexTTS → dsh-qq-group 本地语音网关。

dsh-qq-group 的「本地 TTS 网关」协议很简单：
    GET  /health                      → 200 表示可以合成
    POST /tts  {"text","style","voice"} → 返回 WAV 字节

这个脚本把 IndexTTS 包成这个协议（--version 选 2.5 / 2 / 1），只用 Python 标准库起 HTTP 服务。
模型加载完成之后才开始监听端口，所以「端口能连上」就等于「可以合成」——
这正是 vram-switcher 判断 TTS 就绪的方式。

放到 IndexTTS 仓库根目录（和 webui.py 同级），用 IndexTTS 自己的 uv 虚拟环境运行：
    IndexTTS-2.5（官方默认，模型在 checkpoints/）：
        .venv\\Scripts\\python.exe indextts_gateway.py --version 2.5 --model-dir checkpoints --voices D:\\AI\\voices --default-voice dafeiyu --port 7861 --half
    IndexTTS-2（模型在 checkpoints_2/）：
        .venv\\Scripts\\python.exe indextts_gateway.py --version 2 --model-dir checkpoints_2 --voices D:\\AI\\voices --default-voice dafeiyu --port 7861 --half

--voices 目录里放参考音频：<音色名>.wav（3~10 秒干净人声）。插件 TTS 设置里的「音色」填音色名即可。

情绪：插件传来的 style 里如果含「开心/生气/难过/吃惊/恐惧/厌恶/委屈/平静」等词，会换成 IndexTTS 的
8 维情绪向量（emo_vector，2 和 2.5 都支持，不需要额外的情绪模型、不多占显存）；中立或认不出就不加情绪。
想让 IndexTTS 自己从文字理解情绪，可以加 --emo-text（2.5 会额外加载 Qwen 情绪模型，多占显存）。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LOCK = threading.Lock()
ENGINE = None
ENGINE_KIND = ""
ARGS: argparse.Namespace


# 情绪向量顺序（IndexTTS 官方）：[happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]
EMOTION_WORDS = [
    (("开心", "高兴", "得意", "兴奋", "撒娇", "笑"), 0),
    (("生气", "愤怒", "不耐烦", "凶"), 1),
    (("难过", "伤心", "哭"), 2),
    (("恐惧", "害怕", "吓"), 3),
    (("厌恶", "嫌弃", "恶心"), 4),
    (("委屈", "失落", "忧郁", "丧"), 5),
    (("吃惊", "惊讶", "震惊"), 6),
    (("平静", "温柔", "困", "懒"), 7),
]


def emotion_vector(style: str, strength: float) -> list[float] | None:
    for words, index in EMOTION_WORDS:
        if any(word in style for word in words):
            vector = [0.0] * 8
            vector[index] = max(0.0, min(1.0, strength))
            return vector
    return None


def load_engine(args: argparse.Namespace) -> None:
    global ENGINE, ENGINE_KIND
    model_dir = str(Path(args.model_dir).resolve())
    cfg_path = str(Path(args.model_dir, "config.yaml").resolve())
    if not Path(cfg_path).is_file():
        raise SystemExit(f"[gateway] 找不到 {cfg_path}：--model-dir 指错了（2.5 默认 checkpoints，2 默认 checkpoints_2）")
    if args.version == "2.5":
        from indextts.infer_v2_5 import IndexTTS2  # type: ignore

        kwargs = {"cfg_path": cfg_path, "model_dir": model_dir, "use_bf16": args.half}
        if args.emo_text:
            kwargs["use_qwen_emo"] = True  # 2.5 用 use_emo_text 必须开这个，否则 RuntimeError
        ENGINE = IndexTTS2(**kwargs)
    elif args.version == "2":
        from indextts.infer_v2 import IndexTTS2  # type: ignore

        ENGINE = IndexTTS2(cfg_path=cfg_path, model_dir=model_dir, use_fp16=args.half)
    else:
        from indextts.infer import IndexTTS  # type: ignore

        ENGINE = IndexTTS(model_dir=model_dir, cfg_path=cfg_path)
    ENGINE_KIND = args.version
    print(f"[gateway] IndexTTS {ENGINE_KIND} 已加载：{model_dir}", flush=True)


def voice_file(name: str) -> Path:
    voices = Path(ARGS.voices)
    safe = "".join(ch for ch in (name or "") if ch.isalnum() or ch in "-_") or ARGS.default_voice
    for candidate in (voices / f"{safe}.wav", voices / f"{ARGS.default_voice}.wav"):
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(f"找不到参考音频：{voices / (safe + '.wav')}")


def synthesize(text: str, style: str, voice: str) -> bytes:
    prompt = str(voice_file(voice))
    fd, out = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        with LOCK:  # 一张卡一次只合成一句
            if ENGINE_KIND in ("2", "2.5"):
                kwargs = {"spk_audio_prompt": prompt, "text": text, "output_path": out}
                if ENGINE_KIND == "2.5":
                    kwargs["lang"] = ARGS.lang
                if style.strip() and not ARGS.no_emotion:
                    if ARGS.emo_text:
                        kwargs.update({"use_emo_text": True, "emo_text": style.strip(), "emo_alpha": ARGS.emo_alpha})
                    else:
                        vector = emotion_vector(style, ARGS.emo_strength)
                        if vector is not None:
                            kwargs["emo_vector"] = vector
                try:
                    ENGINE.infer(**kwargs)
                except (TypeError, RuntimeError) as exc:
                    if len(kwargs) <= 4:
                        raise
                    # 情绪参数不被这个版本接受：去掉情绪再合成一次，至少别把语音丢了
                    print(f"[gateway] 情绪参数被拒（{exc}），改用无情绪合成", file=sys.stderr, flush=True)
                    plain = {k: kwargs[k] for k in ("spk_audio_prompt", "text", "output_path", "lang") if k in kwargs}
                    ENGINE.infer(**plain)
            else:
                ENGINE.infer(prompt, text, out)
        data = Path(out).read_bytes()
        if data[:4] != b"RIFF":
            raise RuntimeError("IndexTTS 没有输出 WAV")
        return data
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args) -> None:  # noqa: D401 - 安静一点
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
            self._send(200, json.dumps({"ok": True, "engine": ENGINE_KIND}).encode(), "application/json")
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
                self._send(400, "text 为空".encode(), "text/plain; charset=utf-8")
                return
            started = time.time()
            wav = synthesize(text, str(payload.get("style") or ""), str(payload.get("voice") or ""))
            print(f"[gateway] 合成 {len(text)} 字，用时 {time.time() - started:.1f}s", flush=True)
            self._send(200, wav, "audio/wav")
        except Exception as exc:  # 把错误告诉插件，插件会回退 Edge
            print(f"[gateway] 合成失败：{exc}", file=sys.stderr, flush=True)
            self._send(500, str(exc).encode("utf-8", "replace"), "text/plain; charset=utf-8")


def main() -> None:
    global ARGS
    parser = argparse.ArgumentParser(description="IndexTTS gateway for dsh-qq-group")
    parser.add_argument("--version", choices=["2.5", "2", "1"], default="2.5", help="IndexTTS 版本（2.5 是官方默认）")
    parser.add_argument("--model-dir", default="checkpoints")
    parser.add_argument("--voices", default="voices", help="参考音频目录，放 <音色名>.wav")
    parser.add_argument("--default-voice", default="default")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7861)
    parser.add_argument("--half", "--fp16", dest="half", action="store_true", help="半精度（2.5 用 BF16，2 用 FP16），省显存")
    parser.add_argument("--lang", default="ZH", help="2.5 的语言（ZH / EN / …）")
    parser.add_argument("--emo-strength", type=float, default=0.5, help="情绪向量强度 0~1")
    parser.add_argument("--emo-text", action="store_true", help="让 IndexTTS 从 style 文字理解情绪（2.5 会加载 Qwen 情绪模型）")
    parser.add_argument("--emo-alpha", type=float, default=0.6, help="--emo-text 时的情绪强度")
    parser.add_argument("--no-emotion", action="store_true", help="完全不加情绪")
    parser.add_argument("--max-chars", type=int, default=200)
    parser.add_argument("--verbose", action="store_true")
    ARGS = parser.parse_args()
    if ARGS.host not in ("127.0.0.1", "localhost", "::1"):
        print("[gateway] 只建议监听本机地址", file=sys.stderr)
    load_engine(ARGS)  # 先加载模型，再开端口：端口通 = 可以合成
    server = ThreadingHTTPServer((ARGS.host, ARGS.port), Handler)
    print(f"[gateway] 监听 http://{ARGS.host}:{ARGS.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
