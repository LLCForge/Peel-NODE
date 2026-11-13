"""PEEL Jupyter entegrasyonu (H168).

PEEL CLI'ını (Node 20+) alt süreç olarak çağırır; kod hiçbir sunucuya gönderilmez.

    import peel_jupyter as peel
    r = peel.deobfuscate(open("x.js").read())
    r                      # notebook'ta kod + risk özeti olarak görünür
    r.code, r.report       # ham değerler
    peel.diff(eski, yeni)  # yeniden adlandırmadan bağımsız semantik fark

    %load_ext peel_jupyter
    %%peel --level 4
    var _0x1 = ["..."]; ...

PEEL_BIN ortam değişkeni CLI yolunu verir; yoksa `peel` (npm i -g peel-js) ya da `npx --yes peel-js` denenir.
"""

import html
import json
import os
import shlex
import shutil
import subprocess
import tempfile

__all__ = ["deobfuscate", "diff", "explain", "PeelResult", "load_ipython_extension"]

TIMEOUT = 300
MAX_INPUT = 50 * 1024 * 1024


def _command():
    explicit = os.environ.get("PEEL_BIN")
    if explicit:
        return ["node", explicit] if explicit.endswith(".js") else [explicit]
    if shutil.which("peel"):
        return ["peel"]
    if shutil.which("npx"):
        return ["npx", "--yes", "peel-js"]
    raise RuntimeError("PEEL CLI bulunamadı: npm i -g peel-js ya da PEEL_BIN=<repo>/bin/peel.js")


def _run(args, stdin=None):
    proc = subprocess.run(_command() + args, input=stdin, capture_output=True, text=True, encoding="utf-8", timeout=TIMEOUT, check=False)
    if proc.returncode not in (0, 3, 4):
        raise RuntimeError("PEEL hata (%d): %s" % (proc.returncode, proc.stderr.strip()[-2000:]))
    return proc.stdout


class PeelResult(object):
    def __init__(self, data):
        self.data = data
        self.code = data.get("code", "")
        self.ok = bool(data.get("ok"))
        self.verified = bool(data.get("verified"))
        self.risk = data.get("risk") or {}
        self.techniques = data.get("techniques") or []
        self.why = data.get("why") or []
        self.error = data.get("error")

    def __repr__(self):
        return "PeelResult(ok=%s, risk=%s, techniques=%s)\n%s" % (self.ok, self.risk.get("score"), self.techniques, self.code)

    def _repr_html_(self):
        risk = "%s/100 (%s)" % (self.risk.get("score", "?"), self.risk.get("level", "?"))
        meta = "<b>PEEL</b> &middot; risk %s &middot; %s &middot; %s" % (
            html.escape(risk),
            html.escape(", ".join(self.techniques) or "-"),
            "davranış doğrulandı" if self.verified else "davranış doğrulanmadı",
        )
        body = html.escape(self.error) if self.error else html.escape(self.code)
        return "<div>%s</div><pre style='max-height:480px;overflow:auto'>%s</pre>" % (meta, body)


def deobfuscate(code, level=4, sandbox=True):
    """Kodu çözer; risk, teknik ve neden özetini döndürür."""
    if not isinstance(code, str):
        raise TypeError("code str olmalı")
    if len(code) > MAX_INPUT:
        raise ValueError("kod çok büyük")
    if level not in (1, 2, 3, 4):
        raise ValueError("level 1-4 olmalı")
    args = ["-", "--json", "--quiet", "--level", str(level)]
    if not sandbox:
        args.append("--no-sandbox")
    return PeelResult(json.loads(_run(args, stdin=code)))


def _tmp(code):
    f = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8")
    f.write(code)
    f.close()
    return f.name


def diff(old, new, deobfuscate_first=True):
    """İki sürümün semantik farkı (sözlük: summary, functions, techniques)."""
    a, b = _tmp(old), _tmp(new)
    try:
        args = ["diff", a, b, "--json", "--quiet"] + (["--deobfuscate"] if deobfuscate_first else [])
        return json.loads(_run(args))
    finally:
        os.unlink(a)
        os.unlink(b)


def explain(code, lang="tr"):
    """Kullanılan teknikler ve olası gizleme nedenleri."""
    path = _tmp(code)
    try:
        return json.loads(_run(["explain", path, "--json", "--lang", lang]))
    finally:
        os.unlink(path)


def load_ipython_extension(ipython):
    from IPython.core.magic import register_cell_magic

    @register_cell_magic
    def peel(line, cell):
        level = 4
        parts = shlex.split(line)
        if "--level" in parts:
            level = int(parts[parts.index("--level") + 1])
        return deobfuscate(cell, level=level, sandbox="--no-sandbox" not in parts)
