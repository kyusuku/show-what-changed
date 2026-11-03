'use client';

import { useEffect, useRef, useState } from 'react';

export default function Readiness() {
  const [ready, setReady] = useState(false);
  const [date, setDate] = useState('Waiting for browser Date');
  const [frames, setFrames] = useState(false);
  const [value, setValue] = useState('');
  const [result, setResult] = useState('No search yet');
  const debounce = useRef(null);
  useEffect(() => {
    setDate(new Date().toISOString());
    const delayed = setTimeout(() => setReady(true), 250);
    const polling = setInterval(() => { fetch('/poll', { cache: 'no-store' }).catch(() => {}); }, 150);
    let secondFrame;
    const firstFrame = requestAnimationFrame(() => { secondFrame = requestAnimationFrame(() => setFrames(true)); });
    return () => { clearTimeout(delayed); clearInterval(polling); cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); clearTimeout(debounce.current); };
  }, []);

  function search(event) {
    const nextValue = event.target.value;
    setValue(nextValue);
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setResult(`Results for ${nextValue}`), 180);
  }

  return <main><p className="eyebrow">SYNTHETIC FIXTURE</p><h1>Readiness checks</h1><p role="status">{ready ? 'Data ready' : 'Loading synthetic data'}</p><p data-testid="fixed-date">{date}</p><p>{frames ? 'Animation frames live' : 'Waiting for animation frames'}</p><label htmlFor="plan-search">Search plans</label><input id="plan-search" value={value} onChange={search} /><p data-testid="search-result">{result}</p><a href="#details">Read details</a><section id="details"><h2>Readiness details</h2><p>Timers and animation frames must keep running with fixed Date.</p></section><aside className="secret" data-testid="synthetic-secret">SYNTHETIC_SECRET_DO_NOT_SHARE_9f8b7c6d</aside></main>;
}
