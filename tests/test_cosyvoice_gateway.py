"""cosyvoice_gateway.py 的协议测试：用假的 CosyVoice3 引擎，不需要显卡、torch 和模型。

    python tests/test_cosyvoice_gateway.py
（需要 numpy；真实 CosyVoice 环境里本来就有）
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))

# 只连本机：不走系统代理（Windows 上开着 Clash 等代理时会被转发并返回 502）
LOCAL = urllib.request.build_opener(urllib.request.ProxyHandler({}))
CALLS: list[tuple] = []


class FakeTensor:
    def __init__(self, data):
        self.data = np.asarray(data, dtype=np.float32).reshape(1, -1)

    def cpu(self):
        return self

    def numpy(self):
        return self.data


class FakeCosyVoice3:
    sample_rate = 24000

    def __init__(self):
        self.spks: dict[str, tuple] = {}

    def add_zero_shot_spk(self, prompt_text, prompt_wav, spk_id):
        assert prompt_text.startswith("You are a helpful assistant.<|endofprompt|>")
        self.spks[spk_id] = (prompt_text, prompt_wav)
        return True

    def _out(self):
        # 两段输出，验证网关会拼接；第二段带越界值，验证会被截断到 [-1, 1]
        return [{"tts_speech": FakeTensor([0.0, 0.5])}, {"tts_speech": FakeTensor([2.0, -2.0])}]

    def inference_zero_shot(self, text, prompt_text, prompt_wav, zero_shot_spk_id="", stream=False, speed=1.0):
        assert zero_shot_spk_id in self.spks, "零样本要用预先注册的说话人"
        CALLS.append(("zero_shot", text, zero_shot_spk_id, speed))
        return iter(self._out())

    def inference_instruct2(self, text, instruct, prompt_wav, stream=False, speed=1.0):
        assert instruct.endswith("<|endofprompt|>")
        CALLS.append(("instruct2", text, instruct, Path(prompt_wav).name))
        return iter(self._out())

    def inference_cross_lingual(self, text, prompt_wav, stream=False, speed=1.0):
        assert text.startswith("You are a helpful assistant.<|endofprompt|>")
        CALLS.append(("cross_lingual", text, Path(prompt_wav).name))
        return iter(self._out())


def post(base: str, payload: dict) -> bytes:
    req = urllib.request.Request(f"{base}/tts", data=json.dumps(payload).encode(), headers={"content-type": "application/json"})
    return LOCAL.open(req).read()


def main() -> None:
    import cosyvoice_gateway as gw

    voices = Path(tempfile.mkdtemp())
    (voices / "dafeiyu.wav").write_bytes(b"RIFF")
    (voices / "dafeiyu.txt").write_text("希望你以后能够做的比我还好呦。", encoding="utf-8")
    (voices / "noscript.wav").write_bytes(b"RIFF")  # 没有逐字稿 → 跨语种模式

    gw.ENGINE = FakeCosyVoice3()
    gw.ARGS = argparse.Namespace(default_voice="dafeiyu", no_emotion=False, speed=1.0, max_chars=200, verbose=False)
    gw.load_voices(str(voices))
    assert gw.VOICES["dafeiyu"]["spk"] == "gw_dafeiyu" and gw.VOICES["noscript"]["spk"] == ""
    assert "希望你以后" in gw.ENGINE.spks["gw_dafeiyu"][0], "逐字稿要拼进提示"

    server = gw.ThreadingHTTPServer(("127.0.0.1", 0), gw.Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    try:
        health = json.load(LOCAL.open(f"{base}/health"))
        assert health["engine"] == "cosyvoice3" and health["voices"] == ["dafeiyu", "noscript"]

        # 1. 普通语气 → 零样本（用预注册的说话人）；输出是合法 WAV，两段被拼接、越界值被截断
        data = post(base, {"text": "你好呀", "style": "中立", "voice": "dafeiyu"})
        assert CALLS[-1][0] == "zero_shot" and CALLS[-1][2] == "gw_dafeiyu"
        with wave.open(io.BytesIO(data)) as w:
            assert w.getframerate() == 24000 and w.getnchannels() == 1 and w.getsampwidth() == 2
            frames = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2")
        assert frames.tolist() == [0, 16383, 32767, -32767], frames.tolist()

        # 2. 情绪 → instruct2，指令必须是 CosyVoice3 训练过的那几条
        post(base, {"text": "太好啦", "style": "开心", "voice": "dafeiyu"})
        assert CALLS[-1][0] == "instruct2" and "非常开心" in CALLS[-1][2]
        post(base, {"text": "哼", "style": "委屈地撒娇", "voice": "dafeiyu"})
        assert CALLS[-1][0] == "instruct2", "委屈/撒娇都能映射到训练过的指令"
        post(base, {"text": "嘘", "style": "小声", "voice": "dafeiyu"})
        assert "soft voice" in CALLS[-1][2]

        # 3. 没有逐字稿的音色 → 跨语种模式
        post(base, {"text": "在吗", "style": "", "voice": "noscript"})
        assert CALLS[-1][0] == "cross_lingual" and CALLS[-1][2] == "noscript.wav"

        # 4. 未知音色 / 路径穿越 → 回落默认音色
        post(base, {"text": "测试", "style": "", "voice": "../../evil"})
        assert CALLS[-1][0] == "zero_shot" and CALLS[-1][2] == "gw_dafeiyu"

        # 5. --no-emotion：有情绪也走零样本
        gw.ARGS.no_emotion = True
        post(base, {"text": "生气了", "style": "生气", "voice": "dafeiyu"})
        assert CALLS[-1][0] == "zero_shot"
        gw.ARGS.no_emotion = False

        # 6. 空文本 400；引擎报错 500（插件会回退 Edge）
        for payload, code in [({"text": ""}, 400)]:
            try:
                post(base, payload)
                raise AssertionError("应该报错")
            except urllib.error.HTTPError as exc:
                assert exc.code == code
        gw.ENGINE.inference_zero_shot = lambda *a, **k: iter([])
        try:
            post(base, {"text": "没有输出", "voice": "dafeiyu"})
            raise AssertionError("应该 500")
        except urllib.error.HTTPError as exc:
            assert exc.code == 500
    finally:
        server.shutdown()

    # 7. 模型目录不对 / 音色目录为空：直接退出并说明
    try:
        gw.load_engine(argparse.Namespace(model_dir=str(voices), fp16=False))
        raise AssertionError("应该退出")
    except SystemExit as exc:
        assert "cosyvoice3.yaml" in str(exc)
    try:
        gw.load_voices(tempfile.mkdtemp())
        raise AssertionError("应该退出")
    except SystemExit as exc:
        assert ".wav" in str(exc)

    print("cosyvoice gateway tests passed")


if __name__ == "__main__":
    main()
