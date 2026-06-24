// Arlette Brooklyn weather + Shabbat texter.
//   MODE=morning  -> today's forecast (sent daily at 7am ET)
//   MODE=shabbat  -> Saturday's forecast + candle lighting + Shabbat Shalom
//                    (sent Friday at 3pm ET, before she puts her phone down)
//
// Weather data: api.weather.gov (free, NWS - the gold standard for US forecasts)
// Candle lighting: hebcal.com (free, defaults to 18 min before sunset)
// SMS: TextBelt paid key (sends immediately - timing is handled in the workflow)

const PHONE = process.env.ARLETTE_PHONE;
const KEY = process.env.TEXTBELT_KEY;
const MODE = process.env.MODE || "morning";

// Hardcoded NWS grid for Brooklyn ZIP 11230
const FORECAST_URL = "https://api.weather.gov/gridpoints/OKX/35,38/forecast";
const USER_AGENT = "echabot-wx-bot brian@echabot.com";

// Hebcal Shabbat times for ZIP 11230, candles 18 min before sunset (NYC standard)
const HEBCAL_URL = "https://www.hebcal.com/shabbat?cfg=json&zip=11230&b=18&M=on";

async function getForecast() {
  const res = await fetch(FORECAST_URL, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`weather.gov returned ${res.status}`);
  const data = await res.json();
  return data.properties.periods;
}

async function getCandleLighting() {
  const res = await fetch(HEBCAL_URL);
  if (!res.ok) throw new Error(`hebcal returned ${res.status}`);
  const data = await res.json();
  const candle = data.items.find(i => i.category === "candles");
  if (!candle) return null;
  const dt = new Date(candle.date);
  const timeStr = dt.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  // "8:01 PM" -> "8:01pm"
  return timeStr.replace(/\s/g, "").toLowerCase();
}

// ----- Forecast period selection -----
// Robust: find the next daytime period (today's day), then find the next
// non-daytime period AFTER that (today's night). This handles all edge cases
// including when NWS has "Overnight" as periods[0] in early morning runs.

function pickTodayTonight(periods) {
  const dayIdx = periods.findIndex(p => p.isDaytime);
  if (dayIdx === -1) {
    return { day: null, night: periods[0] };
  }
  const day = periods[dayIdx];
  const night = periods.slice(dayIdx + 1).find(p => !p.isDaytime);
  return { day, night };
}

function pickSaturday(periods) {
  // Find the period labeled "Saturday" (daytime). Fall back to first daytime
  // period more than 12h in the future if labels differ.
  const day = periods.find(p => p.isDaytime && /^Saturday$/i.test(p.name));
  if (day) {
    const dayIdx = periods.indexOf(day);
    const night = periods.slice(dayIdx + 1).find(p => !p.isDaytime);
    return { day, night };
  }
  // Fallback: assume periods[2] / periods[3] when run on Friday afternoon
  return { day: periods[2], night: periods[3] };
}

// ----- Message composition -----

function rainPhrase(detail, pop) {
  const hasStorms = /thunderstorm/.test(detail);
  const hasRain = pop >= 40 || /shower|rain|drizzle/.test(detail);
  if (!hasStorms && !hasRain) return "no rain";

  const timing = extractTiming(detail);
  if (hasStorms) {
    return timing ? `thunderstorms ${timing}, bring umbrella` : "thunderstorms possible, bring umbrella";
  }
  return timing ? `rain ${timing}, bring umbrella` : "rain possible, bring umbrella";
}

function clothingTip(high, low) {
  if (high < 40)      return `Heavy coat, gloves, hat. Bitter cold, low ${low} tonight.`;
  if (high < 55)      return `Warm coat or layered jacket. Low ${low} tonight.`;
  if (high < 68)      return `Light jacket or sweater. Cools to ${low} tonight.`;
  if (high < 78)      return `T-shirt weather, light layer for evening - low ${low} after dark.`;
  if (high < 85)      return `T-shirt, sunglasses, drink water. Cools to ${low} tonight.`;
  return                   `Hot - sunscreen, lots of water, avoid midday sun.`;
}

function windPhrase(detail) {
  const m = detail.match(/(\d{1,2})\s*(?:to\s*(\d{1,2}))?\s*mph/);
  if (!m) return "";
  const peak = parseInt(m[2] || m[1], 10);
  return peak >= 20 ? ` Windy (gusts to ${peak} mph).` : "";
}

