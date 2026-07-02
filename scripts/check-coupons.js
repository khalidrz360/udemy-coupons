import { chromium } from "playwright";
import { readCoupons, writeCoupons, updateCouponStatus } from "./lib/store.js";

const MAX_PER_RUN = 40;
const PRUNE_AFTER_DAYS = 7;

async function isCouponFree(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);

    const result = await page.evaluate(() => {
      const allText = document.body.innerText || "";
      const freeSignals = [
        /\$\s*0\.00/,
        /enroll\s*for\s*free/i,
        /free\s*enroll/i,
        /price[^a-z]*free/i,
      ];
      for (const re of freeSignals) {
        if (re.test(allText)) return { free: true, reason: re.toString() };
      }
      const priceSelectors = [
        '[data-purpose*="price"]','[class*="price"]','[class*="Price"]',
        '[data-purpose*="coupon"]','div[class*="purchase"] span',
      ];
      const priceTexts = [];
      for (const sel of priceSelectors) {
        for (const el of document.querySelectorAll(sel)) {
          const t = el.innerText?.trim();
          if (t && t.length < 30) priceTexts.push(t);
        }
      }
      const priceSample = [...new Set(priceTexts)].slice(0, 8);
      for (const t of priceSample) {
        if (/free|\$\s*0(\.00)?/i.test(t)) return { free: true, reason: `"${t}"` };
      }
      return { free: false, priceSample, snippet: allText.slice(0, 300).replace(/\s+/g," ") };
    });

    if (result.free) { console.log(`  ✓ FREE — ${result.reason}`); return true; }
    console.log(`  ✗ PAID — prices: [${(result.priceSample||[]).join(" | ")}]`);
    console.log(`  page text: ${(result.snippet||"").slice(0,200)}`);
    return false;
  } catch (err) {
    console.warn(`  ⚠ Error (skipping): ${err.message.slice(0,80)}`);
    return null;
  }
}

async function run() {
  const coupons = readCoupons();
  const toCheck = coupons
    .filter(c => c.status !== "expired")
    .sort((a, b) => {
      if (a.status === "unverified" && b.status !== "unverified") return -1;
      if (b.status === "unverified" && a.status !== "unverified") return 1;
      return new Date(a.last_checked || 0) - new Date(b.last_checked || 0);
    })
    .slice(0, MAX_PER_RUN);

  if (!toCheck.length) { console.log("Nothing to check."); }
  else {
    console.log(`Checking ${toCheck.length} coupon(s)...`);
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"],
    });
    for (const c of toCheck) {
      console.log(`\n[${c.id}] ${c.course_title.slice(0,60)}`);
      const page = await browser.newPage();
      try {
        const free = await isCouponFree(page, c.full_url);
        if (free === true) updateCouponStatus(c, "active");
        else if (free === false) updateCouponStatus(c, "expired");
      } finally { await page.close(); }
      await new Promise(r => setTimeout(r, 2000));
    }
    await browser.close();
  }

  const cutoff = Date.now() - PRUNE_AFTER_DAYS * 86400000;
  const kept = coupons.filter(c =>
    c.status !== "expired" || new Date(c.last_checked || c.found_at).getTime() > cutoff
  );
  writeCoupons(kept);
  const active = kept.filter(c => c.status === "active").length;
  const unverified = kept.filter(c => c.status === "unverified").length;
  console.log(`\nDone. ${active} active, ${unverified} unverified, ${coupons.length - kept.length} pruned.`);
}

run().catch(err => { console.error("Check failed:", err); process.exit(1); });
