import fetch from "node-fetch";
import { readCoupons, readExpiredCodes, writeCoupons, writeExpiredCodes, updateCouponStatus } from "./lib/store.js";

const MAX_PER_RUN = 60;

async function checkCoupon(coupon) {
  try {
    const res = await fetch(coupon.full_url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      timeout: 15000,
    });

    if (!res.ok) { console.log(`  ✗ HTTP ${res.status}`); return false; }
    const html = await res.text();

    // Free signals — Udemy embeds pricing data as JSON in the page HTML
    const freePatterns = [
      /"amount":"0(\.0+)?"/,
      /"amount":0\b/,
      /"discount_price_string":"Free"/i,
      /"price_string":"Free"/i,
      /"discounted_price_string":"Free"/i,
      /enroll for free/i,
      /"current_price_text":"Free"/i,
      /"purchasePrice":"0/i,
    ];
    for (const re of freePatterns) {
      if (re.test(html)) { console.log(`  ✓ FREE — ${re}`); return true; }
    }

    // Paid signal — a non-zero amount found
    const paidMatch = html.match(/"amount":"(\d+\.?\d*)"/);
    if (paidMatch && parseFloat(paidMatch[1]) > 0) {
      console.log(`  ✗ PAID — $${paidMatch[1]}`);
      return false;
    }

    // Expired coupon message
    if (/coupon.*(?:not valid|expired|invalid|no longer)/i.test(html)) {
      console.log(`  ✗ EXPIRED — coupon invalid message`);
      return false;
    }

    console.log(`  ? UNCERTAIN — no clear price signal`);
    return null; // don't mark expired — leave for next check
  } catch (err) {
    console.warn(`  ⚠ Error (skipping): ${err.message.slice(0, 80)}`);
    return null;
  }
}

async function run() {
  const coupons = readCoupons();
  const expiredCodes = readExpiredCodes();

  const toCheck = coupons
    .filter(c => c.status !== "expired")
    .sort((a, b) => {
      if (a.status === "unverified" && b.status !== "unverified") return -1;
      if (b.status === "unverified" && a.status !== "unverified") return 1;
      return new Date(a.last_checked || 0) - new Date(b.last_checked || 0);
    })
    .slice(0, MAX_PER_RUN);

  if (!toCheck.length) {
    console.log("Nothing to check.");
  } else {
    console.log(`Checking ${toCheck.length} coupon(s)...`);
    for (const c of toCheck) {
      console.log(`[${c.id}] ${c.course_title.slice(0, 60)}`);
      const result = await checkCoupon(c);
      if (result === true) {
        updateCouponStatus(c, "active");
      } else if (result === false) {
        updateCouponStatus(c, "expired");
        expiredCodes.add(c.coupon_code); // blacklist this code so scraper won't re-add it
      }
      await new Promise(r => setTimeout(r, 800));
    }
  }

  // writeCoupons automatically drops expired ones from the file
  writeCoupons(coupons);
  writeExpiredCodes(expiredCodes);

  const active = coupons.filter(c => c.status === "active").length;
  const unverified = coupons.filter(c => c.status === "unverified").length;
  const expired = coupons.filter(c => c.status === "expired").length;
  console.log(`\nDone. ${active} active ✓ | ${unverified} unverified | ${expired} removed | ${expiredCodes.size} codes blacklisted`);
}

run().catch(err => { console.error("Check failed:", err); process.exit(1); });
