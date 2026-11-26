import { NextResponse } from "next/server";
import {
  detectProvider,
  isAuthenticWebhook,
  parseHotmartEvent,
  parseKiwifyEvent,
} from "@/server/external-checkout";
import { recordExternalCheckoutEvent } from "@/server/external-checkout-apply";

/**
 * Kiwify / Hotmart webhook. Configure in the provider's panel:
 *   https://SEU-DOMINIO/api/billing/pagamento-webhook?secret=CHECKOUT_WEBHOOK_SECRET
 * Kiwify's own `signature` (KIWIFY_WEBHOOK_TOKEN) and Hotmart's hottok
 * (HOTMART_HOTTOK) are also accepted.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const provider = detectProvider(body, request.headers);
  if (!provider) {
    return NextResponse.json({ error: "Unknown payment provider" }, { status: 400 });
  }
  if (!isAuthenticWebhook(provider, rawBody, new URL(request.url), request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const event = provider === "kiwify" ? parseKiwifyEvent(body) : parseHotmartEvent(body);
  if (event.action === "ignore" || !event.email) {
    // Pix generated, boleto printed, test pings: nothing to change.
    return NextResponse.json({ ok: true, ignored: event.eventType });
  }

  try {
    const applied = await recordExternalCheckoutEvent({ ...event, email: event.email });
    return NextResponse.json({ ok: true, duplicate: !applied });
  } catch (error) {
    console.error("Payment webhook failed", { provider, eventType: event.eventType, error });
    return NextResponse.json({ error: "Webhook handler failed" }, { status: 500 });
  }
}
