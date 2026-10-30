"""合并三条鱼 · P3：QQ 旁路转发桥。

只做通道，不做大脑：
  QQ 私聊 → 本插件 → POST http://127.0.0.1:<dsh端口>/api/feiyu-chat → DSH 里的鲸鲸
                                                    ↓
                                          把回复原样发回 QQ

⚠️ DSH 的 Web 端口**每次重启都会变**（实测 60636 → 61416），所以不能写死：
   先用配置里的 baseUrl 试，不通就扫本机监听端口、逐个探 /api/feiyu-kb/status，
   探到就自动用并缓存。这样 DSH 重启后转发桥不需要人工改配置。

默认关闭（enabled=False）。确认 DSH 端点通了再 /鲸鲸 on。

配置：D:\\QQBot\\AstrBot\\data\\feiyu_bridge.json（首次运行自动生成）
"""

import asyncio
import json
import subprocess
import time
from pathlib import Path

import aiohttp

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

PLUGIN_NAME = "astrbot_plugin_feiyu_bridge"
PLUGIN_AUTHOR = "local"
PLUGIN_DESC = "把 QQ 私聊转发给 DSH 里的「鲸鲸」大脑"
PLUGIN_VERSION = "0.2.0"

CONFIG_PATH = Path(r"D:\QQBot\AstrBot\data\feiyu_bridge.json")

DEFAULTS = {
    "enabled": False,
    "baseUrl": "",          # 留空 = 自动发现；填了就优先用它
    "sessionId": "dsh-feiyu",
    "timeoutSec": 130,
    "onlyPrivate": True,
    "busyText": "我在忙，等我一下喵……",
}

# 发现结果缓存：{base, at}
_BASE_CACHE = {"base": None, "at": 0.0}
_CACHE_TTL = 300.0


def load_cfg() -> dict:
    cfg = dict(DEFAULTS)
    try:
        cfg.update(json.loads(CONFIG_PATH.read_text("utf-8")))
    except FileNotFoundError:
        save_cfg(DEFAULTS)
    except (ValueError, OSError) as exc:
        logger.warning("读转发桥配置失败，用默认值：%s", exc)
    return cfg


def save_cfg(cfg: dict) -> None:
    try:
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        CONFIG_PATH.write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", "utf-8"
        )
    except OSError as exc:
        logger.warning("写转发桥配置失败：%s", exc)


LOG_PATH = Path(r"D:\QQBot\AstrBot\data\feiyu_bridge.log")


def _log_event(rec: dict) -> None:
    """每条转发写一行 JSON，供 P5 的 24h 观察用（超过 1MB 就清空）。"""
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > 1_000_000:
            LOG_PATH.write_text("", encoding="utf-8")
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass


def _listening_ports() -> list:
    """本机 TCP LISTENING 端口（只要 loopback 上的）。读不到就回空表。"""
    try:
        out = subprocess.run(
            ["netstat", "-ano", "-p", "TCP"],
            capture_output=True,
            text=True,
            timeout=6,
            encoding="utf-8",
            errors="replace",
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    ports = set()
    for line in (out or "").splitlines():
        if "LISTENING" not in line.upper():
            continue
        parts = line.split()
        if len(parts) < 2 or ":" not in parts[1]:
            continue
        host, _, port = parts[1].rpartition(":")
        if host not in ("127.0.0.1", "0.0.0.0", "[::1]", "[::]"):
            continue
        if port.isdigit() and 0 < int(port) < 65536:
            ports.add(int(port))
    return sorted(ports)


async def _probe(base: str, timeout: float = 0.8) -> bool:
    """这个 base 是不是我们的 DSH 宿主？看 /api/feiyu-kb/status 认不认。"""
    try:
        to = aiohttp.ClientTimeout(total=timeout)
        async with aiohttp.ClientSession(timeout=to) as s:
            async with s.get(base + "/api/feiyu-kb/status") as r:
                if r.status != 200:
                    return False
                data = await r.json()
                return bool(data.get("ok"))
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError):
        return False


