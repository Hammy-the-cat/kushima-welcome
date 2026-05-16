import { writeFile } from "node:fs/promises";

const envValue = (name) => {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
};

const BASE_URL = envValue("WBGT_BASE_URL") ?? "https://takanabe.aimnextiot.com/wbgtmonitoring/";
const LOGIN_ID = envValue("WBGT_LOGIN_ID");
const PASSWORD = envValue("WBGT_PASSWORD");
const DATA_URL = envValue("WBGT_DATA_URL");
const OUTPUT_PATH = process.env.WBGT_OUTPUT_PATH ?? "wbgt-live.json";

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
  const groups = (envValue("WBGT_GRAPH_GROUPS") ?? "1070,1071")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const sensors = (envValue("WBGT_GRAPH_SENSORS") ?? "17,14,15")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  let index = 0;
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

const fetchGraphHubData = async (jar) => {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this Node.js runtime.");
  }

  const negotiateUrl = new URL("GraphHub/negotiate?negotiateVersion=1", BASE_URL).toString();
  const negotiateResponse = await fetch(negotiateUrl, {
    method: "POST",
    headers: {
      Cookie: cookieHeader(jar),
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  if (!negotiateResponse.ok) {
    throw new Error(`GraphHub negotiate failed: ${negotiateResponse.status}`);
  }
  mergeCookies(jar, negotiateResponse.headers);
  const negotiate = await negotiateResponse.json();
  const connectionId = negotiate.connectionToken ?? negotiate.connectionId;
  if (!connectionId) {
    throw new Error("GraphHub negotiate response did not include connection id.");
  }

  const websocketUrl = new URL("GraphHub", BASE_URL);
  websocketUrl.protocol = websocketUrl.protocol === "https:" ? "wss:" : "ws:";
  websocketUrl.searchParams.set("id", connectionId);

  const graphItems = buildGraphItems();
  const latestByLabel = new Map();
  const end = new Date();
  const start = new Date(end.getTime() - 1000 * 60 * 60 * 24 * 2);

  await new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl.toString());
    const timeout = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // ignore close errors
      }
      reject(new Error("GraphHub timed out before receiving WBGT data."));
    }, 20000);

    const finishIfReady = () => {
      if (latestByLabel.has("暑さ指数") && latestByLabel.has("湿度") && (latestByLabel.has("気温") || latestByLabel.has("温度"))) {
        clearTimeout(timeout);
        try {
          socket.close();
        } catch {
          // ignore close errors
        }
        resolve();
      }
    };

    socket.addEventListener("open", () => {
      socket.send(signalRFrame({ protocol: "json", version: 1 }));
      socket.send(signalRFrame({
        type: 1,
        invocationId: "0",
        target: "addAllGraph",
        arguments: [new Date().toISOString(), 14, graphItems],
      }));
      socket.send(signalRFrame({
        type: 1,
        target: "setGraphRange",
        arguments: [formatDateTimeJst(start), formatDateTimeJst(end)],
      }));
    });

    socket.addEventListener("message", (event) => {
      for (const message of parseSignalRFrames(event.data)) {
        const latest = getLatestGraphValue(message);
        if (latest) {
          latestByLabel.set(latest.label, latest);
        }
      }
      finishIfReady();
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("GraphHub websocket error."));
    });
  });

  const wbgt = latestByLabel.get("暑さ指数");
  const humidity = latestByLabel.get("湿度");
  const temperature = latestByLabel.get("気温") ?? latestByLabel.get("温度");
  if (!wbgt) {
    throw new Error("GraphHub did not return WBGT data.");
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
  const loginPageResponse = await fetch(BASE_URL, { redirect: "manual" });
  mergeCookies(jar, loginPageResponse.headers);
  const loginHtml = await loginPageResponse.text();
  const tokenMatch = loginHtml.match(/name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/i)
    ?? loginHtml.match(/type="hidden"\s+value="([^"]+)"\s+name="__RequestVerificationToken"/i);

  const loginUrl = new URL("Account/Login?ReturnUrl=%2Fwbgtmonitoring%2F", BASE_URL).toString();
  const form = new URLSearchParams();
  form.set("Input.LoginId", LOGIN_ID);
  form.set("Input.Password", PASSWORD);
  form.set("Input.Hold", "true");
  if (tokenMatch?.[1]) {
    form.set("__RequestVerificationToken", tokenMatch[1]);
  }

  const loginResponse = await fetch(loginUrl, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: cookieHeader(jar),
    },
    body: form,
  });
  mergeCookies(jar, loginResponse.headers);

  try {
    return await fetchGraphHubData(jar);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : error);
  }

  const redirectedUrl = loginResponse.headers.get("location")
    ? new URL(loginResponse.headers.get("location"), BASE_URL).toString()
    : undefined;
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
      headers: {
        Cookie: cookieHeader(jar),
      },
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
    throw new Error(`WBGT page request failed: ${lastStatus}`);
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
