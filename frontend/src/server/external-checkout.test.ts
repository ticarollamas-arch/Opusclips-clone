import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import {
  detectProvider,
  externalCheckoutUrl,
  isAuthenticWebhook,
  paidUntil,
  parseHotmartEvent,
  parseKiwifyEvent,
} from "./external-checkout";

const ENV_KEYS = [
  "CHECKOUT_WEBHOOK_SECRET",
  "KIWIFY_WEBHOOK_TOKEN",
  "HOTMART_HOTTOK",
  "CHECKOUT_ANNUAL_IDS",
  "CHECKOUT_URL_MENSAL",
  "CHECKOUT_URL_ANUAL",
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

const kiwifyApproved = {
  order_id: "abc123",
  order_status: "paid",
  webhook_event_type: "order_approved",
  approved_date: "2026-11-25 21:00",
  Customer: { email: "Cliente@Exemplo.com", full_name: "Cliente" },
  Product: { product_id: "prod-mensal" },
  Subscription: { plan: { frequency: "monthly", name: "Mensal" } },
};

describe("parseKiwifyEvent", () => {
  it("grants a monthly plan on an approved order", () => {
    const event = parseKiwifyEvent(kiwifyApproved);
    expect(event.action).toBe("grant");
    expect(event.interval).toBe("month");
    expect(event.email).toBe("Cliente@Exemplo.com");
    expect(event.paidAt.toISOString()).toBe("2026-11-26T00:00:00.000Z");
  });

  it("detects the annual plan by frequency or listed id", () => {
    expect(parseKiwifyEvent({ ...kiwifyApproved, Subscription: { plan: { frequency: "yearly" } } }).interval).toBe("year");
    process.env.CHECKOUT_ANNUAL_IDS = "prod-anual";
    expect(parseKiwifyEvent({ ...kiwifyApproved, Subscription: {}, Product: { product_id: "prod-anual" } }).interval).toBe("year");
  });

  it("revokes on refund and chargeback, cancels on subscription cancel", () => {
    expect(parseKiwifyEvent({ ...kiwifyApproved, webhook_event_type: "order_refunded", order_status: "refunded" }).action).toBe("revoke");
    expect(parseKiwifyEvent({ ...kiwifyApproved, webhook_event_type: "chargeback", order_status: "chargedback" }).action).toBe("revoke");
    expect(parseKiwifyEvent({ ...kiwifyApproved, webhook_event_type: "subscription_canceled" }).action).toBe("cancel");
  });

  it("ignores pix and boleto generated", () => {
    expect(parseKiwifyEvent({ ...kiwifyApproved, webhook_event_type: "pix_created", order_status: "waiting_payment" }).action).toBe("ignore");
  });
});

describe("parseHotmartEvent", () => {
  const approved = {
    id: "evt-1",
    event: "PURCHASE_APPROVED",
    data: {
      buyer: { email: "a@b.com" },
      product: { id: 99 },
      purchase: { transaction: "HP1", approved_date: 1764115200000 },
      subscription: { plan: { name: "Plano Anual" } },
    },
  };

  it("grants and reads the annual plan name", () => {
    const event = parseHotmartEvent(approved);
    expect(event).toMatchObject({ action: "grant", interval: "year", email: "a@b.com", eventKey: "hotmart:evt-1" });
  });

  it("does not read 'Plano Mensal' as annual", () => {
    const monthly = { ...approved, data: { ...approved.data, subscription: { plan: { name: "Plano Mensal" } } } };
    expect(parseHotmartEvent(monthly).interval).toBe("month");
  });

  it("revokes on refund and cancels on subscription cancellation", () => {
    expect(parseHotmartEvent({ ...approved, event: "PURCHASE_REFUNDED" }).action).toBe("revoke");
    expect(parseHotmartEvent({ ...approved, event: "SUBSCRIPTION_CANCELLATION" }).action).toBe("cancel");
  });
});

describe("webhook authentication", () => {
  const url = (query = "") => new URL(`https://cortador.example/api/billing/pagamento-webhook${query}`);

  it("accepts the shared secret and rejects anything else", () => {
    process.env.CHECKOUT_WEBHOOK_SECRET = "s3cret";
    expect(isAuthenticWebhook("kiwify", "{}", url("?secret=s3cret"), new Headers())).toBe(true);
    expect(isAuthenticWebhook("kiwify", "{}", url("?secret=wrong"), new Headers())).toBe(false);
    expect(isAuthenticWebhook("hotmart", "{}", url(), new Headers())).toBe(false);
  });

  it("verifies Kiwify's HMAC-SHA1 signature", () => {
    process.env.KIWIFY_WEBHOOK_TOKEN = "tok";
    const body = JSON.stringify(kiwifyApproved);
    const signature = crypto.createHmac("sha1", "tok").update(body).digest("hex");
    expect(isAuthenticWebhook("kiwify", body, url(`?signature=${signature}`), new Headers())).toBe(true);
    expect(isAuthenticWebhook("kiwify", `${body} `, url(`?signature=${signature}`), new Headers())).toBe(false);
  });

  it("verifies Hotmart's hottok", () => {
    process.env.HOTMART_HOTTOK = "hot";
    expect(isAuthenticWebhook("hotmart", "{}", url(), new Headers({ "x-hotmart-hottok": "hot" }))).toBe(true);
    expect(isAuthenticWebhook("hotmart", "{}", url(), new Headers({ "x-hotmart-hottok": "nope" }))).toBe(false);
  });
});

describe("helpers", () => {
  it("detects the provider", () => {
    expect(detectProvider(kiwifyApproved, new Headers())).toBe("kiwify");
    expect(detectProvider({ event: "PURCHASE_APPROVED", data: { buyer: {} } }, new Headers())).toBe("hotmart");
    expect(detectProvider({}, new Headers())).toBeNull();
  });

  it("covers one month or one year", () => {
    const start = new Date("2026-01-31T12:00:00Z");
    expect(paidUntil(start, "year").toISOString()).toBe("2027-01-31T12:00:00.000Z");
    expect(paidUntil(new Date("2026-03-10T00:00:00Z"), "month").toISOString()).toBe("2026-04-10T00:00:00.000Z");
  });

  it("prefills the account email on the checkout link", () => {
    process.env.CHECKOUT_URL_MENSAL = "https://pay.kiwify.com.br/AbC";
    expect(externalCheckoutUrl("month", { email: "a@b.com", name: "Ana" })).toBe(
      "https://pay.kiwify.com.br/AbC?email=a%40b.com&name=Ana",
    );
    expect(externalCheckoutUrl("year", { email: "a@b.com" })).toBeNull();
  });
});
