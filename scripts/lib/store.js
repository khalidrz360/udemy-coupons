import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(__dirname, "..", "..", "docs", "data", "coupons.json");

export function readCoupons() {
  if (!fs.existsSync(DATA_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, "utf-8"));
  } catch {
    return [];
  }
}

export function writeCoupons(coupons) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(coupons, null, 2));
}

// Adds a coupon if its URL isn't already stored. Returns true if it was newly added.
export function upsertCoupon(coupons, newCoupon) {
  if (coupons.some((c) => c.full_url === newCoupon.full_url)) return false;
  const nextId = coupons.length ? Math.max(...coupons.map((c) => c.id)) + 1 : 1;
  coupons.push({
    id: nextId,
    status: "unverified",
    found_at: new Date().toISOString(),
    last_checked: null,
    ...newCoupon,
  });
  return true;
}
