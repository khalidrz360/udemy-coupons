import fetch from "node-fetch";
import { chromium } from "playwright";
import { readCoupons, writeCoupons, upsertCoupon } from "./lib/store.js";

const UDEMY_REGEX = /https?:\/\/(?:www\.)?udemy\.com\/course\/[a-zA-Z0-9\-_.]+\/?\?[^"'\s<>]*couponCode=([A-Za-z0-9_\-]+)/gi;

function extractCoupons(text) {
  const decoded = text.replace(/&amp;/g,"&").replace(/&#38;/g,"&");
  return [...decoded.matchAll(UDEMY_REGEX)].map(m => ({
    fullUrl: m[0], couponCode: m[1], courseUrl: m[0].split("?")[0]
  }));
}

function slugToTitle(url) {
  return (url.split("/course/")[1]?.replace(/\/$/, "") ?? "unknown")
    .split("-").map(w => w.charAt(0).toUpperCase()+w.slice(1)).join(" ");
}

function save(coupons, found, source, title) {
  let n = 0;
  for (const c of found) {
    if (!c.couponCode) continue;
    if (upsertCoupon(coupons, {
      course_title: (title || slugToTitle(c.courseUrl)).slice(0, 200),
      course_url: c.courseUrl, coupon_code: c.couponCode,
      full_url: c.fullUrl, source
    })) n++;
  }
  return n;
}

async function fetchText(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
    redirect: "follow",
  });
  return r.ok ? r.text() : "";
}

// ─── Source 1: Discudemy — Playwright follows JS redirect on /go/ pages ──────
async function scrapeDiscudemy(browser, coupons) {
  console.log("=== Discudemy ===");
  let total = 0;
  try {
    const xml = await fetchText("https://www.discudemy.com/feed");
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    console.log(`  ${items.length} RSS items`);

    for (const item of items) {  // process ALL items, no slice limit
      const title = (item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1] ?? "Unknown")
        .replace(/<[^>]+>/g,"").replace(/\[100% OFF\]/g,"").trim();
      const postUrl = item.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i)?.[1]?.trim();
      if (!postUrl) continue;

      // First try: direct URL extraction (fast, no browser)
      let found = extractCoupons(item);
      if (found.length) { total += save(coupons, found, "discudemy.com", title); continue; }

      // Second try: fetch post page, look for /go/ link, follow with Playwright
      const page = await browser.newPage();
      try {
        await page.goto(postUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await page.waitForTimeout(1500);

        const goHref = await page.$eval('a[href*="/go/"]', el => el.href).catch(() => null);
        if (goHref) {
          const goPage = await browser.newPage();
          try {
            await goPage.goto(goHref, { waitUntil: "domcontentloaded", timeout: 15000 });
            await goPage.waitForTimeout(8000); // wait for JS redirect to Udemy

            const finalUrl = goPage.url();
            if (finalUrl.includes("udemy.com") && finalUrl.includes("couponCode")) {
              const clean = finalUrl.replace(/&amp;/g,"&");
              const code = new URL(clean).searchParams.get("couponCode");
              if (code && upsertCoupon(coupons, {
                course_title: title, course_url: clean.split("?")[0],
                coupon_code: code, full_url: clean, source: "discudemy.com"
              })) { total++; console.log(`  ✓ ${title.slice(0,50)} [${code}]`); }
            } else {
              // Try extracting from page HTML if no redirect
              const html = await goPage.content();
              total += save(coupons, extractCoupons(html), "discudemy.com", title);
            }
          } finally { await goPage.close(); }
        }
      } catch(e) { console.warn(`  Error: ${e.message.slice(0,60)}`); }
      finally { await page.close(); }
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch(e) { console.warn(`Discudemy error: ${e.message}`); }
  console.log(`Discudemy: ${total} new`);
}

// ─── Source 2: Tutorialbar RSS (plain XML, very fresh coupons) ───────────────
async function scrapeTutorialbar(coupons) {
  console.log("=== Tutorialbar ===");
  let total = 0;
  try {
    const xml = await fetchText("https://www.tutorialbar.com/all-courses/feed/");
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    console.log(`  ${items.length} RSS items`);
    for (const item of items) {
      const title = (item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1] ?? "Unknown")
        .replace(/<[^>]+>/g,"").trim();
      let found = extractCoupons(item);
      if (!found.length) {
        // Try the post page
        const postUrl = item.match(/<link[^>]*>\s*(https?:\/\/[^\s<]+)\s*<\/link>/i)?.[1]?.trim();
        if (postUrl) {
          try {
            const html = await fetchText(postUrl);
            found = extractCoupons(html);
          } catch {}
          await new Promise(r => setTimeout(r, 600));
        }
      }
      total += save(coupons, found, "tutorialbar.com", title);
    }
  } catch(e) { console.warn(`Tutorialbar error: ${e.message}`); }
  console.log(`Tutorialbar: ${total} new`);
}

// ─── Source 3: Coursevania (simple HTML page with direct Udemy links) ─────────
async function scorpionFetch(coupons) {
  console.log("=== Coursevania ===");
  let total = 0;
  try {
    const html = await fetchText("https://coursevania.com/courses/?swoof=1&pa_free=100-off&really_curr_tax=116-product_cat&orderby=date");
    const found = extractCoupons(html);
    total = save(coupons, found, "coursevania.com", null);
    console.log(`  ${found.length} links found`);
  } catch(e) { console.warn(`Coursevania error: ${e.message}`); }
  console.log(`Coursevania: ${total} new`);
}

async function run() {
  const coupons = readCoupons();
  const before = coupons.length;

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"],
  });
  try {
    await scrapeDiscudemy(browser, coupons);
  } finally {
    await browser.close();
  }

  await scrapeTutorialbar(coupons);
  await scorpionFetch(coupons);

  writeCoupons(coupons);
  console.log(`\nDone. ${coupons.length - before} new added. ${coupons.length} total.`);
}

run().catch(err => { console.error("Scrape failed:", err); process.exit(1); });
