// Visits each stored coupon's Udemy URL in a real (headless) browser and reads the
// actual displayed price. If it shows Free / $0, marks the coupon "active"; otherwise
// "expired". Also drops coupons that have been expired for more than 14 days, to keep
// the data file small.
//
// NOTE: Udemy's page structure / CSS selectors can change at any time — if this stops
// detecting prices correctly, inspect the course page HTML and update PRICE_SELECTORS.

import { chromium } from "playwright";
import { readCoupons, writeCoupons } from "./lib/store.js";

const PRICE_SELECTORS = [
  '[data-purpose="course-price-text"]',
  '[data-purpose="discount-price"] span',
  ".price-text--final-price--2tP5h",
];

const FREE_PATTERNS = [/free/i, /^\$?0(\.00)?$/];
const MAX_TO_CHECK_PER_RUN = 60; // keep each Action run reasonably fast
const PRUNE_EXPIRED_AFTER_DAYS = 14;

async function getDisplayedPrice(page) {
  for (const selector of PRICE_SELECTORS) {
    const el = await page.$(selector);
    if (el) {
      const text = (await el.textContent())?.trim();
      if (text) return text;
    }
  }
  return null;
}

async function checkCoupon(browser, coupon) {
  const page = await browser.newPage({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  });

  try {
    await page.goto(coupon.full_url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2000);

    const priceText = await getDisplayedPrice(page);
    const isFree = priceText && FREE_PATTERNS.some((re) => re.test(priceText));

    coupon.status = isFree ? "active" : "expired";
    coupon.last_checked = new Date().toISOString();
    console.log(`[${coupon.status.toUpperCase()}] ${coupon.course_title} (price: ${priceText ?? "not found"})`);
  } catch (err) {
    console.warn(`Failed to check "${coupon.course_title}": ${err.message}`);
    // Leave status untouched on a network/timeout failure.
  } finally {
    await page.close();
  }
}

async function run() {
  const coupons = readCoupons();

  const toCheck = coupons
    .filter((c) => c.status !== "expired")
    .sort((a, b) => new Date(a.last_checked || 0) - new Date(b.last_checked || 0))
    .slice(0, MAX_TO_CHECK_PER_RUN);

  if (toCheck.length === 0) {
    console.log("No coupons need checking right now.");
  } else {
    console.log(`Checking ${toCheck.length} coupon(s)...`);
    const browser = await chromium.launch({ headless: true });
    for (const coupon of toCheck) {
      await checkCoupon(browser, coupon);
      await new Promise((r) => setTimeout(r, 2000));
    }
    await browser.close();
  }

  const cutoff = Date.now() - PRUNE_EXPIRED_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const kept = coupons.filter(
    (c) => c.status !== "expired" || new Date(c.last_checked || c.found_at).getTime() > cutoff
  );

  writeCoupons(kept);
  console.log(`Done. ${kept.length} coupons stored (${coupons.length - kept.length} pruned).`);
}

run().catch((err) => {
  console.error("Validity check failed:", err);
  process.exit(1);
});
