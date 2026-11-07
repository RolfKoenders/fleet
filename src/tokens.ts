/**
 * The one place a size in characters becomes tokens: characters divided by four, a rough guide to the context
 * something costs, not a count from any tokenizer. Show the result with `formatTokens`, which puts a `~` in front.
 */
export const estimateTokens = (characters: number): number => Math.ceil(characters / 4);

/** An estimate for people: `~850`, `~28.4k`. Callers add the word `tokens`. */
export const formatTokens = (tokens: number): string => (tokens < 1000 ? `~${tokens}` : `~${(tokens / 1000).toFixed(1)}k`);
