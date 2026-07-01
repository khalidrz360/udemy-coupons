import { chromium } from "playwright";
import { readCoupons, writeCoupons, upsertCoupon } from "./lib/store.js";

const UDEMY_REGEX =
  /https?:\/\/(?:www\.)?udemy\.com\/course\/[a-zA-Z0-9\-_/]+\/?\?[^\s"'<>]*couponCode=([A-Za-z0-9_\-]+)/g;

function extractCoupons(text) {
  return [...text.matchAll(UDEMY_REGEX)].map((m) => ({
    fullUrl: m[0].replace(/&amp;/g, "&"),
    couponCode: m[1],
    courseUrl: m[0].split("?")[0],
  }));
}

function slugToTitle(courseUrl) {
  const slug = courseUrl.split("/course/")[1]?.replace(/\/$/, "") ?? "unknown";
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

async function scrapeDiscudemy(browser, coupons) {
  console.log("Scraping Discudemy...");
  let newCount = 0;
  const listPage = await browser.newPage();
  try {
    const goLinks = new Set();
    for (let p = 1; p <= 3; p++) {
      try {
        await listPage.goto(`https://www.discudemy.com/all/${p}`, { waitUntil: "domcontentloaded", timeout: 25000 });
        await listPage.waitForTimeout(1500);
        const links = await listPage.$$eval('a[href*="/go/"]', (els) => els.map((e) => e.href));
        links.forEach((l) => goLinks.add(l));
        console.log(`  Discudemy listing page ${p}: ${links.length} links`);
      } catch (err) { console.warn(`  Discudemy page ${p} error: ${err.message}`); }
      await new Promise((r) => setTimeout(r, 1000));
    }
    console.log(`  ${goLinks.size} unique course links, checking each...`);
    for (const goUrl of [...goLinks].slice(0, 25)) {
      const coursePage = await browser.newPage();
      try {
        await coursePage.goto(goUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
        await coursePage.waitForTimeout(2000);
        const finalUrl = coursePage.url();
        const html = await coursePage.content();
        let found = [];
        if (finalUrl.includes("udemy.com") && finalUrl.includes("couponCode=")) {
          const clean = finalUrl.replace(/&amp;/g, "&");
          found.push({ fullUrl: clean, couponCode: new URL(clean).searchParams.get("couponCode"), courseUrl: clean.split("?")[0] });
        }
        if (!found.length) found = extractCoupons(html);
        if (!found.length) {
          const hrefs = await coursePage.$$eval("a[href]", (els) => els.map((e) => e.href).filter((h) => h.includes("udemy.com") && h.includes("couponCode")));
          for (const h of hrefs) found.push(...extractCoupons(h));
        }
        for (const c of found) {
          if (!c.couponCode) continue;
          const added = upsertCoupon(coupons, { course_title: slugToTitle(c.courseUrl), course_url: c.courseUrl, coupon_code: c.couponCode, full_url: c.fullUrl, source: "discudemy.com" });
          if (added) newCount++;
        }
      } catch (err) { console.warn(`  Course page error: ${err.message}`); }
      finally { await coursePage.close(); }
      await new Promise((r) => setTimeout(r, 1200));
    }
  } finally { await listPage.close(); }
  console.log(`  Discudemy: ${newCount} new coupon(s)`);
}

async function scrapeRealDiscount(browser, coupons) {
  console.log("Scraping Real.Discount...");
  let newCount = 0;
  const page = await browser.newPage();
  try {
    for (let p = 1; p <= 3; p++) {
      try {
        await page.goto(`https://real.discount/search/?type=100off&store=Udemy&page=${p}`, { waitUntil: "networkidle", timeout: 25000 });
        await page.waitForTimeout(2000);
        const html = await page.content();
        const found = extractCoupons(html);
        const hrefs = await page.$$eval("a[href*='udemy.com']", (els) => els.map((e) => e.href));
        for (const h of hrefs) found.push(...extractCoupons(h));
        for (const c of found) {
          if (!c.couponCode) continue;
          const added = upsertCoupon(coupons, { course_title: slugToTitle(c.courseUrl), course_url: c.courseUrl, coupon_code: c.couponCode, full_url: c.fullUrl, source: "real.discount" });
          if (added) newCount++;
        }
        console.log(`  Real.Discount page ${p}: ${found.length} links`);
      } catch (err) { console.warn(`  Real.Discount page ${p} error: ${err.message}`); }
      await new Promise((r) => setTimeout(r, 1500));
    }
  } finally { await page.close(); }
  console.log(`  Real.Discount: ${newCount} new coupon(s)`);
}

async function scrapeCouponScorpion(browser, coupons) {
  console.log("Scraping CouponScorpion...");
  let newCount = 0;
  const page = await browser.newPage();
  try {
    await page.goto("https://couponscorpion.com/", { waitUntil: "networkidle", timeout: 25000 });
    await page.waitForTimeout(2000);
    const html = await page.content();
    const found = extractCoupons(html);
    const hrefs = await page.$$eval("a[href]", (els) => els.map((e) => e.href).filter((h) => h.includes("udemy.com")));
    for (const h of hrefs) found.push(...extractCoupons(h));
    for (const c of found) {
      if (!c.couponCode) continue;
      const added = upsertCoupon(coupons, { course_title: slugToTitle(c.courseUrl), course_url: c.courseUrl, coupon_code: c.couponCode, full_url: c.fullUrl, source: "couponscorpion.com" });
      if (added) newCount++;
    }
  } catch (err) { console.warn(`CouponScorpion error: ${err.message}`); }
  finally { await page.close(); }
  console.log(`  CouponScorpion: ${newCount} new coupon(s)`);
}

async function run() {
  const coupons = readCoupons();
  const before = coupons.length;
  const browser = await chromium.launch({ headless: true });
  try {
    await scrapeDiscudemy(browser, coupons);
    await scrapeRealDiscount(browser, coupons);
    await scrapeCouponScorpion(browser, coupons);
  } finally {
    await browser.close();
  }
  writeCoupons(coupons);
  console.log(`\nDone. ${coupons.length - before} new coupon(s) added. ${coupons.length} total.`);
}

run().catch((err) => { console.error("Scrape failed:", err); process.exit(1); });
