# SG Upper FX Ticker

A minimal OBS browser-source ticker for the **top** of Shailesh Gour's live streams. It contains only popular FX pair quotes and USD economic-calendar headlines, continuously scrolling in a single line.

## Deploy
Connect this repository to Vercel. The static page is `index.html`; `api/market.js` is the serverless market-data endpoint.

## Data
- FX quotes: Yahoo Finance chart endpoint for EUR/USD, GBP/USD, USD/JPY, USD/CHF, USD/CAD, AUD/USD and NZD/USD. Quote availability and latency depend on the upstream source.
- USD economic events: ForexFactory's public weekly calendar feed, including High, Medium and Low impact events.

This feed is not an execution-grade trading terminal. Do not use it as the sole source for trading decisions. If an upstream source fails, the ticker avoids inventing values and reports feed unavailability.

## OBS
Add the deployed URL as a Browser Source. Recommended dimensions: **1920 × 60**. Keep the source width at 1920 and place it at the top edge of the scene.
