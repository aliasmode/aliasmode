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
      aria-label="Buy static residential proxies from NobleProxy at the AliasMode user price (opens externally)"
    >
      <span className="proxy-referral-icon"><CartIcon /></span>
      <span className="proxy-referral-text">
        <strong>
          {replacement ? "Buy Replacement Proxy" : "Buy Static Residential Proxy"}
          <span className="proxy-referral-tag">AliasMode price</span>
        </strong>
        <small>Only AliasMode users pay 40% less than NobleProxy's public price.</small>
      </span>
      <span className="proxy-referral-go" aria-hidden="true">↗</span>
    </a>
  );
}
