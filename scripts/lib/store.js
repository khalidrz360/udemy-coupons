import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "..", "docs", "data");
const COUPONS_PATH = path.join(DATA_DIR, "coupons.json");
const EXPIRED_PATH = path.join(DATA_DIR, "expired_codes.json");

export function readCoupons() {
  if (!fs.existsSync(COUPONS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(COUPONS_PATH, "utf-8")); }
  catch { return []; }
}

export function readExpiredCodes() {
  if (!fs.existsSync(EXPIRED_PATH)) return new Set();
  try { return new Set(JSON.parse(fs.readFileSync(EXPIRED_PATH, "utf-8"))); }
  catch { return new Set(); }
}

export function writeCoupons(coupons) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Only write non-expired to the public file (expired ones are auto-removed)
  const clean = coupons.filter(c => c.status !== "expired");
  fs.writeFileSync(COUPONS_PATH, JSON.stringify(clean, null, 2));
}

export function writeExpiredCodes(expiredCodes) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Cap at 10,000 to prevent file growing forever; keep the newest ones
  const arr = [...expiredCodes].slice(-10000);
  fs.writeFileSync(EXPIRED_PATH, JSON.stringify(arr, null, 2));
}

// Deduplicates by coupon_code+course_url combo (not just full_url which can differ slightly).
// Skips if coupon_code is already known expired.
export function upsertCoupon(coupons, expiredCodes, newCoupon) {
  if (expiredCodes.has(newCoupon.coupon_code)) return false; // known bad — skip
  const key = `${newCoupon.coupon_code}::${newCoupon.course_url}`;
  if (coupons.some(c => `${c.coupon_code}::${c.course_url}` === key)) return false; // duplicate
  const nextId = coupons.length ? Math.max(...coupons.map(c => c.id)) + 1 : 1;
  coupons.push({ id: nextId, status: "unverified", found_at: new Date().toISOString(), last_checked: null, ...newCoupon });
  return true;
}

export function updateCouponStatus(coupon, status) {
  coupon.status = status;
  coupon.last_checked = new Date().toISOString();
}
