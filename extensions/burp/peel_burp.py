# -*- coding: utf-8 -*-
"""PEEL Burp Suite eklentisi (H161), Jython 2.7 / Burp Extender API.

Yükleme: Burp > Extensions > Add > Extension type: Python > bu dosya
(Extender > Options altında Jython standalone JAR yolu tanımlı olmalı).

Özellikler:
  * İstek/yanıt düzenleyicisinde "PEEL" sekmesi: JavaScript yanıtının çözülmüş hali ve risk özeti.
  * Sağ tık menüsü "PEEL ile çöz": seçili yanıtları çözer, sonuçları "PEEL" ana sekmesinde listeler.
  * "PEEL" ana sekmesinde sunucu adresi ve token ayarı.
Kod yalnızca yerel PEEL REST sunucusuna (peel serve, 127.0.0.1) gönderilir.
"""

import json
import threading

from burp import IBurpExtender, IContextMenuFactory, IMessageEditorTab, IMessageEditorTabFactory, ITab
from java.awt import BorderLayout, FlowLayout
from java.io import BufferedReader, InputStreamReader, OutputStreamWriter
from java.net import URL
from java.util import ArrayList
from javax.swing import (DefaultListModel, JButton, JLabel, JList, JMenuItem, JPanel, JPasswordField,
                         JScrollPane, JSplitPane, JTextArea, JTextField, SwingUtilities)

MAX_BYTES = 5 * 1024 * 1024
LOOPBACK = ("127.0.0.1", "localhost", "[::1]", "::1")


def is_loopback(url):
    try:
        return URL(url).getHost() in LOOPBACK
    except Exception:
        return False


class PeelClient(object):
    def __init__(self):
        self.url = "http://127.0.0.1:8787"
        self.token = ""

    def deobfuscate(self, code):
        if not is_loopback(self.url):
            raise ValueError(u"PEEL sunucusu yalnızca loopback olabilir")
        if not self.token:
            raise ValueError(u"PEEL token boş (peel serve çıktısındaki token'ı girin)")
        conn = URL(self.url.rstrip("/") + "/v1/deobfuscate").openConnection()
        conn.setRequestMethod("POST")
        conn.setDoOutput(True)
        conn.setConnectTimeout(5000)
        conn.setReadTimeout(120000)
        conn.setRequestProperty("Content-Type", "application/json")
        conn.setRequestProperty("Authorization", "Bearer " + self.token)
        writer = OutputStreamWriter(conn.getOutputStream(), "UTF-8")
        writer.write(json.dumps({"code": code, "analyze": True}))
        writer.close()
        status = conn.getResponseCode()
        stream = conn.getInputStream() if status < 400 else conn.getErrorStream()
        reader = BufferedReader(InputStreamReader(stream, "UTF-8"))
        parts = []
        line = reader.readLine()
        while line is not None:
            parts.append(line)
            line = reader.readLine()
        reader.close()
        data = json.loads(u"\n".join(parts))
        if status >= 400:
            raise ValueError(u"PEEL HTTP %d: %s" % (status, data.get("error", "")))
        return data


def summary(data):
    report = data.get("report") or {}
    risk = (report.get("threat") or {}).get("risk") or {}
    lines = [u"// PEEL risk: %s/100 (%s)" % (risk.get("score", "?"), risk.get("level", "?"))]
    for reason in data.get("why") or []:
        lines.append(u"// neden: %s" % reason.get("title", {}).get("tr", ""))
    for url in ((report.get("iocs") or {}).get("urls") or [])[:20]:
        lines.append(u"// IOC: %s" % url)
    return u"\n".join(lines) + u"\n\n" + data.get("code", "")


def response_body(helpers, response):
    info = helpers.analyzeResponse(response)
    body = response[info.getBodyOffset():]
    if len(body) > MAX_BYTES:
        raise ValueError(u"yanıt çok büyük")
    return helpers.bytesToString(body), info


def looks_like_js(info, url):
    mime = (info.getStatedMimeType() or "") + " " + (info.getInferredMimeType() or "")
    return "script" in mime.lower() or (url is not None and url.getPath().endswith((".js", ".mjs")))


