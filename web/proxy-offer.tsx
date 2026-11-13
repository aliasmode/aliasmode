import { createContext, useContext } from "react";
import { useTranslation } from "./i18n.tsx";

/**
 * The `src` slug of every place that sells proxies. Local mode sends it on the
 * NobleProxy link; Cloud mode records it with the in-app store events.
 */
export const PROXY_SRC = [
  "sidebar-cart", "profile-dialog", "profile-dialog-check-failed", "import-no-proxy",
  "proxies-no-proxy", "proxies-check", "proxies-check-failed",
  // In-app store only.
  "proxies-tab", "my-proxies-buy-more", "success-buy-more", "direct",
] as const;
export type ProxySrc = (typeof PROXY_SRC)[number];

/**
 * Set when AliasMode Cloud has the in-app proxy store. Offers then open the
 * store instead of the outside NobleProxy page; without it they stay links.
 */
export const ProxyStoreContext = createContext<((quantity: number, src: ProxySrc) => void) | null>(null);

const PROXY_PROVIDER_URL = "https://nobleproxy.com/t/aliasmode";

/**
 * Offer link for one placement. `src` tells NobleProxy which button was
 * clicked, `qty` preselects a quantity, and `lang` lets it pick a translated page.
 */
export function proxyOfferUrl(placement: ProxySrc, language: string, quantity = 0): string {
  const url = new URL(PROXY_PROVIDER_URL);
  url.searchParams.set("src", placement);
  if (quantity > 0) url.searchParams.set("qty", String(quantity));
  if (language !== "en-US") url.searchParams.set("lang", language);
  return url.toString();
}

export function CartIcon({ className }: { className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" />
      <path d="M2 3h3l2.6 12.2a1.5 1.5 0 001.5 1.2h8.5a1.5 1.5 0 001.5-1.2L20.5 7H6" />
    </svg>
  );
}

/**
 * `missing` is the number of profiles without a proxy. When it is set, the
 * card names that number and the link asks for the same quantity.
 */
export function ProxyProviderOffer({
  placement,
  replacement = false,
  missing = 0,
}: {
  placement: ProxySrc;
  replacement?: boolean;
  missing?: number;
}) {
  const { t, language } = useTranslation();
  const openStore = useContext(ProxyStoreContext);
  const title = missing === 1
    ? t("1 profile has no proxy")
    : missing > 1
      ? t("{count} profiles have no proxy", { count: missing })
      : replacement ? t("Buy Replacement Proxy") : t("Buy Static Residential Proxy");
  if (openStore) {
    return (
      <button type="button" className="proxy-referral" onClick={() => openStore(missing, placement)}>
        <span className="proxy-referral-icon"><CartIcon /></span>
        <span className="proxy-referral-text">
          <strong>{title}</strong>
          <small>{t("Buy static residential proxies in the app and give each profile its own IP.")}</small>
        </span>
        <span className="proxy-referral-go" aria-hidden="true">→</span>
      </button>
    );
  }
  return (
    <a
      className="proxy-referral"
      href={proxyOfferUrl(placement, language, missing)}
      target="_blank"
      rel="noreferrer"
      aria-label={t("Buy static residential proxies from NobleProxy at the AliasMode user price (opens externally)")}
    >
      <span className="proxy-referral-icon"><CartIcon /></span>
      <span className="proxy-referral-text">
        <strong>
          {title}
          <span className="proxy-referral-tag">{t("AliasMode price")}</span>
        </strong>
        <small>{missing > 0
          ? t("Get one static residential IP for each. Only AliasMode users pay 40% less than NobleProxy's public price.")
          : t("Only AliasMode users pay 40% less than NobleProxy's public price.")}</small>
      </span>
      <span className="proxy-referral-go" aria-hidden="true">↗</span>
    </a>
  );
}
