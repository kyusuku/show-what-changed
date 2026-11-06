export const CLOCK_LIMIT_MS = 40;
export const CLOCK_NUMERIC_ALLOWANCE_MS = 0.01;
export const CLOCK_PAIR_ALLOWANCE_MS = 2 * CLOCK_NUMERIC_ALLOWANCE_MS;
export const CLOCK_MAGNITUDE_MS = 2 ** 40;
export type ClockSample = { sourceSeconds: number; hostBeforeMs: number; hostAfterMs: number };
export type EndpointClock = {
  rate: 1;
  offsetMs: number;
  errorBoundMs: number;
  samples: ClockSample[];
  proof: {
    kind: 'monotone-endpoints';
    anchorIndex: number;
    finalIndex: number | null;
    numericAllowanceMs: typeof CLOCK_NUMERIC_ALLOWANCE_MS;
  };
};
export function clockNumber(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= CLOCK_MAGNITUDE_MS;
}
export function sampleBounds(sample: ClockSample): { lower: number; upper: number } {
  const sourceMs = sample.sourceSeconds * 1000;
  const lower = sample.hostBeforeMs - sourceMs;
  const upper = sample.hostAfterMs - sourceMs;
  if (![sourceMs, sample.hostBeforeMs, sample.hostAfterMs, lower, upper,
      lower - CLOCK_PAIR_ALLOWANCE_MS, upper + CLOCK_PAIR_ALLOWANCE_MS].every(clockNumber) ||
      sourceMs < 0 || sample.hostBeforeMs < 0 || sample.hostAfterMs < sample.hostBeforeMs)
    throw new Error('Clock sample is outside the numeric domain');
  return { lower, upper };
}
export function startupAnchor(samples: readonly ClockSample[]): number {
  if (samples.length < 5) throw new Error('Five startup samples are required');
  let best = 0;
  for (let index = 1; index < 5; index++) {
    const candidate = samples[index]!;
    const previous = samples[best]!;
    if (candidate.hostAfterMs - candidate.hostBeforeMs <= previous.hostAfterMs - previous.hostBeforeMs) best = index;
  }
  return best;
}
export function sampleOffset(sample: ClockSample): number {
  const { lower, upper } = sampleBounds(sample);
  const offset = lower + (upper - lower) / 2;
  if (!clockNumber(offset)) throw new Error('Clock offset is outside the numeric domain');
  return offset;
}
export function endpointBound(clock: EndpointClock, index: number): number {
  const anchor = clock.samples[clock.proof.anchorIndex];
  const sample = clock.samples[index];
  if (!anchor || !sample || index < clock.proof.anchorIndex) throw new Error('Missing clock endpoint');
  const lower = sampleBounds(anchor).lower - CLOCK_PAIR_ALLOWANCE_MS;
  const upper = sampleBounds(sample).upper + CLOCK_PAIR_ALLOWANCE_MS;
  const below = clock.offsetMs - lower;
  const above = upper - clock.offsetMs;
  if (![lower, upper, below, above].every(clockNumber)) throw new Error('Clock endpoint is outside the numeric domain');
  return Math.max(Math.abs(below), Math.abs(above));
}
export function inspectEndpointClock(clock: EndpointClock): { latestBoundMs: number; acceptedBoundMs: number } {
  if (![clock.offsetMs, clock.offsetMs - CLOCK_LIMIT_MS, clock.offsetMs + CLOCK_LIMIT_MS].every(clockNumber) || !clockNumber(clock.errorBoundMs) || clock.errorBoundMs < 0 ||
      clock.samples.length > 128 || clock.proof.anchorIndex !== startupAnchor(clock.samples) ||
      clock.proof.numericAllowanceMs !== CLOCK_NUMERIC_ALLOWANCE_MS ||
      clock.offsetMs !== sampleOffset(clock.samples[clock.proof.anchorIndex]!))
    throw new Error('Invalid fixed clock anchor');
  let greatestLower = -Infinity;
  let acceptedBoundMs = 0;
  let latestBoundMs = Infinity;
  for (let index = 0; index < clock.samples.length; index++) {
    const sample = clock.samples[index]!;
    const previous = clock.samples[index - 1];
    const { lower, upper } = sampleBounds(sample);
    if (previous && (sample.hostBeforeMs < previous.hostAfterMs || sample.sourceSeconds <= previous.sourceSeconds))
      throw new Error('Clock samples must retain serialized order');
    if (greatestLower - CLOCK_PAIR_ALLOWANCE_MS > upper)
      throw new Error('Clock samples contradict the monotone domain');
    greatestLower = Math.max(greatestLower, lower);
    if (index < clock.proof.anchorIndex) continue;
    if (lower - CLOCK_PAIR_ALLOWANCE_MS > clock.offsetMs + CLOCK_LIMIT_MS ||
        upper + CLOCK_PAIR_ALLOWANCE_MS < clock.offsetMs - CLOCK_LIMIT_MS)
      throw new Error('Clock sample proves excessive mapping error');
    latestBoundMs = endpointBound(clock, index);
    if (latestBoundMs <= CLOCK_LIMIT_MS) acceptedBoundMs = Math.max(acceptedBoundMs, latestBoundMs);
  }
  return { latestBoundMs, acceptedBoundMs };
}
export function endpointFrameCovered(clock: EndpointClock, sourceSeconds: number): boolean {
  const anchor = clock.samples[clock.proof.anchorIndex];
  const final = clock.proof.finalIndex === null ? undefined : clock.samples[clock.proof.finalIndex];
  const sourceMs = sourceSeconds * 1000;
  const mapped = sourceMs + clock.offsetMs;
  return !!anchor && !!final && [sourceMs, mapped].every(clockNumber) &&
    sourceMs - anchor.sourceSeconds * 1000 > CLOCK_PAIR_ALLOWANCE_MS &&
    final.sourceSeconds * 1000 - sourceMs > CLOCK_PAIR_ALLOWANCE_MS;
}
export function eventErrorBound(mappedMs: number, eventHostMs: number, eventEndHostMs = eventHostMs): number {
  const before = eventHostMs - mappedMs;
  const after = eventEndHostMs - mappedMs;
  if (![mappedMs, eventHostMs, eventEndHostMs, before, after].every(clockNumber) ||
      eventHostMs < 0 || eventEndHostMs < eventHostMs)
    throw new Error('Action observation is outside the numeric domain');
  const bound = Math.max(Math.abs(before), Math.abs(after)) + CLOCK_PAIR_ALLOWANCE_MS;
  if (!clockNumber(bound)) throw new Error('Action bound is outside the numeric domain');
  return bound;
}
