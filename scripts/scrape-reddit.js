import fetch from "node-fetch";
import { chromium } from "playwright";
import { readCoupons, writeCoupons, upsertCoupon } from "./lib/store.js";

const UDEMY_REGEX = /https?:\/\/(?:www\.)?udemy\.com\/course\/[a-zA-Z0-9\-_/]+\/?\?[^\s"'<>\]]*couponCode=([A-Za-z0-9_\-]+)/g;

function extractCoupons(text) {
  return [...text.matchAll(UDEMY_REGEX)].map(m => ({
    fullUrl: m[0].replace(/&amp;/g, "&"),
    couponCode: m[1],
    courseUrl: m[0].split("?")[0],
  }));
}

function slugToTitle(url) {
  const slug = url.split("/course/")[1]?.replace(/\/$/, "") ?? "unknown";
  return slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// SOURCE 1: Telegram public channel web pages (static HTML, no JS, never blocked)
const TELEGRAM_CHANNELS = [
  "udemyfreebies", "udemycoupon", "udemyfreecoursess",
  "freecoursesite", "Udemy_Free_Courses_Daily", "learnfreely",
  "FreeEducationForAll", "udemylearn",
];

async function scrapeTelegram(coupons) {
  console.log("Scraping Telegram channels...");
  let total = 0;
  for (const ch of TELEGRAM_CHANNELS) {
    try {
      const res = await fetch(`https://t.me/s/${ch}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
      });
      const text = res.ok ? await res.text() : "";
      const found = extractCoupons(text);
      let added = 0;
      for (const c of found) {
        if (!c.couponCode) continue;
        const ok = upsertCoupon(coupons, { course_title: slugToTitle(c.courseUrl), course_url: c.courseUrl, coupon_code: c.couponCode, full_url: c.fullUrl, source: `telegram:${ch}` });
        if (ok) { total++; added++; }
      }
      console.log(`  t.me/${ch}: HTTP ${res.status} | ${found.length} links | ${added} new`);
    } catch (err) { console.warn(`  t.me/${ch}: ${err.message}`); }
    await new Promise(r => setTimeout(r, 800));
  }
  console.log(`  Telegram total: ${total} new`);
}

// SOURCE 2: Discudemy RSS feed (plain XML, WordPress, no JS needed)
async function scrapeDiscudemyRSS(coupons) {
  console.log("Scraping Discudemy RSS...");
  let total = 0;
  try {
    const res = await fetch("https://www.discudemy.com/feed", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RSS reader)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    console.log(`  ${items.length} RSS items found`);
    for (const item of items) {
      const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
      const title = titleMatch?.[1]?.trim() ?? "Unknown";
      // The coupon URL may be in the description or a <link> field
      const found = extractCoupons(item);
      // Also try fetching the linked page if URL not directly in RSS
      if (!found.length) {
        const linkMatch = item.match(/<link>(https?:\/\/[^<]+)<\/link>/) || item.match(/<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/);
        if (linkMatch) {
          try {
            const pg = await fetch(linkMatch[1], { headers: { "User-Agent": "Mozilla/5.0" } });
            if (pg.ok) found.push(...extractCoupons(await pg.text()));
          } catch {}
        }
      }
      for (const c of found) {
        if (!c.couponCode) continue;
        const ok = upsertCoupon(coupons, { course_title: title.slice(0, 200), course_url: c.courseUrl, coupon_code: c.couponCode, full_url: c.fullUrl, source: "discudemy.com" });
        if (ok) total++;
      }
    }
  } catch (err) { console.warn(`  Discudemy RSS: ${err.message}`); }
  console.log(`  Discudemy RSS: ${total} new`);
}

// SOURCE 3: Learnviral RSS (another WordPress coupon site)
async function scrapeLearnviralRSS(coupons) {
  console.log("Scraping Learnviral RSS...");
  let total = 0;
  try {
    const res = await fetch("https://learnviral.com/feed/", { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    for (const item of items) {
      const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
      const title = titleMatch?.[1]?.trim() ?? "Unknown";
      for (const c of extractCoupons(item)) {
        if (!c.couponCode) continue;
        const ok = upsertCoupon(coupons, { course_title: title.slice(0, 200), course_url: c.courseUrl, coupon_code: c.couponCode, full_url: c.fullUrl, source: "learnviral.com" });
        if (ok) total++;
      }
    }
    console.log(`  Learnviral RSS: ${total} new`);
  } catch (err) { console.warn(`  Learnviral RSS: ${err.message}`); }
}

// SOURCE 4: Browser-based with --no-sandbox (required for GitHub Actions CI)
async function scrapeBrowser(coupons) {
  console.log("Browser scraping Real.Discount + CouponScorpion...");
  let total = 0;
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  for (const src of [
    "https://real.discount/search/?type=100off&store=Udemy",
    "https://couponscorpion.com/",
  ]) {
    const page = await browser.newPage();
    try {
      await page.goto(src, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(3000);
      const html = await page.content();
      const found = extractCoupons(html);
      const hrefs = await page.$$eval("a[href]", els => els.map(e => e.href).filter(h => h.includes("udemy.com"))).catch(() => []);
      for (const h of hrefs) found.push(...extractCoupons(h));
      let added = 0;
      for (const c of found) {
        if (!c.couponCode) continue;
        const ok = upsertCoupon(coupons, { course_title: slugToTitle(c.courseUrl), course_url: c.courseUrl, coupon_code: c.couponCode, full_url: c.fullUrl, source: new URL(src).hostname });
        if (ok) { total++; added++; }
      }
      console.log(`  ${new URL(src).hostname}: ${found.length} links, ${added} new`);
    } catch (err) { console.warn(`  Browser error (${src}): ${err.message}`); }
    finally { await page.close(); }
    await new Promise(r => setTimeout(r, 1500));
  }
  await browser.close();
  console.log(`  Browser sources: ${total} new`);
}

async function run() {
  const coupons = readCoupons();
  const before = coupons.length;
  await scrapeTelegram(coupons);
  await scrapeDiscudemyRSS(coupons);
  await scrapeLearnviralRSS(coupons);
  await scrapeBrowser(coupons);
  writeCoupons(coupons);
  console.log(`\nDone. ${coupons.length - before} new added. ${coupons.length} total.`);
}

run().catch(err => { console.error("Scrape failed:", err); process.exit(1); });
