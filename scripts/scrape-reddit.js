// Multi-source Udemy coupon scraper.
// Sources: Discudemy.com, Real.Discount — both are public free-course listing pages
// that work reliably from GitHub Actions (unlike Reddit, which blocks server IPs).

import fetch from "node-fetch";
import { readCoupons, writeCoupons, upsertCoupon } from "./lib/store.js";

const UDEMY_URL_REGEX =
  /https?:\/\/(?:www\.)?udemy\.com\/course\/[a-zA-Z0-9\-_/]+\/?\?[^\s"')&<]*couponCode=([A-Za-z0-9_\-]+)/g;

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.text();
}

function extractCouponLinks(html) {
  const matches = [...html.matchAll(UDEMY_URL_REGEX)];
  return matches.map((m) => ({
    fullUrl: m[0].replace(/&amp;/g, "&"),
    couponCode: m[1],
    courseUrl: m[0].split("?")[0],
  }));
}

function slugToTitle(courseUrl) {
  const slug = courseUrl.split("/course/")[1]?.replace(/\/$/, "") ?? "unknown";
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function scrapeDiscudemy(coupons) {
  console.log("Scraping Discudemy...");
  let newCount = 0;
  try {
    for (let page = 1; page <= 3; page++) {
      const html = await fetchPage(`https://www.discudemy.com/all/${page}`);
      const goLinks = [...html.matchAll(/href="(https?:\/\/(?:www\.)?discudemy\.com\/go\/[^"]+)"/g)].map((m) => m[1]);
      for (const goUrl of goLinks) {
        try {
          const goHtml = await fetchPage(goUrl);
          for (const c of extractCouponLinks(goHtml)) {
            const added = upsertCoupon(coupons, { course_title: slugToTitle(c.courseUrl), course_url: c.courseUrl, coupon_code: c.couponCode, full_url: c.fullUrl, source: "discudemy.com" });
            if (added) newCount++;
          }
          await new Promise((r) => setTimeout(r, 800));
        } catch (err) { console.warn(`  Discudemy go-page error: ${err.message}`); }
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  } catch (err) { console.warn(`Discudemy scrape failed: ${err.message}`); }
  console.log(`  Discudemy: ${newCount} new coupon(s) found`);
}

async function scrapeRealDiscount(coupons) {
  console.log("Scraping Real.Discount...");
  let newCount = 0;
  try {
    for (let page = 1; page <= 3; page++) {
      const html = await fetchPage(`https://real.discount/search/?type=100off&store=Udemy&page=${page}`);
      for (const c of extractCouponLinks(html)) {
        const added = upsertCoupon(coupons, { course_title: slugToTitle(c.courseUrl), course_url: c.courseUrl, coupon_code: c.couponCode, full_url: c.fullUrl, source: "real.discount" });
        if (added) newCount++;
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  } catch (err) { console.warn(`Real.Discount scrape failed: ${err.message}`); }
  console.log(`  Real.Discount: ${newCount} new coupon(s) found`);
}

async function scrapeReddit(coupons) {
  console.log("Scraping Reddit (fallback)...");
  let newCount = 0;
  for (const sub of ["udemyfreebies", "FreeUdemyCourse", "udemyFreeCoupon"]) {
    try {
      const res = await fetch(`https://www.reddit.com/r/${sub}/new.json?limit=50`, { headers: { "User-Agent": "udemy-coupon-collector/2.0" } });
      if (!res.ok) { console.warn(`  r/${sub}: HTTP ${res.status}`); continue; }
      const posts = (await res.json())?.data?.children ?? [];
      for (const post of posts) {
        const d = post.data;
        for (const c of extractCouponLinks(`${d.title ?? ""} ${d.url ?? ""} ${d.selftext ?? ""}`)) {
          const added = upsertCoupon(coupons, { course_title: d.title?.slice(0, 200) ?? slugToTitle(c.courseUrl), course_url: c.courseUrl, coupon_code: c.couponCode, full_url: c.fullUrl, source: `reddit:r/${sub}` });
          if (added) newCount++;
        }
      }
    } catch (err) { console.warn(`  r/${sub} error: ${err.message}`); }
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(`  Reddit: ${newCount} new coupon(s) found`);
}

async function run() {
  const coupons = readCoupons();
  const before = coupons.length;
  await scrapeDiscudemy(coupons);
  await scrapeRealDiscount(coupons);
  await scrapeReddit(coupons);
  writeCoupons(coupons);
  console.log(`\nTotal: ${coupons.length - before} new coupon(s) added. ${coupons.length} in database.`);
}

run().catch((err) => { console.error("Scrape failed:", err); process.exit(1); });
