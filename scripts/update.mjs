// Nightly Etsy sync: updates review stats and prices in index.html. Fails safe: any error leaves index.html untouched.
import fs from "node:fs";
const KEY = process.env.ETSY_KEYSTRING, SECRET = process.env.ETSY_SHARED_SECRET || "";
const SHOP = process.env.ETSY_SHOP_NAME || "DragonPrecisionWorks";
if (!KEY) { console.error("Missing ETSY_KEYSTRING"); process.exit(1); }
const BASE = "https://openapi.etsy.com/v3/application";
async function get(path, withSecret) {
  const r = await fetch(BASE + path, { headers: { "x-api-key": withSecret ? `${KEY}:${SECRET}` : KEY } });
  if (!r.ok) { const e = new Error(`${r.status} ${path}: ${(await r.text()).slice(0, 200)}`); e.status = r.status; throw e; }
  return r.json();
}
let useSecret = false;
async function api(path) {
  try { return await get(path, useSecret); }
  catch (e) { if ((e.status === 401 || e.status === 403) && SECRET && !useSecret) { useSecret = true; return get(path, true); } throw e; }
}
const found = await api(`/shops?shop_name=${encodeURIComponent(SHOP)}`);
const shopId = found.results?.[0]?.shop_id;
if (!shopId) throw new Error("Shop not found");
const shop = await api(`/shops/${shopId}`);
const rating = Number(shop.review_average), reviews = Number(shop.review_count), sold = Number(shop.transaction_sold_count);
const prices = {};
for (let offset = 0; offset < 500; offset += 100) {
  const page = await api(`/shops/${shopId}/listings/active?limit=100&offset=${offset}`);
  for (const l of page.results || []) if (l.price?.divisor) prices[String(l.listing_id)] = l.price.amount / l.price.divisor;
  if ((page.results || []).length < 100) break;
}
let html = fs.readFileSync("index.html", "utf8"), changed = 0;
if (rating > 0 && reviews > 0 && sold > 0) {
  const before = html;
  html = html.replace(/<b>[\d.]+<\/b> from \d+ Etsy reviews/, `<b>${rating.toFixed(1)}</b> from ${reviews} Etsy reviews`)
             .replace(/<b>[\d,]+<\/b> orders shipped/, `<b>${sold.toLocaleString("en-US")}</b> orders shipped`);
  if (html !== before) changed++;
} else console.warn("Stats looked invalid, skipped");
html = html.replace(/\["([^"]*)","([^"]*)",([\d.]+),"(\d+)"\]/g, (m, name, cat, old, id) => {
  const nv = prices[id];
  if (nv === undefined) { console.warn("Not active on Etsy (kept old price):", name); return m; }
  const o = Number(old);
  if (nv <= 0 || Math.abs(nv - o) / o > 0.6) { console.warn(`Price jump skipped for ${name}: ${o} -> ${nv}`); return m; }
  if (Math.abs(nv - o) > 0.001) { console.log(`Price ${name}: ${o} -> ${nv}`); changed++; return `["${name}","${cat}",${nv},"${id}"]`; }
  return m;
});
// Reviews carousel data. Never blocks the other updates: on any problem the existing reviews stay as they are.
try {
  const names = {};
  for (const m of html.matchAll(/\["([^"]*)","[^"]*",[\d.]+,"(\d+)"\]/g)) names[m[2]] = m[1];
  // Etsy only allows the first page of reviews for anonymous requests, which is plenty for 12 cards.
  const page = await api(`/shops/${shopId}/reviews?limit=100`);
  const all = page.results || [];
  const picked = all
    .filter(r => r.rating >= 4 && typeof r.review === "string" && r.review.trim().length >= 25)
    .sort((a, b) => (b.create_timestamp || 0) - (a.create_timestamp || 0))
    .slice(0, 12)
    .map(r => {
      let t = r.review.trim().replace(/\s+/g, " ");
      if (t.length > 320) t = t.slice(0, 317).replace(/\s+\S*$/, "") + "...";
      const d = r.create_timestamp ? new Date(r.create_timestamp * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }) : "";
      const o = { r: r.rating, t, d };
      if (names[String(r.listing_id)]) o.n = names[String(r.listing_id)];
      return o;
    });
  if (picked.length >= 3) {
    const json = JSON.stringify(picked).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    const next = html.replace(/\/\*REV-START\*\/[\s\S]*?\/\*REV-END\*\//, () => `/*REV-START*/var REV=${json};/*REV-END*/`);
    if (next !== html) { html = next; changed++; console.log(`Reviews: ${picked.length} shown (of ${all.length} read)`); }
  } else console.warn(`Reviews: only ${picked.length} usable, carousel left unchanged`);
} catch (e) { console.warn("Reviews skipped:", e.message); }
fs.writeFileSync("index.html", html);
console.log(`Done. ${changed} change(s). Stats: ${rating} / ${reviews} reviews / ${sold} sold. Listings seen: ${Object.keys(prices).length}`);
