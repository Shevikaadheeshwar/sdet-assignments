/**
 * Time as an injected dependency rather than an ambient one, so tests never
 * depend on the wall clock (strategy §2, A2.2).
 */
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();
