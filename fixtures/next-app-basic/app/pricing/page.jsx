'use client';

import { useEffect, useState } from 'react';
import revision from '../revision.js';

export default function Pricing() {
  const [hydrated, setHydrated] = useState(false);
  const [yearly, setYearly] = useState(false);
  useEffect(() => setHydrated(true), []);

  return <main className="pricing-page" style={{ '--accent': revision.accent, minHeight: revision.pageHeight }}>
    <header><p className="eyebrow">SYNTHETIC FIXTURE</p><h1>Pricing</h1><h2>{revision.headline}</h2><p>{revision.description}</p></header>
    <div className="billing">
      {revision.yearly ? <button role="switch" aria-label="Yearly" aria-checked={yearly} disabled={!hydrated} onClick={() => setYearly(!yearly)}>Yearly <span aria-hidden="true">{yearly ? '●' : '○'}</span></button> : <p>Monthly billing</p>}
      {yearly && <strong className="saving">Save 20%</strong>}
    </div>
    <article className="plan"><p className="eyebrow">PRO</p><h2>Make room for your next idea.</h2><p className="price">${yearly ? '16' : '20'}<small> / month</small></p><ul><li>Unlimited projects</li><li>Shared workspace</li><li>Priority support</li></ul><div className="cta"><button className="get-pro" onClick={() => {}}>Get Pro</button><span data-testid="hover-state" className="hover-state">Pro is ready for you</span></div></article>
    <aside className="secret" data-testid="synthetic-secret">SYNTHETIC_SECRET_DO_NOT_SHARE_9f8b7c6d</aside>
    {!revision.yearly && <button className="legacy">Legacy details</button>}
    <section id="details" className="details"><h2>Plan details</h2><p data-testid="page-end">All fixture data is disposable.</p></section>
  </main>;
}
