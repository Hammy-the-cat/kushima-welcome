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

  const targetUrl = envValue("WBGT_TARGET_URL") ?? BASE_URL;
  const pageResponse = await fetch(targetUrl, {
    headers: {
      Cookie: cookieHeader(jar),
    },
  });
  if (!pageResponse.ok) {
    throw new Error(`WBGT page request failed: ${pageResponse.status}`);
  }
  const html = await pageResponse.text();
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
