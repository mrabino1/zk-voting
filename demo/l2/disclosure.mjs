// NOT FOR PROFIT — civic public good, not a commercial product.
// Hourly public disclosure for the sequencer. The timing rules live in the
// Node module so the API and the chain seal the same hours.

export {
  DEFAULT_DISCLOSURE_INTERVAL_SECONDS,
  DEFAULT_DISCLOSURE_DELAY_SECONDS,
  DEFAULT_RESULTS_MIN_VOTES,
  DEFAULT_DISCLOSURE_MIN_BLOCK_VOTES,
  resolveDisclosureIntervalSeconds,
  resolveDisclosureDelaySeconds,
  resolveResultsMinVotes,
  resolveDisclosureMinBlockVotes,
  disclosureSettings,
  publishedThrough,
  nextPublishAt,
  lastClosedHourAt,
  lastClosedHourStart,
  secondsUntilNext,
  formatCountdown,
  isDisclosed,
  hourBucket,
  publicDisclosureView,
  withDisclosedCount,
  resultsGateOpen,
  planPublicBlocks,
  selectPublicVotes,
} from '../apps/node/src/disclosure.mjs';

export function isHeldVoteType(type) {
  const name = String(type || '').toLowerCase();
  return name === 'vote' || name === 'poll_vote';
}
