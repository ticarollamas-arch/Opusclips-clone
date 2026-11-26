export type BillingPlanId = "pro" | "scale";
export type BillingInterval = "month" | "year";

export type PublicBillingPlan = {
  id: BillingPlanId;
  name: string;
  priceMonthly: string;
  /** Price of a year, billed up front. */
  priceAnnual: string;
  /** Minutes of source video allowed each month. */
  minuteLimit: number;
  /** Output height label, e.g. "1080p". */
  resolution: string;
  scheduling: boolean;
  youtubeMaxMinutes: number;
  description: string;
  highlights: string[];
  cta: string;
  highlighted: boolean;
};

export const PAID_PLAN_IDS: BillingPlanId[] = ["pro", "scale"];

export function billingPlanMessageKey(plan: string | null | undefined): "free" | "pro" | "scale" | "selfHost" {
  if (plan === "pro" || plan === "scale") return plan;
  if (plan === "self_host") return "selfHost";
  return "free";
}

export function formatBillingPlanName(plan: string | null | undefined): string {
  if (plan === "pro") {
    return "Pro";
  }
  if (plan === "scale") {
    return "Creator";
  }
  if (plan === "self_host") {
    return "Self-Hosted";
  }
  return "Free";
}

export function isPaidBillingPlan(plan: string | null | undefined): plan is BillingPlanId {
  return plan === "pro" || plan === "scale";
}

export type SocialPublishingStage = "off" | "soon" | "live";

/**
 * How plan pages present scheduled posting (a Creator feature):
 * hidden ("off"), marked "Coming soon" (default, while platform reviews are
 * pending), or listed as a live feature ("live"). Set NEXT_PUBLIC_SOCIAL_PUBLISHING.
 */
export function socialPublishingStage(): SocialPublishingStage {
  const value = process.env.NEXT_PUBLIC_SOCIAL_PUBLISHING?.trim().toLowerCase();
  if (value === "off" || value === "0") return "off";
  if (value === "live" || value === "1") return "live";
  return "soon";
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "month" || value === "year";
}

/** "7" -> "7", "3.9" -> "3,90": Brazilian decimal comma for prices shown in reais. */
export function formatBrl(value: string | number): string {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return String(value);
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(".", ",");
}

/** The second, higher plan ("Creator") is hidden unless NEXT_PUBLIC_SCALE_PLAN_ENABLED=true. */
export function scalePlanEnabled(): boolean {
  return process.env.NEXT_PUBLIC_SCALE_PLAN_ENABLED?.trim().toLowerCase() === "true";
}

export function getPublicBillingPlans(): PublicBillingPlan[] {
  const proPriceMonthly = process.env.NEXT_PUBLIC_PRO_PRICE_MONTHLY || "7";
  const proPriceAnnual = process.env.NEXT_PUBLIC_PRO_PRICE_ANNUAL || "47";
  const scalePriceMonthly = process.env.NEXT_PUBLIC_SCALE_PRICE_MONTHLY || "24.99";
  const scalePriceAnnual = process.env.NEXT_PUBLIC_SCALE_PRICE_ANNUAL || "249.90";
  // Mirrors the backend's PRO_/SCALE_PLAN_MINUTE_LIMIT (docker-compose.prod.yml).
  const proMinutes = parseInt(process.env.NEXT_PUBLIC_PRO_PLAN_MINUTE_LIMIT || "120", 10);
  const scaleMinutes = parseInt(process.env.NEXT_PUBLIC_SCALE_PLAN_MINUTE_LIMIT || "1500", 10);
  // Mirrors the backend's MAX_VIDEO_DURATION.
  const proYoutubeMinutes = parseInt(process.env.NEXT_PUBLIC_PRO_YOUTUBE_MAX_MINUTES || "60", 10);
  const scaleYoutubeMinutes = parseInt(process.env.NEXT_PUBLIC_SCALE_YOUTUBE_MAX_MINUTES || "180", 10);

  const plans: PublicBillingPlan[] = [
    {
      id: "pro",
      name: "Pro",
      priceMonthly: proPriceMonthly,
      priceAnnual: proPriceAnnual,
      minuteLimit: proMinutes,
      resolution: "720p",
      scheduling: false,
      youtubeMaxMinutes: proYoutubeMinutes,
      description: "Cortes verticais com legenda para quem posta toda semana.",
      highlights: [
        `${formatMinutes(proMinutes)} de vídeo por mês`,
        "Cortes 9:16 em 720p com legenda automática",
        `Vídeos de até ${formatMinutes(proYoutubeMinutes)}`,
        "Sem marca d'água · cancele quando quiser",
      ],
      cta: "Assinar o Pro",
      highlighted: true,
    },
    {
      id: "scale",
      name: "Creator",
      priceMonthly: scalePriceMonthly,
      priceAnnual: scalePriceAnnual,
      minuteLimit: scaleMinutes,
      resolution: "1080p",
      scheduling: true,
      youtubeMaxMinutes: scaleYoutubeMinutes,
      description: "Para quem publica todos os dias.",
      highlights: [
        `${formatMinutes(scaleMinutes)} de vídeo por mês`,
        "Cortes em Full HD 1080p",
        `Vídeos de até ${formatMinutes(scaleYoutubeMinutes)}`,
        "Processamento prioritário",
      ],
      cta: "Assinar o Creator",
      highlighted: false,
    },
  ];
  return scalePlanEnabled() ? plans : plans.filter((plan) => plan.id === "pro");
}

/** The plan's price for one billing interval, as shown next to "/mo" or "/yr". */
export function planPrice(plan: PublicBillingPlan, interval: BillingInterval): string {
  return interval === "year" ? plan.priceAnnual : plan.priceMonthly;
}

/** What twelve months would cost at the monthly price, e.g. "119.88"; shown struck through next to the annual price. */
export function annualFullPrice(plan: PublicBillingPlan): string {
  const full = Number(plan.priceMonthly) * 12;
  return Number.isInteger(full) ? String(full) : full.toFixed(2);
}

/** What an annual plan works out to per month, e.g. "3,92" (shown in reais). */
export function annualMonthlyEquivalent(plan: PublicBillingPlan): string {
  return formatBrl(Number(plan.priceAnnual) / 12);
}

/** How many months of the monthly price an annual plan saves, e.g. 2. */
export function annualMonthsFree(plan: PublicBillingPlan): number {
  const monthly = Number(plan.priceMonthly);
  if (!monthly) return 0;
  return Math.round(12 - Number(plan.priceAnnual) / monthly);
}

export function formatMinutes(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? "hora" : "horas"}`;
  }
  return `${minutes} minutos`;
}

/** The plan one step above `plan`, or null when there is nothing to upgrade to. */
export function getNextBillingPlan(plan: string | null | undefined): PublicBillingPlan | null {
  const plans = getPublicBillingPlans();
  if (plan === "scale" || plan === "self_host") return null;
  if (plan === "pro") return plans.find((candidate) => candidate.id === "scale") ?? null; // null when Creator is hidden
  return plans.find((candidate) => candidate.id === "pro") ?? null;
}
