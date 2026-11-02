"""IndexTTS → dsh-qq-group 本地语音网关。

dsh-qq-group 的「本地 TTS 网关」协议很简单：
    GET  /health                      → 200 表示可以合成
    POST /tts  {"text","style","voice"} → 返回 WAV 字节

这个脚本把 IndexTTS（2.x 优先，1.x 兜底）包成这个协议，只用 Python 标准库起 HTTP 服务。
模型加载完成之后才开始监听端口，所以「端口能连上」就等于「可以合成」——
这正是 vram-switcher 判断 TTS 就绪的方式。

放到 IndexTTS 的目录里，用 IndexTTS 自己的虚拟环境运行，例如：
    D:\\AI\\IndexTTS\\.venv\\Scripts\\python.exe indextts_gateway.py ^
        --model-dir checkpoints --voices D:\\AI\\voices --default-voice dafeiyu --port 7861 --fp16

--voices 目录里放参考音频：<音色名>.wav（3~10 秒干净人声）。插件 TTS 设置里的「音色」填音色名即可。
插件传来的 style（例如「开心」「委屈地撒娇」）会作为 IndexTTS2 的情绪文本（emo_text）。
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


def load_engine(args: argparse.Namespace) -> None:
    global ENGINE, ENGINE_KIND
    model_dir = str(Path(args.model_dir).resolve())
    cfg_path = str(Path(args.model_dir, "config.yaml").resolve())
    try:
        from indextts.infer_v2 import IndexTTS2  # type: ignore

        ENGINE = IndexTTS2(cfg_path=cfg_path, model_dir=model_dir, use_fp16=args.fp16)
        ENGINE_KIND = "v2"
    except ImportError:
        from indextts.infer import IndexTTS  # type: ignore

        ENGINE = IndexTTS(model_dir=model_dir, cfg_path=cfg_path)
        ENGINE_KIND = "v1"
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
            if ENGINE_KIND == "v2":
                kwargs = {"spk_audio_prompt": prompt, "text": text, "output_path": out}
                if style.strip() and not ARGS.no_emotion:
                    kwargs.update({"use_emo_text": True, "emo_text": style.strip(), "emo_alpha": ARGS.emo_alpha})
                try:
                    ENGINE.infer(**kwargs)
                except TypeError:
                    # 老一点的 2.x 没有情绪参数
                    ENGINE.infer(spk_audio_prompt=prompt, text=text, output_path=out)
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
    parser.add_argument("--model-dir", default="checkpoints")
    parser.add_argument("--voices", default="voices", help="参考音频目录，放 <音色名>.wav")
    parser.add_argument("--default-voice", default="default")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7861)
    parser.add_argument("--fp16", action="store_true")
    parser.add_argument("--emo-alpha", type=float, default=0.6)
    parser.add_argument("--no-emotion", action="store_true", help="不把 style 当情绪文本")
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