function extractTiming(detail) {
  const m = detail.match(/(?:between\s+\d{1,2}\s*(?:am|pm)\s+and\s+\d{1,2}\s*(?:am|pm)|after\s+\d{1,2}\s*(?:am|pm)|before\s+\d{1,2}\s*(?:am|pm))/i);
  if (!m) return null;
  return m[0]
    .replace(/between\s+(\d{1,2}\s*(?:am|pm))\s+and\s+(\d{1,2}\s*(?:am|pm))/i, "$1-$2")
    .replace(/\s+/g, " ")
    .trim();
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function trim(msg, limit) {
  return msg.length > limit ? msg.substring(0, limit - 3) + "..." : msg;
}

function composeMorning(periods) {
  const { day, night } = pickTodayTonight(periods);
  if (!day || !night) {
    throw new Error(`Could not find today's day/night periods. Got: ${periods.map(p => p.name).join(", ")}`);
  }
  const high = day.temperature;
  const low = night.temperature;
  const sky = capitalize(day.shortForecast);
  const detail = day.detailedForecast.toLowerCase();
  const pop = day.probabilityOfPrecipitation?.value ?? 0;

  const rain = rainPhrase(detail, pop);
  const wind = windPhrase(detail);
  const tip = clothingTip(high, low);

  return trim(`Brooklyn today: ${high} high, ${low} low. ${sky}, ${rain}.${wind} ${tip}`, 160);
}

function composeShabbat(periods, candleTime) {
  const { day, night } = pickSaturday(periods);
  if (!day || !night) {
    throw new Error(`Could not find Saturday day/night periods. Got: ${periods.map(p => p.name).join(", ")}`);
  }
  const high = day.temperature;
  const low = night.temperature;
  const sky = capitalize(day.shortForecast);
  const detail = day.detailedForecast.toLowerCase();
  const pop = day.probabilityOfPrecipitation?.value ?? 0;

  const rain = rainPhrase(detail, pop);
  const candle = candleTime ? ` Candle lighting ${candleTime}.` : "";

  const msg = `Shabbat Shalom. Saturday in Brooklyn: ${high} high, ${low} low. ${sky}, ${rain}.${candle} Have a beautiful Shabbat.`;
  // Allow up to 2 SMS segments (320 chars) for shabbat â costs 1 extra credit per Friday.
  return trim(msg, 320);
}

// ----- SMS -----

async function sendText(message) {
  const params = new URLSearchParams({ phone: PHONE, message, key: KEY });
  const res = await fetch("https://textbelt.com/text", { method: "POST", body: params });
  return await res.json();
}

// ----- Main -----

(async () => {
  if (!PHONE || !KEY) {
    console.error("Missing ARLETTE_PHONE or TEXTBELT_KEY env vars.");
    process.exit(1);
  }
  console.log(`Mode: ${MODE}`);
  console.log(`Current time (ET): ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })}`);

  try {
    const periods = await getForecast();
    console.log(`Forecast periods: ${periods.slice(0, 4).map(p => `${p.name}(${p.temperature}F, daytime=${p.isDaytime})`).join(", ")}`);

    let message;
    if (MODE === "shabbat") {
      const candleTime = await getCandleLighting().catch(e => {
        console.error("Hebcal failed:", e.message);
        return null;
      });
      message = composeShabbat(periods, candleTime);
    } else {
      message = composeMorning(periods);
    }

    console.log(`Message (${message.length} chars): ${message}`);

    const result = await sendText(message);
    console.log("TextBelt response:", JSON.stringify(result));

    if (!result.success) process.exit(1);
    if (typeof result.quotaRemaining === "number" && result.quotaRemaining < 30) {
      console.log(`Quota low: ${result.quotaRemaining} credits - buy more at textbelt.com/purchase`);
    }
  } catch (err) {
    console.error("Forecast or send failed:", err.message);
    const fallback = MODE === "shabbat"
      ? "Shabbat Shalom. Weather feed is down - check weather.com for Saturday. Have a beautiful Shabbat."
      : "Brooklyn weather feed is down this morning - check weather.com for today's forecast.";
    try {
      const result = await sendText(fallback);
      console.log("Fallback sent:", JSON.stringify(result));
    } catch (e2) {
      console.error("Fallback also failed:", e2.message);
    }
    process.exit(1);
  }
})();
