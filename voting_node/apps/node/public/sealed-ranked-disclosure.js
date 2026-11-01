/**
 * NOT FOR PROFIT — civic public good, not a commercial product.
 * Single source for the sealed ranked-choice disclosure. The text lives in the
 * locale catalogs (`sealedRanked.disclosure`); the server, the back office and
 * the ballot all read it from there so the copies cannot drift.
 */

import en from "./locales/en.js";

export const SEALED_RANKED_DISCLOSURE_KEY = "sealedRanked.disclosure";

/** English text: used server-side (API errors, acknowledgment) and as the i18n fallback. */
export const SEALED_RANKED_DISCLOSURE = en.sealedRanked.disclosure;
