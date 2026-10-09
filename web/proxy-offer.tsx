import { useTranslation } from "./i18n.tsx";

const PROXY_PROVIDER_URL = "https://nobleproxy.com/t/aliasmode";

/**
 * Offer link for one placement. `src` tells NobleProxy which button was
 * clicked, `qty` preselects a quantity, and `lang` lets it pick a translated page.
 */
export function proxyOfferUrl(placement: string, language: string, quantity = 0): string {
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
  placement: string;
  replacement?: boolean;
  missing?: number;
}) {
  const { t, language } = useTranslation();
  const title = missing === 1
    ? t("1 profile has no proxy")
    : missing > 1
      ? t("{count} profiles have no proxy", { count: missing })
      : replacement ? t("Buy Replacement Proxy") : t("Buy Static Residential Proxy");
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
