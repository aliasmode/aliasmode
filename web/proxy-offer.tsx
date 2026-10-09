export const PROXY_PROVIDER_URL = "https://nobleproxy.com/t/aliasmode";

export function CartIcon({ className }: { className?: string }) {
  return (
    <svg className={className ? `icon ${className}` : "icon"} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" />
      <path d="M2 3h3l2.6 12.2a1.5 1.5 0 001.5 1.2h8.5a1.5 1.5 0 001.5-1.2L20.5 7H6" />
    </svg>
  );
}

export function ProxyProviderOffer({ replacement = false }: { replacement?: boolean }) {
  return (
    <a
      className="proxy-referral"
      href={PROXY_PROVIDER_URL}
      target="_blank"
      rel="noreferrer"
      aria-label="Buy static residential proxies at NobleProxy, 40% off (opens externally)"
    >
      <CartIcon />
      <span>{replacement ? "Buy Replacement Proxy" : "Buy Static Residential Proxy"}</span>
      <span className="proxy-referral-off">40% OFF</span>
    </a>
  );
}
