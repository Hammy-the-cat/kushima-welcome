import { writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import tls from "node:tls";
import net from "node:net";

const envValue = (name) => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const BASE_URL = envValue("WBGT_BASE_URL") ?? "https://takanabe.aimnextiot.com/wbgtmonitoring/";
const SITE_ORIGIN = new URL(BASE_URL).origin;
const LOGIN_ID = envValue("WBGT_LOGIN_ID");
const PASSWORD = envValue("WBGT_PASSWORD");
const DATA_URL = envValue("WBGT_DATA_URL");
const OUTPUT_PATH = process.env.WBGT_OUTPUT_PATH ?? "wbgt-live.json";
const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

const demoData = {
  status: "demo",
  value: 29.4,
  level: "厳重警戒",
  temperature: "31.8℃",
  humidity: "66%",
  sourceUpdatedAt: "10:30",
  updatedAt: null,
  message: "デモ値を表示しています。WBGTサイトから値を取得できませんでした。",
};

const nowIso = () => new Date().toISOString();

const writeJson = async (data) => {
  await writeFile(OUTPUT_PATH, `${JSON.stringify({ ...data, updatedAt: nowIso() }, null, 2)}\n`, "utf8");
};

const getSetCookies = (headers) => {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const cookie = headers.get("set-cookie");
  return cookie ? [cookie] : [];
};

const mergeCookies = (jar, headers) => {
  for (const cookie of getSetCookies(headers)) {
    const pair = cookie.split(";")[0];
    const key = pair.split("=")[0];
    if (key) {
      jar.set(key, pair);
    }
  }
};

const cookieHeader = (jar) => Array.from(jar.values()).join("; ");

const browserHeaders = (jar) => ({
  "User-Agent": BROWSER_USER_AGENT,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
  ...(jar && cookieHeader(jar) ? { Cookie: cookieHeader(jar) } : {}),
});

const decodeHtml = (text) =>
  text
    .replace(/&nbsp;/g, " ")
    .replace(/&deg;/g, "°")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const stripTags = (html) => decodeHtml(html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " "));

const numberFrom = (text) => {
  const match = text.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
};

const classifyWbgt = (value) => {
  if (value == null) return "未取得";
  if (value >= 31) return "危険";
  if (value >= 28) return "厳重警戒";
  if (value >= 25) return "警戒";
  if (value >= 21) return "注意";
  return "ほぼ安全";
};

const formatDateTimeJst = (date) => {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}/${get("month")}/${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
};

const buildGraphItems = () => {
  const location = envValue("WBGT_GRAPH_LOCATION") ?? "13";
  if (!envValue("WBGT_GRAPH_GROUPS") && !envValue("WBGT_GRAPH_SENSORS") && location === "13") {
    return [
      { index: 0, location: "13", data: "0-1070-17", objId: "graph_13_1070_17" },
      { index: 1, location: "13", data: "0-1070-14", objId: "graph_13_1070_14" },
      { index: 2, location: "13", data: "0-1070-15", objId: "graph_13_1070_15" },
      { index: 3, location: "13", data: "0-1071-17", objId: "graph_13_1071_17" },
      { index: 4, location: "13", data: "0-1071-14", objId: "graph_13_1071_14" },
      { index: 5, location: "13", data: "0-1071-15", objId: "graph_13_1071_15" },
    ];
  }

  const groups = (envValue("WBGT_GRAPH_GROUPS") ?? "1071")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const sensors = (envValue("WBGT_GRAPH_SENSORS") ?? "17,14,15")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  let index = Number(envValue("WBGT_GRAPH_INDEX_OFFSET") ?? 0);
  return groups.flatMap((group) =>
    sensors.map((sensor) => {
      const data = `0-${group}-${sensor}`;
      return {
        index: index++,
        location,
        data,
        objId: `graph_${location}_${group}_${sensor}`,
      };
    }),
  );
};

const activeGraphItems = () => [
  { index: 3, location: "13", data: "0-1071-17", objId: "graph_13_1071_17" },
  { index: 4, location: "13", data: "0-1071-14", objId: "graph_13_1071_14" },
  { index: 5, location: "13", data: "0-1071-15", objId: "graph_13_1071_15" },
];