class PeelEditorTab(IMessageEditorTab):
    def __init__(self, ext, controller):
        self.ext = ext
        self.controller = controller
        self.area = JTextArea()
        self.area.setEditable(False)
        self.panel = JScrollPane(self.area)
        self.current = None

    def getTabCaption(self):
        return "PEEL"

    def getUiComponent(self):
        return self.panel

    def isEnabled(self, content, isRequest):
        if isRequest or content is None:
            return False
        try:
            info = self.ext.helpers.analyzeResponse(content)
            service = self.controller.getHttpService()
            url = self.ext.helpers.analyzeRequest(service, self.controller.getRequest()).getUrl() if service else None
            return looks_like_js(info, url)
        except Exception:
            return False

    def setMessage(self, content, isRequest):
        self.current = content
        if content is None:
            self.area.setText("")
            return
        self.area.setText(u"// PEEL çözüyor…")
        tab = self

        def work():
            try:
                code, _ = response_body(tab.ext.helpers, content)
                text = summary(tab.ext.client.deobfuscate(code))
            except Exception as e:
                text = u"// PEEL hata: %s" % e
            SwingUtilities.invokeLater(lambda: tab.area.setText(text) if tab.current is content else None)

        threading.Thread(target=work).start()

    def getMessage(self):
        return self.current

    def isModified(self):
        return False

    def getSelectedData(self):
        return self.area.getSelectedText()


class BurpExtender(IBurpExtender, IContextMenuFactory, IMessageEditorTabFactory, ITab):
    def registerExtenderCallbacks(self, callbacks):
        self.callbacks = callbacks
        self.helpers = callbacks.getHelpers()
        self.client = PeelClient()
        saved_url = callbacks.loadExtensionSetting("peel_url")
        saved_token = callbacks.loadExtensionSetting("peel_token")
        if saved_url:
            self.client.url = saved_url
        if saved_token:
            self.client.token = saved_token
        callbacks.setExtensionName("PEEL")
        self._build_ui()
        callbacks.registerContextMenuFactory(self)
        callbacks.registerMessageEditorTabFactory(self)
        callbacks.addSuiteTab(self)

    def _build_ui(self):
        self.model = DefaultListModel()
        self.results = []
        self.list = JList(self.model)
        self.output = JTextArea()
        self.output.setEditable(False)
        self.list.addListSelectionListener(lambda e: self._show(self.list.getSelectedIndex()))
        settings = JPanel(FlowLayout(FlowLayout.LEFT))
        self.url_field = JTextField(self.client.url, 22)
        self.token_field = JPasswordField(self.client.token, 30)
        save = JButton(u"Kaydet", actionPerformed=self._save_settings)
        for c in (JLabel(u"PEEL sunucusu:"), self.url_field, JLabel(u"Token:"), self.token_field, save):
            settings.add(c)
        split = JSplitPane(JSplitPane.HORIZONTAL_SPLIT, JScrollPane(self.list), JScrollPane(self.output))
        split.setDividerLocation(320)
        self.panel = JPanel(BorderLayout())
        self.panel.add(settings, BorderLayout.NORTH)
        self.panel.add(split, BorderLayout.CENTER)

    def _save_settings(self, _event):
        url = self.url_field.getText().strip()
        if not is_loopback(url):
            self.output.setText(u"PEEL sunucusu yalnızca loopback olabilir (127.0.0.1 / localhost)")
            return
        self.client.url = url
        self.client.token = u"".join(self.token_field.getPassword())
        self.callbacks.saveExtensionSetting("peel_url", self.client.url)
        self.callbacks.saveExtensionSetting("peel_token", self.client.token)
        self.output.setText(u"Kaydedildi.")

    def _show(self, i):
        if 0 <= i < len(self.results):
            self.output.setText(self.results[i])
            self.output.setCaretPosition(0)

    # ITab
    def getTabCaption(self):
        return "PEEL"

    def getUiComponent(self):
        return self.panel

    # IMessageEditorTabFactory
    def createNewInstance(self, controller, editable):
        return PeelEditorTab(self, controller)

    # IContextMenuFactory
    def createMenuItems(self, invocation):
        messages = invocation.getSelectedMessages()
        if not messages:
            return None
        items = ArrayList()
        items.add(JMenuItem(u"PEEL ile çöz", actionPerformed=lambda e: self._run(messages)))
        return items

    def _run(self, messages):
        ext = self

        def work():
            for m in messages:
                response = m.getResponse()
                if response is None:
                    continue
                url = ext.helpers.analyzeRequest(m).getUrl()
                try:
                    code, _ = response_body(ext.helpers, response)
                    data = ext.client.deobfuscate(code)
                    text = summary(data)
                    risk = ((data.get("report") or {}).get("threat") or {}).get("risk") or {}
                    label = u"[%s] %s" % (risk.get("score", "?"), url)
                    if risk.get("level") in ("medium", "high"):
                        m.setHighlight("orange")
                        m.setComment(u"PEEL risk %s" % risk.get("score"))
                except Exception as e:
                    text = u"// PEEL hata: %s" % e
                    label = u"[!] %s" % url

                def add(label=label, text=text):
                    ext.results.append(text)
                    ext.model.addElement(label)

                SwingUtilities.invokeLater(add)

        threading.Thread(target=work).start()
