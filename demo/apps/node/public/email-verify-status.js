/**
 * NOT FOR PROFIT — ZK-Voting is a civic public good. Not a commercial product.
 * Email verification progress for /profile and /verify.
 * Green = verified. Red = unverified. Blue = a code was sent. Gold = still in progress.
 */

function norm(value) {
  return String(value || "").trim().toLowerCase();
}

/** A code is outstanding for binding an address, not a sign-in or PIN reset. */
export function isOutstandingEmailBind(challenge) {
  if (!challenge || !challenge.mfaRequired) return false;
  if (challenge.purpose === "pin-reset") return false;
  return Boolean(challenge.bindEmail);
}

export function emailVerificationStatus(identity, challenge) {
  const emails = (Array.isArray(identity?.emails) ? identity.emails : []).map((row) => ({
    id: row.id,
    email: row.email,
    primary: Boolean(row.primary),
    verified: Boolean(row.verified),
    verifiedAt: row.verifiedAt || null,
  }));
  const cap = Number(identity?.caps?.emails || 5);
  const outstanding = isOutstandingEmailBind(challenge);
  const pendingEmail = outstanding ? String(challenge.email || "").trim() : "";
  const pendingHint = outstanding ? String(challenge.emailHint || "").trim() : "";
  const alreadyBound = pendingEmail
    ? emails.some((row) => norm(row.email) === norm(pendingEmail))
    : false;
  const pending =
    outstanding && !alreadyBound
      ? {
          email: pendingEmail,
          emailHint: pendingHint,
          label: pendingEmail || pendingHint || "Pending address",
          codeSent: Boolean(challenge.codeSent) || Boolean(challenge.sentAt),
          sentAt: challenge.sentAt || null,
          expiresAt: challenge.expiresAt || null,
          needsEmail: Boolean(challenge.needsEmail),
        }
      : null;
  const openOnBound = outstanding && alreadyBound ? pendingEmail : "";

  const verifiedCount = emails.filter((row) => row.verified).length;
  const unverifiedStored = emails.filter((row) => !row.verified).length;
  const done = verifiedCount;
  const total = Math.max(1, done + unverifiedStored + (pending ? 1 : 0));
  const complete = done >= 1 && unverifiedStored === 0 && !outstanding;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    emails,
    cap,
    count: emails.length,
    atCap: emails.length >= cap,
    pending,
    openOnBound,
    outstanding,
    verifiedCount,
    done,
    total,
    pct,
    complete,
    tone: complete ? "complete" : "incomplete",
  };
}