const dataFromGraphs = (latestByLabel, message) => {
  const wbgt = latestByLabel.get("暑さ指数");
  const humidity = latestByLabel.get("湿度");
  const temperature = latestByLabel.get("気温") ?? latestByLabel.get("温度");
  if (!wbgt) {
    throw new Error(message);
  }

  return {
    status: "ok",
    value: wbgt.value,
    level: classifyWbgt(wbgt.value),
    temperature: temperature ? `${temperature.value}${temperature.unit || "℃"}` : demoData.temperature,
    humidity: humidity ? `${humidity.value}${humidity.unit || "%"}` : demoData.humidity,
    sourceUpdatedAt: wbgt.sourceUpdatedAt,
    message: "GraphHubからWBGTデータを更新しました。",
  };
};

const signalRFrame = (payload) => `${JSON.stringify(payload)}\x1e`;

const parseSignalRFrames = (raw) =>
  `${raw}`
    .split("\x1e")
    .map((frame) => frame.trim())
    .filter(Boolean)
    .map((frame) => {
      try {
        return JSON.parse(frame);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

const summarizeGraphHubMessage = (message) => {
  const summary = {
    type: message?.type,
    target: message?.target,
  };
  if (message?.invocationId != null) {
    summary.invocationId = message.invocationId;
  }
  if (Array.isArray(message?.arguments)) {
    summary.arguments = message.arguments.map((argument) => {
      if (Array.isArray(argument)) {
        return `array(${argument.length})`;
      }
      if (argument && typeof argument === "object") {
        return JSON.stringify(argument).slice(0, 180);
      }
      return argument;
    });
  }
  if (message?.error) {
    summary.error = message.error;
  }
  if (message?.result != null) {
    summary.result = message.result;
  }
  return JSON.stringify(summary);
};

const getLatestGraphValue = (message) => {
  if (message?.target !== "updateGraph" || !Array.isArray(message.arguments)) {
    return null;
  }
  const [, label, unit, , timestamps, values] = message.arguments;
  if (!Array.isArray(timestamps) || !Array.isArray(values) || values.length === 0) {
    return null;
  }
  const latestValue = values[values.length - 1];
  const latestTime = timestamps[timestamps.length - 1];
  const numeric = Number(latestValue);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  return {
    label: `${label}`,
    unit: `${unit ?? ""}`,
    value: numeric,
    sourceUpdatedAt: `${latestTime ?? ""}`,
  };
};

const createWebSocketConnection = (urlString, extraHeaders = {}) => {
  const url = new URL(urlString);
  const secure = url.protocol === "wss:";
  const port = Number(url.port || (secure ? 443 : 80));
  const path = `${url.pathname}${url.search}`;
  const key = crypto.randomBytes(16).toString("base64");
  const socket = secure
    ? tls.connect({ host: url.hostname, port, servername: url.hostname })
    : net.connect({ host: url.hostname, port });
  let buffer = Buffer.alloc(0);
  let handshakeDone = false;
  let textBuffer = "";
  let closed = false;
  const messageHandlers = new Set();
  const errorHandlers = new Set();
  const openHandlers = new Set();
  const closeHandlers = new Set();

  const emit = (handlers, value) => {
    for (const handler of handlers) {
      handler(value);
    }
  };

  const parseFrames = () => {
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      let offset = 2;
      let length = second & 0x7f;
      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const high = buffer.readUInt32BE(offset);
        const low = buffer.readUInt32BE(offset + 4);
        length = high * 2 ** 32 + low;
        offset += 8;
      }
      const masked = Boolean(second & 0x80);
      let mask;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      let payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (masked && mask) {
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }

      if (opcode === 0x8) {
        closed = true;
        socket.end();
        emit(closeHandlers);
        return;
      }
      if (opcode === 0x9) {
        sendFrame(payload, 0xA);
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        textBuffer += payload.toString("utf8");
        if (first & 0x80) {
          emit(messageHandlers, textBuffer);
          textBuffer = "";
        }
      }
    }
  };

  const sendFrame = (payloadInput, opcode = 0x1) => {
    if (closed) return;
    const payload = Buffer.isBuffer(payloadInput) ? payloadInput : Buffer.from(`${payloadInput}`, "utf8");
    const length = payload.length;
    const lengthBytes = length < 126 ? 0 : length <= 65535 ? 2 : 8;
    const header = Buffer.alloc(2 + lengthBytes + 4);
    header[0] = 0x80 | opcode;
    if (length < 126) {
      header[1] = 0x80 | length;
    } else if (length <= 65535) {
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header[1] = 0x80 | 127;
      header.writeUInt32BE(Math.floor(length / 2 ** 32), 2);
      header.writeUInt32BE(length >>> 0, 6);
    }
    const maskOffset = 2 + lengthBytes;
    const mask = crypto.randomBytes(4);
    mask.copy(header, maskOffset);
    const maskedPayload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    socket.write(Buffer.concat([header, maskedPayload]));
  };

  socket.on("connect", () => {
    const headerLines = Object.entries(extraHeaders)
      .filter(([, value]) => value)
      .map(([name, value]) => `${name}: ${value}`);
    socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: ${url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      `User-Agent: ${BROWSER_USER_AGENT}`,
      `Origin: ${SITE_ORIGIN}`,
      `Referer: ${BASE_URL}`,
      "Accept-Language: ja,en-US;q=0.9,en;q=0.8",
      "Cache-Control: no-cache",
      "Pragma: no-cache",
      ...headerLines,
      "",
      "",
    ].join("\r\n"));
  });

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshakeDone) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      if (!/^HTTP\/1\.1 101/i.test(header)) {
        emit(errorHandlers, new Error(`WebSocket handshake failed: ${header.split("\r\n")[0]}`));
        socket.end();
        return;
      }
      handshakeDone = true;
      buffer = buffer.subarray(headerEnd + 4);
      emit(openHandlers);
    }
    parseFrames();
  });

  socket.on("error", (error) => emit(errorHandlers, error));
  socket.on("close", () => {
    if (!closed) {
      closed = true;
      emit(closeHandlers);
    }
  });

  return {
    onOpen: (handler) => openHandlers.add(handler),
    onMessage: (handler) => messageHandlers.add(handler),
    onError: (handler) => errorHandlers.add(handler),
    send: (text) => sendFrame(text),
    close: () => {
      closed = true;
      try {
        sendFrame(Buffer.alloc(0), 0x8);
      } catch {
        socket.end();
      }
      socket.end();
    },
  };
};

