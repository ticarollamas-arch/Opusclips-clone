export const SITE_NAME = "Cortador 9:16";
/** Who operates the hosted service. Configure with NEXT_PUBLIC_COMPANY_NAME. */
export const COMPANY_NAME = process.env.NEXT_PUBLIC_COMPANY_NAME || "CyberHuntLab";
export const COMPANY_REGISTRATION_NUMBER = process.env.NEXT_PUBLIC_COMPANY_REGISTRATION_NUMBER || "";
export const COMPANY_REGISTERED_ADDRESS = process.env.NEXT_PUBLIC_COMPANY_ADDRESS || "Nova Lima, MG, Brasil";
export const DEFAULT_SITE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3107";
export const HOSTED_APP_URL = DEFAULT_SITE_URL;
/**
 * Public source code of this modified version. The AGPL-3.0 (section 13)
 * requires offering it to everyone who uses the service over the network.
 */
export const GITHUB_URL =
  process.env.NEXT_PUBLIC_SOURCE_CODE_URL || "https://github.com/ticarollamas-arch/Opusclips-clone";
/** The upstream project this service is based on (credit kept as the license requires). */
export const UPSTREAM_PROJECT_URL = "https://github.com/FujiwaraChoki/supoclip";
/** No iOS app for this service; kept empty so links and banners stay hidden. */
export const APP_STORE_ID = "";
export const APP_STORE_URL = "";
export const PRODUCT_HUNT_URL = "";
export const PRODUCT_HUNT_BADGE_URL = "";

/** Opens the App Store's offer-code redemption for a creator's custom code (the "Creator offer"). */
export function appStoreRedeemUrl(code: string) {
  return `https://apps.apple.com/redeem?ctx=offercodes&id=${APP_STORE_ID}&code=${encodeURIComponent(code.toUpperCase())}`;
}

export function getSiteUrl() {
  try {
    return new URL(process.env.NEXT_PUBLIC_APP_URL || DEFAULT_SITE_URL).origin;
  } catch {
    return "http://localhost:3107";
  }
}
