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
  const urls = [
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    "https://nfs.faireconomy.media/ff_calendar_nextweek.json"
  ];
  // Saturday/Sunday often have no remaining events in the current-week feed.
  // Merge this week and next week so the ticker can always find the next USD releases.
  const calendars = await Promise.all(urls.map(async url => {
    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 SG-Upper-Ticker/1.0", "Accept": "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error("ForexFactory calendar returned " + response.status);
    return response.json();
  }));
  const dayKey = value => new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(value);
  const now = Date.now();

  const unique = new Map();
  calendars.flat().forEach(item => {
    if (String(item.currency || "").toUpperCase() !== "USD") return;
    if (!["High", "Medium", "Low"].includes(item.impact)) return;
    if (!item.title || !item.date) return;
    const timestamp = new Date(item.date).getTime();
    if (!Number.isFinite(timestamp)) return;
    const key = String(item.title).trim().toLowerCase() + "|" + timestamp;
    if (unique.has(key)) return;
    unique.set(key, {
      title: item.title,
      impact: item.impact,
      time: item.date,
      actual: item.actual || "",
      forecast: item.forecast || "",
      timestamp,
      day: dayKey(new Date(timestamp))
    });
  });

  const events = [...unique.values()].sort((a, b) =>
    a.timestamp - b.timestamp || IMPACT_ORDER[a.impact] - IMPACT_ORDER[b.impact]
  );
  // Show the next three upcoming USD releases, regardless of which day they fall on.
  // If fewer than three remain in the two feeds, show all remaining upcoming events.
  const upcoming = events.filter(item => item.timestamp >= now);
  const selected = upcoming.length ? upcoming.slice(0, 3) : events.slice(-3).reverse();
  return selected.map(({ timestamp, ...item }) => item);
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