const fetchGraphHubData = async (jar) => {
  const { default: WebSocket } = await import("ws");
  globalThis.WebSocket = WebSocket;
  const signalR = await import("@microsoft/signalr");

  const graphItems = buildGraphItems();
  const latestByLabel = new Map();
  const observedLabels = new Set();
  const observedTargets = new Set();
  const observedMessages = [];
  const sentRequests = [];
  let messageCount = 0;
  let resolveWhenReady;
  const ready = new Promise((resolve) => {
    resolveWhenReady = resolve;
  });

  const rememberMessage = (message) => {
    messageCount += 1;
    if (message.target) {
      observedTargets.add(message.target);
    }
    if (observedMessages.length < 10) {
      observedMessages.push(summarizeGraphHubMessage(message));
    }
  };

  const recordGraphValue = (...args) => {
    const message = { type: 1, target: "updateGraph", arguments: args };
    rememberMessage(message);
    const latest = getLatestGraphValue(message);
    if (latest) {
      observedLabels.add(latest.label);
      latestByLabel.set(latest.label, latest);
      if (latest.label === "暑さ指数") {
        resolveWhenReady();
      }
    }
  };

  const connection = new signalR.HubConnectionBuilder()
    .withUrl(new URL("GraphHub", BASE_URL).toString(), {
      transport: signalR.HttpTransportType.WebSockets,
      headers: {
        ...browserHeaders(jar),
        Accept: "*/*",
        Origin: SITE_ORIGIN,
        Referer: BASE_URL,
        "X-Requested-With": "XMLHttpRequest",
      },
    })
    .configureLogging(signalR.LogLevel.Warning)
    .build();

  connection.on("setGraphRange", (...args) => rememberMessage({ type: 1, target: "setGraphRange", arguments: args }));
  connection.on("updateGraphFailed", (...args) => rememberMessage({ type: 1, target: "updateGraphFailed", arguments: args }));
  connection.on("updateGraph", recordGraphValue);

  const requestGraphData = async (items, label) => {
    sentRequests.push(`${label}:${items.map((item) => `${item.index}/${item.data}`).join(",")}`);
    await connection.invoke("addAllGraph", new Date().toISOString(), 14, items);
  };

  try {
    await connection.start();
    await requestGraphData(graphItems, "full");
    if (!latestByLabel.has("暑さ指数")) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await requestGraphData(activeGraphItems(), "active");
    }

    await Promise.race([
      ready,
      new Promise((_, reject) => setTimeout(() => {
        const labels = Array.from(observedLabels).join(", ") || "none";
        const targets = Array.from(observedTargets).join(", ") || "none";
        const previews = observedMessages.join(" | ") || "none";
        const requests = sentRequests.join(" | ") || "none";
        reject(new Error(`GraphHub timed out before receiving WBGT data. messages=${messageCount}; targets=${targets}; labels=${labels}; sent=${requests}; previews=${previews}`));
      }, 45000)),
    ]);
  } finally {
    await connection.stop().catch(() => {});
  }

  return dataFromGraphs(latestByLabel, "GraphHub did not return WBGT data.");
};

