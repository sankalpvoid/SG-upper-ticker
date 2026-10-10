const SYMBOLS = [
  ["EURUSD=X", "EUR/USD"],
  ["GBPUSD=X", "GBP/USD"],
  ["USDJPY=X", "USD/JPY"],
  ["USDCHF=X", "USD/CHF"],
  ["USDCAD=X", "USD/CAD"],
  ["AUDUSD=X", "AUD/USD"],
  ["NZDUSD=X", "NZD/USD"]
];

const IMPACT_ORDER = { High: 0, Medium: 1, Low: 2 };

async function getQuote(symbol, pair) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol) + "?range=1d&interval=5m";
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 SG-Upper-Ticker/1.0", "Accept": "application/json" },
    signal: AbortSignal.timeout(7000)
  });
  if (!response.ok) throw new Error("Quote source returned " + response.status);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const meta = result?.meta;
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const valid = closes.filter(value => typeof value === "number" && Number.isFinite(value));
  const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : valid.at(-1);
  const previous = typeof meta?.chartPreviousClose === "number" ? meta.chartPreviousClose :
    (typeof meta?.previousClose === "number" ? meta.previousClose : valid[0]);
  if (!Number.isFinite(price)) throw new Error("Quote missing for " + pair);
  return {
    pair,
    price,
    changePct: Number.isFinite(previous) && previous !== 0 ? ((price - previous) / previous) * 100 : null
  };
}

async function getNews() {
  const response = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
    headers: { "User-Agent": "Mozilla/5.0 SG-Upper-Ticker/1.0", "Accept": "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("ForexFactory calendar returned " + response.status);
  const rows = await response.json();
  const dayKey = value => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(value);
  const today = dayKey(new Date());
  const tomorrowDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tomorrow = dayKey(tomorrowDate);

  const events = rows
    .filter(item => String(item.currency || "").toUpperCase() === "USD")
    .filter(item => ["High", "Medium", "Low"].includes(item.impact))
    .filter(item => item.title && item.date)
    .map(item => ({
      title: item.title,
      impact: item.impact,
      time: item.date,
      actual: item.actual || "",
      forecast: item.forecast || "",
      timestamp: new Date(item.date).getTime(),
      day: dayKey(new Date(item.date))
    }))
    .filter(item => Number.isFinite(item.timestamp) && [today, tomorrow].includes(item.day))
    .sort((a, b) => a.timestamp - b.timestamp || IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact]);

  // Prefer today's USD calendar, then add tomorrow's events only when today's
  // calendar has fewer than three, so the ticker shows 3–4 distinct items.
  const todaysEvents = events.filter(item => item.day === today);
  const tomorrowsEvents = events.filter(item => item.day === tomorrow);
  const selected = todaysEvents.slice(0, 4);
  if (selected.length < 3) {
    selected.push(...tomorrowsEvents.slice(0, 4 - selected.length));
  }
  return selected.slice(0, 4).map(({ day, ...item }) => item);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const quotes = await Promise.allSettled(SYMBOLS.map(([symbol, pair]) => getQuote(symbol, pair)));
  const prices = quotes.filter(item => item.status === "fulfilled").map(item => item.value);
  let news = [];
  let newsUnavailable = false;
  try {
    news = await getNews();
  } catch (error) {
    newsUnavailable = true;
  }

  res.status(200).json({
    updatedAt: new Date().toISOString(),
    prices,
    news,
    partial: prices.length !== SYMBOLS.length || newsUnavailable
  });
};
