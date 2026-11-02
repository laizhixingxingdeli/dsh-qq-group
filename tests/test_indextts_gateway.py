"""indextts_gateway.py 的协议测试：用假的 IndexTTS 引擎，不需要显卡和模型。

    python tests/test_indextts_gateway.py
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import types
import urllib.error
import urllib.request
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

# 只连本机：不走系统代理（Windows 上开着 Clash/v2rayN 时，urllib 会把 127.0.0.1 也发给代理，返回 502）
LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))

CALLS: list[dict] = []
INITS: list[dict] = []


def write_wav(path: str) -> None:
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\0\0" * 160)


def make_engine(reject_emotion: bool):
    class IndexTTS2:
        def __init__(self, **kw):
            INITS.append(kw)

        def infer(self, spk_audio_prompt, text, output_path, **kw):
            if reject_emotion and ("emo_vector" in kw or "use_emo_text" in kw):
                raise RuntimeError("use_emo_text requires use_qwen_emo=True")
            CALLS.append({"voice": Path(spk_audio_prompt).name, "text": text, **kw})
            write_wav(output_path)

    return IndexTTS2


def install_fake(reject_emotion: bool = False) -> None:
    pkg = types.ModuleType("indextts")
    for name in ("infer_v2", "infer_v2_5"):
        mod = types.ModuleType(f"indextts.{name}")
        mod.IndexTTS2 = make_engine(reject_emotion)
        sys.modules[f"indextts.{name}"] = mod
    sys.modules["indextts"] = pkg


def start(gateway, version: str, model_dir: str, voices: str):
    gateway.ARGS = argparse.Namespace(
        version=version, model_dir=model_dir, voices=voices, default_voice="dafeiyu", half=True, lang="ZH",
        emo_strength=0.5, emo_text=False, emo_alpha=0.6, no_emotion=False, max_chars=200, verbose=False,
    )
    gateway.load_engine(gateway.ARGS)
    server = gateway.ThreadingHTTPServer(("127.0.0.1", 0), gateway.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def post(base: str, payload: dict) -> bytes:
    req = urllib.request.Request(f"{base}/tts", data=json.dumps(payload).encode(), headers={"content-type": "application/json"})
    return LOCAL.open(req).read()


def main() -> None:
    tmp = tempfile.mkdtemp()
    Path(tmp, "config.yaml").write_text("x", encoding="utf-8")
    Path(tmp, "dafeiyu.wav").write_bytes(b"RIFF")
    install_fake()
    import indextts_gateway as gateway  # noqa: E402

    # 1. 2.5：用 infer_v2_5、BF16、带 lang；「开心」变成情绪向量第 0 维；路径穿越回落到默认音色
    server, base = start(gateway, "2.5", tmp, tmp)
    assert json.load(LOCAL.open(f"{base}/health"))["engine"] == "2.5"
    assert INITS[-1].get("use_bf16") is True and "use_fp16" not in INITS[-1]
    assert "use_qwen_emo" not in INITS[-1], "默认不加载 Qwen 情绪模型"
    assert post(base, {"text": "你好呀", "style": "开心", "voice": "../../evil"})[:4] == b"RIFF"
    call = CALLS[-1]
    assert call["voice"] == "dafeiyu.wav", call
    assert call["lang"] == "ZH" and call["emo_vector"][0] == 0.5 and sum(call["emo_vector"]) == 0.5, call
    post(base, {"text": "嗯", "style": "中立", "voice": "dafeiyu"})
    assert "emo_vector" not in CALLS[-1], "中立不加情绪"
    try:
        post(base, {"text": ""})
        raise AssertionError("空文本应该 400")
    except urllib.error.HTTPError as exc:
        assert exc.code == 400
    server.shutdown()

    # 2. 2：用 infer_v2、FP16、不带 lang
    server, base = start(gateway, "2", tmp, tmp)
    assert INITS[-1].get("use_fp16") is True
    post(base, {"text": "好的", "style": "委屈地撒娇", "voice": "dafeiyu"})
    assert "lang" not in CALLS[-1] and CALLS[-1]["emo_vector"] is not None
    server.shutdown()

    # 3. 引擎拒绝情绪参数（RuntimeError）：去掉情绪再合成一次，语音不丢
    install_fake(reject_emotion=True)
    server, base = start(gateway, "2.5", tmp, tmp)
    assert post(base, {"text": "别怕", "style": "害怕", "voice": "dafeiyu"})[:4] == b"RIFF"
    assert "emo_vector" not in CALLS[-1] and CALLS[-1]["lang"] == "ZH"
    server.shutdown()

    # 4. 模型目录指错：直接退出并说明
    try:
        gateway.load_engine(argparse.Namespace(version="2.5", model_dir=os.path.join(tmp, "nope"), half=False, emo_text=False))
        raise AssertionError("应该退出")
    except SystemExit as exc:
        assert "model-dir" in str(exc)

    print("indextts gateway tests passed")


if __name__ == "__main__":
    main()
