"""PEEL mitmproxy eklentisi (H161).

Proxy'den geçen JavaScript yanıtlarını yerel PEEL REST sunucusuna (peel serve) gönderip çözer.
Kod yalnızca loopback adresindeki PEEL sunucusuna gider; başka hiçbir yere gönderilmez.

Kullanım:
    peel serve                       # token yazdırılır (ya da PEEL_TOKEN ile verilir)
    PEEL_TOKEN=... mitmdump -s extensions/mitmproxy/peel_addon.py \
        --set peel_mode=save --set peel_dir=./peel-captures

Seçenekler:
    peel_url    PEEL sunucusu (varsayılan http://127.0.0.1:8787, yalnızca loopback)
    peel_token  Bearer token (varsayılan PEEL_TOKEN ortam değişkeni)
    peel_mode   off | save | replace   (save: çözülmüşü diske yaz; replace: yanıtı çözülmüşle değiştir)
    peel_dir    save modunda çıktı dizini
    peel_hosts  yalnızca bu regex'e uyan host'lar (boş = hepsi)
    peel_max_kb en büyük yanıt boyutu (KB)
"""

import asyncio
import hashlib
import ipaddress
import json
import logging
import os
import re
import urllib.error
import urllib.request
from urllib.parse import urlparse

from mitmproxy import ctx, http

LOG = logging.getLogger("peel")
JS_TYPES = re.compile(r"(java|ecma)script", re.I)
SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _is_loopback(url):
    host = urlparse(url).hostname or ""
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def call_peel(base, token, code, timeout=90):
    """PEEL REST API'sine senkron istek; (sonuç sözlüğü, hata) döndürür."""
    body = json.dumps({"code": code, "analyze": True}).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + "/v1/deobfuscate",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8")), None
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read().decode("utf-8")).get("error", str(e))
        except ValueError:
            msg = str(e)
        return None, "HTTP %d: %s" % (e.code, msg)
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return None, str(e)


class Peel:
    def load(self, loader):
        loader.add_option("peel_url", str, "http://127.0.0.1:8787", "PEEL REST sunucusu (yalnızca loopback)")
        loader.add_option("peel_token", str, os.environ.get("PEEL_TOKEN", ""), "PEEL Bearer token")
        loader.add_option("peel_mode", str, "save", "off | save | replace")
        loader.add_option("peel_dir", str, "peel-captures", "save modunda çıktı dizini")
        loader.add_option("peel_hosts", str, "", "yalnızca bu regex'e uyan host'lar")
        loader.add_option("peel_max_kb", int, 5000, "en büyük yanıt boyutu (KB)")

    def configure(self, updated):
        if "peel_url" in updated and not _is_loopback(ctx.options.peel_url):
            raise ValueError("peel_url yalnızca loopback olabilir (kod dışarı gönderilmez)")
        if "peel_mode" in updated and ctx.options.peel_mode not in ("off", "save", "replace"):
            raise ValueError("peel_mode off, save ya da replace olmalı")
        if "peel_hosts" in updated and ctx.options.peel_hosts:
            re.compile(ctx.options.peel_hosts)

    def _wanted(self, flow):
        if ctx.options.peel_mode == "off" or not flow.response or flow.response.status_code != 200:
            return False
        ctype = flow.response.headers.get("content-type", "")
        path = urlparse(flow.request.pretty_url).path
        if not (JS_TYPES.search(ctype) or path.endswith((".js", ".mjs"))):
            return False
        if ctx.options.peel_hosts and not re.search(ctx.options.peel_hosts, flow.request.pretty_host):
            return False
        size = len(flow.response.raw_content or b"")
        return 0 < size <= ctx.options.peel_max_kb * 1024

    def _save(self, flow, code, result):
        url = flow.request.pretty_url
        digest = hashlib.sha256(code.encode("utf-8")).hexdigest()[:12]
        name = SAFE.sub("_", flow.request.pretty_host + urlparse(url).path)[:120] + "." + digest
        os.makedirs(ctx.options.peel_dir, exist_ok=True)
        base = os.path.join(ctx.options.peel_dir, name)
        with open(base + ".js", "w", encoding="utf-8") as f:
            f.write(result["code"])
        meta = {"url": url, "risk": result.get("report", {}).get("threat", {}).get("risk"), "why": result.get("why"), "report": result.get("report")}
        with open(base + ".report.json", "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        return base + ".js"

    async def response(self, flow: http.HTTPFlow):
        if not self._wanted(flow):
            return
        if not ctx.options.peel_token:
            LOG.warning("PEEL: peel_token / PEEL_TOKEN boş, atlandı")
            return
        code = flow.response.get_text(strict=False) or ""
        result, err = await asyncio.to_thread(call_peel, ctx.options.peel_url, ctx.options.peel_token, code)
        if err:
            LOG.warning("PEEL %s: %s", flow.request.pretty_url, err)
            return
        risk = (result.get("report") or {}).get("threat", {}).get("risk") or {}
        flow.comment = "PEEL risk %s (%s)" % (risk.get("score", "?"), risk.get("level", "?"))
        if risk.get("level") in ("medium", "high"):
            flow.marked = ":warning:"
        if ctx.options.peel_mode == "save":
            path = self._save(flow, code, result)
            LOG.info("PEEL: %s -> %s (risk %s)", flow.request.pretty_url, path, risk.get("score"))
        elif ctx.options.peel_mode == "replace":
            flow.response.text = result["code"]
            flow.response.headers["X-PEEL-Risk"] = str(risk.get("score", ""))
            # not: sayfa script'i SRI (integrity) ile yüklüyorsa tarayıcı değiştirilmiş yanıtı reddeder


addons = [Peel()]