const fetchBrowserGraphHubData = async () => {
  const { chromium } = await import("playwright");
  const latestByLabel = new Map();
  const observedTargets = new Set();
  const observedLabels = new Set();
  const observedMessages = [];
  let frameCount = 0;
  let pageStatus = "not loaded";
  let pageTitle = "";
  let pageUrl = BASE_URL;
  let loginAttempt = "not needed";

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    locale: "ja-JP",
    userAgent: BROWSER_USER_AGENT,
  });

  const rememberMessage = (message) => {
    frameCount += 1;
    if (message.target) {
      observedTargets.add(message.target);
    }
    if (observedMessages.length < 10) {
      observedMessages.push(summarizeGraphHubMessage(message));
    }
    const latest = getLatestGraphValue(message);
    if (latest) {
      observedLabels.add(latest.label);
      latestByLabel.set(latest.label, latest);
    }
  };

  try {
    page.on("websocket", (webSocket) => {
      webSocket.on("framereceived", ({ payload }) => {
        for (const message of parseSignalRFrames(payload)) {
          rememberMessage(message);
        }
      });
    });

    const response = await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
    pageStatus = response ? `${response.status()} ${response.url()}` : "no response";
    pageTitle = await page.title().catch(() => "");
    pageUrl = page.url();

    const loginIdInput = page.locator('input[name="Input.LoginId"], input[name="LoginId"], input[type="text"]').first();
    const passwordInput = page.locator('input[name="Input.Password"], input[name="Password"], input[type="password"]').first();
    if (await loginIdInput.count() && await passwordInput.count()) {
      loginAttempt = "submitted";
      await loginIdInput.fill(LOGIN_ID);
      await passwordInput.fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {}),
        passwordInput.press("Enter"),
      ]);
      await page.waitForTimeout(2000);
      pageTitle = await page.title().catch(() => "");
      pageUrl = page.url();
      loginAttempt = `submitted finalUrl=${pageUrl} title=${pageTitle || "none"}`;
    } else if (/ログイン|Login/i.test(pageTitle) || /Account\/Login/i.test(pageUrl)) {
      loginAttempt = "login page found but inputs not found";
    }

    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 45000)),
      new Promise((resolve) => {
        const timer = setInterval(() => {
          if (latestByLabel.has("暑さ指数")) {
            clearInterval(timer);
            resolve();
          }
        }, 500);
      }),
    ]);
  } finally {
    await browser.close().catch(() => {});
  }

  const labels = Array.from(observedLabels).join(", ") || "none";
  const targets = Array.from(observedTargets).join(", ") || "none";
  const previews = observedMessages.join(" | ") || "none";
  return dataFromGraphs(
    latestByLabel,
    `Browser GraphHub capture did not return WBGT data. page=${pageStatus}; finalUrl=${pageUrl}; title=${pageTitle || "none"}; login=${loginAttempt}; frames=${frameCount}; targets=${targets}; labels=${labels}; previews=${previews}`,
  );
};

