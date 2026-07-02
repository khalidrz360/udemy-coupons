import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "..", "docs", "data", "coupons.json");

export function readCoupons() {
  if (!fs.existsSync(DATA_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8")); }
  catch { return []; }
}

export function writeCoupons(coupons) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(coupons, null, 2));
}

export function upsertCoupon(coupons, newCoupon) {
  if (coupons.some(c => c.full_url === newCoupon.full_url)) return false;
  const nextId = coupons.length ? Math.max(...coupons.map(c => c.id)) + 1 : 1;
  coupons.push({ id: nextId, status: "unverified", found_at: new Date().toISOString(), last_checked: null, ...newCoupon });
  return true;
}

// Mutates the coupon object directly (works since JS passes objects by reference)
export function updateCouponStatus(coupon, status) {
  coupon.status = status;
  coupon.last_checked = new Date().toISOString();
}
