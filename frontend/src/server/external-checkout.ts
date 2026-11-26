import crypto from "node:crypto";

/**
 * Subscriptions sold on Kiwify or Hotmart. The checkout lives on their page;
 * they tell us about each payment by webhook, and the buyer's email links the
 * payment to the Cortador 9:16 account.
 */
export type ExternalCheckoutProvider = "kiwify" | "hotmart";
export type ExternalCheckoutInterval = "month" | "year";
/** grant: paid (first payment or renewal); revoke: refund/chargeback, ends now;
 *  cancel: no renewal, access runs to the end of the paid period; ignore: anything else. */
export type ExternalCheckoutAction = "grant" | "revoke" | "cancel" | "ignore";

export type ExternalCheckoutEvent = {
  provider: ExternalCheckoutProvider;
  eventKey: string;
  eventType: string;
  email: string | null;
  action: ExternalCheckoutAction;
  interval: ExternalCheckoutInterval;
  paidAt: Date;
};

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/** First non-empty string among `paths` (dot paths, case-sensitive keys tried as given). */
function pick(body: Json, ...paths: string[]): string | null {
  for (const path of paths) {
    let current: unknown = body;
    for (const key of path.split(".")) current = obj(current)[key];
    const value = str(current);
    if (value) return value;
  }
  return null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const numeric = Number(value);
  // Hotmart sends epoch milliseconds; Kiwify sends "YYYY-MM-DD HH:mm" (Brasília time).
  const date = Number.isFinite(numeric) && numeric > 1e11
    ? new Date(numeric)
    : new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(value) ? `${value.replace(" ", "T")}-03:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function listEnv(value: string | undefined): string[] {
  return (value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

/**
 * Annual when a product/offer/plan id is listed in CHECKOUT_ANNUAL_IDS, or the
 * plan's frequency or name says yearly. Everything else is monthly.
 */
function detectInterval(identifiers: (string | null)[], frequencyText: string): ExternalCheckoutInterval {
  const annualIds = listEnv(process.env.CHECKOUT_ANNUAL_IDS);
  if (identifiers.some((id) => id && annualIds.includes(id.toLowerCase()))) return "year";
  return /\b(year|yearly|annual|anual|anuidade)\b|12 ?mes/i.test(frequencyText) ? "year" : "month";
}

const KIWIFY_GRANT = new Set(["order_approved", "subscription_renewed"]);
const KIWIFY_REVOKE = new Set(["order_refunded", "chargeback"]);
const KIWIFY_CANCEL = new Set(["subscription_canceled", "subscription_late"]);

export function parseKiwifyEvent(body: Json): ExternalCheckoutEvent {
  const eventType = (pick(body, "webhook_event_type") || pick(body, "order_status") || "unknown").toLowerCase();
  const status = (pick(body, "order_status") || "").toLowerCase();
  let action: ExternalCheckoutAction = "ignore";
  if (KIWIFY_REVOKE.has(eventType) || status === "refunded" || status === "chargedback") action = "revoke";
  else if (KIWIFY_CANCEL.has(eventType)) action = "cancel";
  else if (KIWIFY_GRANT.has(eventType) || (eventType === "paid" && status === "paid")) action = "grant";

  const orderId = pick(body, "order_id", "order_ref") || "no-order";
  const chargeDate = pick(body, "approved_date", "updated_at", "created_at");
  return {
    provider: "kiwify",
    eventKey: `kiwify:${orderId}:${eventType}:${chargeDate || ""}`,
    eventType,
    email: pick(body, "Customer.email", "customer.email", "email"),
    action,
    interval: detectInterval(
      [pick(body, "Product.product_id"), pick(body, "Subscription.plan.id"), pick(body, "Subscription.plan.name")],
      `${pick(body, "Subscription.plan.frequency") || ""} ${pick(body, "Subscription.plan.name") || ""}`,
    ),
    paidAt: parseDate(chargeDate) || new Date(),
  };
}

const HOTMART_GRANT = new Set(["PURCHASE_APPROVED", "PURCHASE_COMPLETE"]);
const HOTMART_REVOKE = new Set(["PURCHASE_REFUNDED", "PURCHASE_CHARGEBACK", "PURCHASE_PROTEST"]);
const HOTMART_CANCEL = new Set(["SUBSCRIPTION_CANCELLATION", "PURCHASE_CANCELED", "PURCHASE_DELAYED"]);

export function parseHotmartEvent(body: Json): ExternalCheckoutEvent {
  const eventType = (pick(body, "event") || "UNKNOWN").toUpperCase();
  let action: ExternalCheckoutAction = "ignore";
  if (HOTMART_REVOKE.has(eventType)) action = "revoke";
  else if (HOTMART_CANCEL.has(eventType)) action = "cancel";
  else if (HOTMART_GRANT.has(eventType)) action = "grant";

  const transaction = pick(body, "data.purchase.transaction", "data.subscription.subscriber.code") || "no-transaction";
  return {
    provider: "hotmart",
    eventKey: `hotmart:${pick(body, "id") || `${transaction}:${eventType}`}`,
    eventType,
    email: pick(body, "data.buyer.email", "data.subscriber.email", "data.user.email"),
    action,
    interval: detectInterval(
      [pick(body, "data.product.id"), pick(body, "data.purchase.offer.code"), pick(body, "data.subscription.plan.id")],
      `${pick(body, "data.subscription.plan.name") || ""} ${pick(body, "data.plan.name") || ""}`,
    ),
    paidAt: parseDate(pick(body, "data.purchase.approved_date")) || new Date(),
  };
}

export function detectProvider(body: Json, headers: Headers): ExternalCheckoutProvider | null {
  if (headers.get("x-hotmart-hottok") || (str(body.event) && obj(body.data).buyer)) return "hotmart";
  if (str(body.webhook_event_type) || str(body.order_status) || obj(body.Customer).email) return "kiwify";
  return null;
}

export function constantTimeEqual(actual: string | null | undefined, expected: string): boolean {
  const a = Buffer.from(actual || "");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * A webhook is trusted when it carries the provider's own proof (Kiwify's
 * HMAC-SHA1 `signature` over the raw body, Hotmart's hottok header) or our
 * shared secret in the URL (`?secret=`), configured in the provider's panel.
 */
export function isAuthenticWebhook(
  provider: ExternalCheckoutProvider,
  rawBody: string,
  url: URL,
  headers: Headers,
): boolean {
  const sharedSecret = process.env.CHECKOUT_WEBHOOK_SECRET;
  if (sharedSecret && constantTimeEqual(url.searchParams.get("secret"), sharedSecret)) return true;

  if (provider === "kiwify") {
    const token = process.env.KIWIFY_WEBHOOK_TOKEN;
    const signature = url.searchParams.get("signature");
    if (!token || !signature) return false;
    const expected = crypto.createHmac("sha1", token).update(rawBody).digest("hex");
    return constantTimeEqual(signature.toLowerCase(), expected);
  }

  const hottok = process.env.HOTMART_HOTTOK;
  return Boolean(hottok) && constantTimeEqual(headers.get("x-hotmart-hottok"), hottok as string);
}

/** End of the period a payment covers: one month or one year after it. */
export function paidUntil(paidAt: Date, interval: ExternalCheckoutInterval): Date {
  const end = new Date(paidAt);
  if (interval === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

/** Checkout page for an interval, with the account email prefilled so the webhook finds the account. */
export function externalCheckoutUrl(
  interval: ExternalCheckoutInterval,
  customer: { email: string; name?: string | null },
): string | null {
  const base = interval === "year" ? process.env.CHECKOUT_URL_ANUAL : process.env.CHECKOUT_URL_MENSAL;
  if (!base) return null;
  try {
    const url = new URL(base);
    url.searchParams.set("email", customer.email);
    if (customer.name) url.searchParams.set("name", customer.name);
    return url.toString();
  } catch {
    return null;
  }
}

export function externalCheckoutEnabled(): boolean {
  return Boolean(process.env.CHECKOUT_URL_MENSAL || process.env.CHECKOUT_URL_ANUAL);
}