const findNear = (text, labels) => {
  for (const label of labels) {
    const index = text.indexOf(label);
    if (index >= 0) {
      const part = text.slice(index, index + 120);
      const value = numberFrom(part);
      if (value != null) {
        return value;
      }
    }
  }
  return null;
};

const parsePayload = (raw) => {
  const maybeJson = raw.trim().startsWith("{") || raw.trim().startsWith("[");
  if (maybeJson) {
    const data = JSON.parse(raw);
    const first = Array.isArray(data) ? data[0] : data;
    const value = Number(first.wbgt ?? first.WBGT ?? first.value ?? first.Value ?? first.heatIndex);
    const temperature = first.temperature ?? first.Temperature ?? first.temp ?? first.Temp;
    const humidity = first.humidity ?? first.Humidity;
    const sourceUpdatedAt = first.measuredAt ?? first.MeasuredAt ?? first.updatedAt ?? first.UpdatedAt ?? first.time;
    return {
      status: Number.isFinite(value) ? "ok" : "parse_error",
      value: Number.isFinite(value) ? value : demoData.value,
      level: first.level ?? first.Level ?? classifyWbgt(Number.isFinite(value) ? value : null),
      temperature: temperature != null ? `${temperature}` : demoData.temperature,
      humidity: humidity != null ? `${humidity}` : demoData.humidity,
      sourceUpdatedAt: sourceUpdatedAt != null ? `${sourceUpdatedAt}` : null,
      message: Number.isFinite(value) ? "WBGTサイトから更新しました。" : "JSONからWBGT値を特定できませんでした。",
    };
  }

  const text = stripTags(raw).replace(/\s+/g, " ").trim();
  const value = findNear(text, ["暑さ指数", "WBGT", "暑さ", "指数"]) ?? numberFrom(text);
  const temperature = findNear(text, ["気温", "温度", "Temperature"]);
  const humidity = findNear(text, ["湿度", "Humidity"]);
  const timeMatch = text.match(/(?:更新|測定|時刻|日時)[^\d]*(\d{1,2}:\d{2})/) ?? text.match(/\b\d{1,2}:\d{2}\b/);

  return {
    status: value != null ? "ok" : "parse_error",
    value: value ?? demoData.value,
    level: classifyWbgt(value),
    temperature: temperature != null ? `${temperature}℃` : demoData.temperature,
    humidity: humidity != null ? `${humidity}%` : demoData.humidity,
    sourceUpdatedAt: timeMatch?.[1] ?? timeMatch?.[0] ?? null,
    message: value != null ? "WBGTサイトから更新しました。" : "HTMLからWBGT値を特定できませんでした。",
  };
};

const fetchDataUrl = async () => {
  const response = await fetch(DATA_URL, {
    headers: process.env.WBGT_DATA_AUTHORIZATION
      ? { Authorization: process.env.WBGT_DATA_AUTHORIZATION }
      : undefined,
  });
  if (!response.ok) {
    throw new Error(`DATA_URL request failed: ${response.status}`);
  }
  return parsePayload(await response.text());
};

