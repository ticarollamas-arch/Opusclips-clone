import { getPrismaClient } from "@/server/prisma";
import {
  paidUntil,
  type ExternalCheckoutAction,
  type ExternalCheckoutEvent,
  type ExternalCheckoutInterval,
  type ExternalCheckoutProvider,
} from "@/server/external-checkout";

/** The one paid plan sold through Kiwify/Hotmart (R$ 7/mês ou R$ 47/ano). */
const SOLD_PLAN = "pro";

type Change = {
  provider: ExternalCheckoutProvider;
  action: ExternalCheckoutAction;
  interval: ExternalCheckoutInterval | null;
  paidAt: Date;
  paidUntil: Date | null;
};

async function findUserIdByEmail(email: string): Promise<string | null> {
  const user = await getPrismaClient().user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  return user?.id ?? null;
}

/** Apply one purchase change to an account. Idempotent for the same change. */
export async function applyExternalCheckoutChange(userId: string, change: Change): Promise<void> {
  const prisma = getPrismaClient();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { subscription_provider: true, billing_period_end: true },
  });
  if (!user) return;
  const sameProvider = user.subscription_provider === change.provider;

  if (change.action === "grant" && change.paidUntil) {
    // A retried or out-of-order notice never shortens a period already paid.
    const currentEnd = sameProvider ? user.billing_period_end : null;
    const end = currentEnd && currentEnd > change.paidUntil ? currentEnd : change.paidUntil;
    await prisma.user.update({
      where: { id: userId },
      data: {
        plan: SOLD_PLAN,
        subscription_status: "active",
        subscription_provider: change.provider,
        billing_period_start: change.paidAt,
        billing_period_end: end,
        trial_ends_at: null,
        subscription_cancel_at: null,
      },
    });
    return;
  }

  if (!sameProvider) return; // Never touch a plan granted some other way.

  if (change.action === "revoke") {
    await prisma.user.update({
      where: { id: userId },
      data: {
        plan: "free",
        subscription_status: "inactive",
        subscription_provider: null,
        billing_period_start: null,
        billing_period_end: null,
        trial_ends_at: null,
        subscription_cancel_at: null,
      },
    });
    return;
  }

  if (change.action === "cancel") {
    // Access continues until the paid period ends; the backend stops it then.
    await prisma.user.update({
      where: { id: userId },
      data: { subscription_cancel_at: user.billing_period_end ?? new Date() },
    });
  }
}

/**
 * Record a webhook event and apply it to the buyer's account.
 * Returns false when the event was already processed.
 */
export async function recordExternalCheckoutEvent(event: ExternalCheckoutEvent & { email: string }): Promise<boolean> {
  const prisma = getPrismaClient();
  const userId = await findUserIdByEmail(event.email);
  const until = event.action === "grant" ? paidUntil(event.paidAt, event.interval) : null;

  try {
    await prisma.externalCheckoutPurchase.create({
      data: {
        event_key: event.eventKey.slice(0, 255),
        provider: event.provider,
        event_type: event.eventType.slice(0, 64),
        email: event.email.toLowerCase().slice(0, 320),
        action: event.action,
        billing_interval: event.interval,
        paid_until: until,
        user_id: userId,
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") return false;
    throw error;
  }

  if (userId) {
    try {
      await applyExternalCheckoutChange(userId, {
        provider: event.provider,
        action: event.action,
        interval: event.interval,
        paidAt: event.paidAt,
        paidUntil: until,
      });
    } catch (error) {
      // Let the provider retry: forget the event so the retry is not skipped.
      await prisma.externalCheckoutPurchase.delete({ where: { event_key: event.eventKey.slice(0, 255) } }).catch(() => {});
      throw error;
    }
  }
  return true;
}

/**
 * Someone paid before creating the account (or with this email before signing up):
 * replay their unclaimed purchase events, oldest first, onto the new account.
 */
export async function claimExternalCheckoutPurchases(userId: string, email: string): Promise<void> {
  const prisma = getPrismaClient();
  const pending = await prisma.externalCheckoutPurchase.findMany({
    where: { user_id: null, email: { equals: email, mode: "insensitive" } },
    orderBy: { created_at: "asc" },
  });
  for (const purchase of pending) {
    const action = purchase.action as ExternalCheckoutAction;
    if (action === "ignore") continue;
    await applyExternalCheckoutChange(userId, {
      provider: purchase.provider as ExternalCheckoutProvider,
      action,
      interval: (purchase.billing_interval as ExternalCheckoutInterval | null) ?? null,
      paidAt: purchase.created_at,
      paidUntil: purchase.paid_until,
    });
    await prisma.externalCheckoutPurchase.update({
      where: { event_key: purchase.event_key },
      data: { user_id: userId },
    });
  }
}