async def resolve_base(cfg: dict):
    """找到 DSH 的地址：缓存 → 配置 → 扫端口。找不到回 None。"""
    now = time.time()
    cached = _BASE_CACHE.get("base")
    if cached and now - _BASE_CACHE.get("at", 0) < _CACHE_TTL:
        return cached

    configured = str(cfg.get("baseUrl") or "").strip().rstrip("/")
    if configured and await _probe(configured):
        _BASE_CACHE.update(base=configured, at=now)
        return configured

    ports = _listening_ports()
    sem = asyncio.Semaphore(24)

    async def try_port(p: int):
        async with sem:
            base = f"http://127.0.0.1:{p}"
            return base if await _probe(base, 0.6) else None

    for found in await asyncio.gather(*(try_port(p) for p in ports)):
        if found:
            _BASE_CACHE.update(base=found, at=time.time())
            logger.info("转发桥：自动发现 DSH 在 %s", found)
            return found
    return None


async def ask_brain(cfg: dict, text: str, who: str = ""):
    """回 (是否成功, 文本或错误原因)。永不让异常冒到事件循环外。"""
    base = await resolve_base(cfg)
    if not base:
        return False, "找不到 DSH（端口变了，或 DSH 没开）"

    payload = {"text": text, "sessionId": cfg.get("sessionId") or "dsh-feiyu", "who": who}
    timeout = aiohttp.ClientTimeout(total=float(cfg.get("timeoutSec") or 130))
    try:
        async with aiohttp.ClientSession(timeout=timeout) as sess:
            async with sess.post(base + "/api/feiyu-chat", json=payload) as resp:
                raw = await resp.text()
                if resp.status != 200:
                    _BASE_CACHE.update(base=None, at=0.0)   # 可能端口又变了，下次重找
                    return False, f"HTTP {resp.status}: {raw[:120]}"
                data = json.loads(raw)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError) as exc:
        _BASE_CACHE.update(base=None, at=0.0)
        return False, f"{type(exc).__name__}: {exc}"
    if not data.get("ok"):
        return False, str(data.get("error") or "大脑没回话")
    return True, str(data.get("text") or "").strip()


@register(PLUGIN_NAME, PLUGIN_AUTHOR, PLUGIN_DESC, PLUGIN_VERSION)
class FeiyuBridge(Star):
    def __init__(self, context: Context):
        super().__init__(context)

    @filter.command("鲸鲸")
    async def toggle(self, event: AstrMessageEvent):
        cfg = load_cfg()
        parts = (event.message_str or "").strip().split(maxsplit=1)
        sub = parts[1].strip().lower() if len(parts) > 1 else "status"
        if sub in ("on", "开"):
            cfg["enabled"] = True
            save_cfg(cfg)
            base = await resolve_base(cfg)
            yield event.plain_result(
                "转发桥已打开：私聊走 DSH 里的鲸鲸。\n"
                + (f"大脑地址：{base}" if base else "⚠️ 暂时找不到 DSH，先确认它开着。")
            )
        elif sub in ("off", "关"):
            cfg["enabled"] = False
            save_cfg(cfg)
            yield event.plain_result("转发桥已关闭：回到 AstrBot 自己回。")
        else:
            base = await resolve_base(cfg)
            yield event.plain_result(
                f"转发桥：{'开' if cfg.get('enabled') else '关'}\n"
                f"大脑地址：{base or '（还没找到）'}\n"
                f"会话：{cfg.get('sessionId')}\n"
                "用 /鲸鲸 on 或 /鲸鲸 off 切换。"
            )

    @filter.event_message_type(filter.EventMessageType.ALL, priority=900)
    async def forward(self, event: AstrMessageEvent):
        cfg = load_cfg()
        if not cfg.get("enabled"):
            return
        if cfg.get("onlyPrivate", True) and not event.is_private_chat():
            return
        text = (event.message_str or "").strip()
        if not text or text.startswith("/") or text.startswith("鲸鲸"):
            return

        t0 = time.time()
        ok, res = await ask_brain(cfg, text, str(getattr(event, "unified_msg_origin", "") or ""))
        ms = int((time.time() - t0) * 1000)
        err = None
        if not ok:
            err = str(res)
            logger.warning("转发给大脑失败：%s", err)
            out = str(cfg.get("busyText") or DEFAULTS["busyText"])
        else:
            out = res

        _log_event({
            "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "umo": str(getattr(event, "unified_msg_origin", "") or ""),
            "in_len": len(text),
            "ok": ok,
            "ms": ms,
            "out_len": len(out),
            "out_preview": out[:60],
            "error": err,
        })

        # 有回复就交给大脑，别让 AstrBot 的模型再回一遍（R4：两个人格会漂）
        event.stop_event()
        yield event.plain_result(out)
