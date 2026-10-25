// NOT FOR PROFIT — civic public good, not a commercial product.
// Mirrors contracts/src/ReasonCodes.sol at the repo root (uint16 catalog).

export const REASON_CODES = [
  { code: 1, name: 'NOT_OF_AGE' },
  { code: 2, name: 'NOT_RESIDENT' },
  { code: 3, name: 'NOT_CITIZEN_OR_MEMBER' },
  { code: 4, name: 'DUPLICATE_IDENTITY' },
  { code: 5, name: 'DECEASED' },
  { code: 6, name: 'MOVED_OUT' },
  { code: 7, name: 'DISTRICT_MISMATCH' },
  { code: 8, name: 'ALREADY_VOTED' },
  { code: 9, name: 'COURT_ORDER' },
  { code: 10, name: 'INELIGIBLE_STATUS' },
  { code: 11, name: 'FRAUD_HOLD' },
  { code: 12, name: 'EXPIRED_OR_SUSPENDED' },
  { code: 13, name: 'SANCTION_OR_PROHIBITION' },
  { code: 14, name: 'OTHER' },
];

export const MAX_CODE = 14;

export function isValidReasonCode(code) {
  const n = Number(code);
  return Number.isInteger(n) && n >= 1 && n <= MAX_CODE;
}

export function reasonName(code) {
  return REASON_CODES.find((r) => r.code === Number(code))?.name || null;
}
