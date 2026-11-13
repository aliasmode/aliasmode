import { useEffect, useState } from "react";
import { useTranslation } from "./i18n.tsx";
import { fetchServices } from "./api.ts";
import type { ServiceListing } from "../services-directory.ts";

/** Category ids used by the admin list, in display order. Unknown ids still show, last, by their id. */
const CATEGORY_LABELS: Record<string, string> = {
  proxies: "Proxies",
  vps: "VPS",
  sms: "SMS",
  "cloud-phones": "Cloud phones",
  captcha: "Captcha",
  accounts: "Accounts",
  automation: "Automation",
};
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

/** Every Visit button goes through aliasmode.com, which counts the click and forwards to the partner. */
export const serviceVisitUrl = (slug: string) => `https://aliasmode.com/go/${slug}`;

export function serviceCategories(services: ServiceListing[]): string[] {
  const rank = (id: string) => CATEGORY_ORDER.includes(id) ? CATEGORY_ORDER.indexOf(id) : CATEGORY_ORDER.length;
  return [...new Set(services.map((service) => service.category))].sort((a, b) => rank(a) - rank(b));
}

export function ServicesPage({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const [services, setServices] = useState<ServiceListing[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [category, setCategory] = useState("all");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    if (!active) return;
    let current = true;
    fetchServices()
      .then((result) => { if (current) { setServices(result.services); setFailed(false); } })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [active]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(""), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const categories = serviceCategories(services ?? []);
  const selected = categories.includes(category) ? category : "all";
  const shown = (services ?? []).filter((service) => selected === "all" || service.category === selected);
  const label = (id: string) => CATEGORY_LABELS[id] ? t(CATEGORY_LABELS[id]) : id;
  const copy = async (slug: string, code: string) => {
    try { await navigator.clipboard.writeText(code); setCopied(slug); } catch {}
  };

  return <div className="workspace proxy-page services-page" hidden={!active}>
    <div className="tools-intro">
      <div><span className="tools-eyebrow">{t("SERVICES")}</span><h2>{t("Tools we recommend for multi-account work.")}</h2>
        <p>{t("Proxies, servers, phone numbers and more, with member deals for AliasMode users.")}</p></div>
    </div>
    {categories.length > 1 && <div className="service-filters" role="group" aria-label={t("Filter by category")}>
      {["all", ...categories].map((id) => <button key={id} type="button" className={selected === id ? "selected" : ""} aria-pressed={selected === id} onClick={() => setCategory(id)}>
        {id === "all" ? t("All") : label(id)}
      </button>)}
    </div>}
    {failed && !services && <div className="tools-alert" role="alert">{t("Services could not be loaded. Try again later.")}</div>}
    {!services && !failed && <div className="tools-empty compact"><p>{t("Loading services…")}</p></div>}
    {services && !shown.length && <div className="tools-empty compact"><p>{t("No services in this list yet.")}</p></div>}
    <div className="service-grid">
      {shown.map((service) => <article className="service-card" key={service.slug}>
        <div className="service-head">
          {service.logo
            ? <img className="service-logo" src={service.logo} alt="" />
            : <span className="service-logo service-monogram" aria-hidden="true">{service.name.slice(0, 1)}</span>}
          <div className="service-title"><h3>{service.name}</h3><span>{label(service.category)}</span></div>
          {service.badge && <span className={`service-badge ${service.badge}`}>{service.badge === "pick" ? t("Our pick") : t("Sponsored")}</span>}
        </div>
        <p className="service-description">{service.description}</p>
        {(service.deal || service.code) && <div className="service-deal">
          {service.deal && <span>{service.deal}</span>}
          {service.code && <button type="button" className="service-code" title={t("Copy code")} onClick={() => void copy(service.slug, service.code!)}>
            <code>{service.code}</code><span>{copied === service.slug ? t("Copied") : t("Copy")}</span>
          </button>}
        </div>}
        <a className="btn primary service-visit" href={serviceVisitUrl(service.slug)} target="_blank" rel="noreferrer"
          aria-label={t("Visit {name} (opens externally)", { name: service.name })}>{t("Visit")} ↗</a>
      </article>)}
    </div>
    <p className="tools-footnote">{t("Some links are affiliate links: AliasMode may earn a commission at no extra cost to you. Listings marked Sponsored are paid placements from Verified Sellers. Links open through aliasmode.com, which counts the click.")}</p>
  </div>;
}