const loginAndFetchHtml = async () => {
  if (!LOGIN_ID || !PASSWORD) {
    return {
      ...demoData,
      status: "missing_credentials",
      message: "GitHub SecretsにWBGT_LOGIN_IDとWBGT_PASSWORDを設定してください。",
    };
  }

  const jar = new Map();
  const firstResponse = await fetch(BASE_URL, {
    redirect: "manual",
    headers: browserHeaders(),
  });
  mergeCookies(jar, firstResponse.headers);
  const loginPageUrl = new URL("/Account/Login?ReturnUrl=%2Fwbgtmonitoring%2F", SITE_ORIGIN).toString();
  const loginPageResponse = await fetch(loginPageUrl, {
    redirect: "manual",
    headers: browserHeaders(jar),
  });
  mergeCookies(jar, loginPageResponse.headers);
  const loginHtml = loginPageResponse.ok ? await loginPageResponse.text() : "";
  const tokenMatch = loginHtml.match(/name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/i)
    ?? loginHtml.match(/type="hidden"\s+value="([^"]+)"\s+name="__RequestVerificationToken"/i);
  const formAction = loginHtml.match(/<form[^>]*action=["']?([^"'\s>]+)/i)?.[1];

  const loginUrl = formAction ? new URL(formAction, loginPageUrl).toString() : loginPageUrl;
  const form = new URLSearchParams();
  form.set("Input.LoginId", LOGIN_ID);
  form.set("Input.Password", PASSWORD);
  form.set("Input.Hold", "true");
  if (tokenMatch?.[1]) {
    form.set("__RequestVerificationToken", tokenMatch[1]);
  }

  let loginStatus = `login page ${loginPageResponse.status} ${loginPageUrl}`;
  let redirectedUrl;
  if (loginHtml && (tokenMatch?.[1] || /LoginId|Password/i.test(loginHtml))) {
    const loginResponse = await fetch(loginUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...browserHeaders(jar),
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: SITE_ORIGIN,
        Referer: loginPageUrl,
      },
      body: form,
    });
    mergeCookies(jar, loginResponse.headers);
    loginStatus = `login post ${loginResponse.status} ${loginUrl}`;
    redirectedUrl = loginResponse.headers.get("location")
      ? new URL(loginResponse.headers.get("location"), BASE_URL).toString()
      : undefined;
  }

  let graphHubError;
  try {
    return await fetchBrowserGraphHubData();
  } catch (error) {
    graphHubError = new Error(`${error instanceof Error ? error.message : error}; ${loginStatus}`);
    console.warn(error instanceof Error ? error.message : error);
  }

  try {
    return await fetchGraphHubData(jar);
  } catch (error) {
    graphHubError = new Error(`${graphHubError.message}; direct GraphHub failed: ${error instanceof Error ? error.message : error}`);
    console.warn(error instanceof Error ? error.message : error);
  }

  const candidates = [
    envValue("WBGT_TARGET_URL"),
    redirectedUrl,
    BASE_URL,
    new URL("./", BASE_URL).toString(),
  ].filter(Boolean);

  let html = "";
  let lastStatus = "";
  for (const targetUrl of [...new Set(candidates)]) {
    const pageResponse = await fetch(targetUrl, {
      headers: browserHeaders(jar),
    });
    lastStatus = `${pageResponse.status} ${targetUrl}`;
    if (!pageResponse.ok) {
      continue;
    }
    html = await pageResponse.text();
    if (!/404|Not Found/i.test(stripTags(html))) {
      break;
    }
  }

  if (!html) {
    const graphHubMessage = graphHubError instanceof Error ? graphHubError.message : `${graphHubError}`;
    throw new Error(`GraphHub failed: ${graphHubMessage}; WBGT page request failed: ${lastStatus}`);
  }

  if (/Account\/Login|ログイン|LoginId|Password/i.test(html)) {
    return {
      ...demoData,
      status: "login_failed",
      message: "WBGTサイトへログインできませんでした。SecretsのIDとパスワードを確認してください。",
    };
  }

  return parsePayload(html);
};

try {
  const data = DATA_URL ? await fetchDataUrl() : await loginAndFetchHtml();
  await writeJson(data);
  console.log(`WBGT update status: ${data.status}`);
} catch (error) {
  await writeJson({
    ...demoData,
    status: "error",
    message: error instanceof Error ? error.message : "WBGT更新に失敗しました。",
  });
  console.error(error);
}
