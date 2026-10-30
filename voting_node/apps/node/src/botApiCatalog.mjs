// NOT FOR PROFIT — civic public good, not a commercial product.
// Public bot catalog. This file is the source for GET /api, OpenAPI, and
// the LLM guide. Host-only administration routes are omitted on purpose.

import { brandName } from './branding.mjs';
import {
  API_KEY_DEFAULT_EXPIRATION,
  API_KEY_EXPIRATIONS,
  API_KEY_LEVELS,
  apiKeyLevelAllows,
} from './apiKeys.mjs';

export const BOT_DOC_BANNED = /platform_super_admin|super[\s_-]?admin/i;

function op(method, path, minLevel, fields) {
  return {
    method,
    path,
    minLevel,
    auth: Boolean(fields.auth),
    apiKey: fields.apiKey !== false,
    tag: fields.tag,
    summary: fields.summary,
    body: fields.body || '',
  };
}

const R = (path, fields) => op('GET', path, 'read', fields);
const V = (method, path, fields) => op(method, path, 'voter', fields);
const O = (method, path, fields) => op(method, path, 'officer', fields);

/** Non-mutating POST lookups a read-only key may call. */
function lookup(path, fields) {
  return op('POST', path, 'read', fields);
}

export const BOT_OPERATIONS = [
  R('/health', {
    tag: 'Status',
    summary: 'Process health, writer mode, chain id, and the hourly disclosure window.',
  }),
  R('/api/health', {
    tag: 'Status',
    summary: 'Same payload as GET /health.',
  }),
  R('/api/config', {
    tag: 'Status',
    summary:
      'Public Node configuration: voting hostname, chain, polls flag, identity caps, ballot types, receipt portal, and outcome portal.',
  }),
  R('/api', {
    tag: 'Documentation',
    summary:
      'Human documentation for this bot API. Send Accept: application/json, or ?format=json, for a machine index of the same routes.',
  }),
  R('/api/openapi.json', {
    tag: 'Documentation',
    summary: 'OpenAPI 3 description of every route listed here.',
  }),
  R('/api/llms.txt', {
    tag: 'Documentation',
    summary: 'Plain-text guide for a language model that will call this API.',
  }),
  R('/llms.txt', {
    tag: 'Documentation',
    summary: 'Same plain-text guide as GET /api/llms.txt.',
  }),

  V('POST', '/api/auth/passkey/register/begin', {
    tag: 'Sign-in',
    apiKey: false,
    summary:
      'Begin WebAuthn registration. An API key is refused here. A bot that already has a key does not need this ceremony.',
    body: 'handle, acceptedTerms',
  }),
  V('POST', '/api/auth/passkey/register/finish', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Finish WebAuthn registration and start email MFA when MFA is on.',
    body: 'WebAuthn credential, handle, email',
  }),
  V('POST', '/api/auth/passkey/login/begin', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Begin WebAuthn sign-in.',
    body: 'handle',
  }),
  V('POST', '/api/auth/passkey/login/finish', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Finish WebAuthn sign-in. Sets the session cookie after MFA.',
  }),
  V('POST', '/api/auth/web3/challenge', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Issue a sign-in challenge for a bound Ethereum address.',
    body: 'address',
  }),
  V('POST', '/api/auth/web3/login', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Submit the Ethereum signature for that challenge.',
    body: 'address, signature',
  }),
  V('POST', '/api/auth/email/start', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Start email sign-in. The one-time code arrives by transactional email.',
    body: 'email',
  }),
  V('POST', '/api/auth/smart-card/challenge', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Issue a smart-card sign-in challenge.',
  }),
  V('POST', '/api/auth/smart-card/login', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Complete smart-card sign-in.',
  }),
  V('POST', '/api/auth/civic-id/login', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Sign in with a hashed driver license or passport already bound to the person.',
  }),
  R('/api/auth/mfa/status', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Whether email MFA is required and whether SES is configured.',
  }),
  V('POST', '/api/auth/mfa/email', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Send or confirm the email factor during sign-in.',
  }),
  V('POST', '/api/auth/mfa/resend', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Resend the email one-time code.',
  }),
  V('POST', '/api/auth/mfa/verify', {
    tag: 'Sign-in',
    apiKey: false,
    summary: 'Verify the email one-time code and receive the session cookie.',
    body: 'code',
  }),
  V('POST', '/api/auth/logout', {
    tag: 'Sign-in',
    apiKey: false,
    auth: true,
    summary: 'End the browser session. An API key is refused here.',
  }),
  R('/api/auth/session', {
    tag: 'Sign-in',
    apiKey: false,
    auth: true,
    summary: 'Session cookie profile. Prefer GET /api/me with an API key.',
  }),

  R('/api/me', {
    tag: 'Profile',
    auth: true,
    summary:
      'The signed-in person: handle, role, identity summary, jurisdiction grants, and election registration status. Choice is never included.',
  }),
  R('/api/session', {
    tag: 'Profile',
    auth: true,
    summary: 'Same payload as GET /api/me.',
  }),
  V('PATCH', '/api/me/contact-email', {
    tag: 'Profile',
    auth: true,
    summary: 'Set or clear the contact email used for operator notices and the API-key alert.',
    body: 'contactEmail',
  }),
  R('/api/notifications', {
    tag: 'Profile',
    auth: true,
    summary: 'In-app notices for this person, newest first.',
  }),
  V('POST', '/api/notifications/:id/read', {
    tag: 'Profile',
    auth: true,
    summary: 'Mark one notice read.',
  }),
  R('/api/me/api-keys', {
    tag: 'API keys',
    auth: true,
    summary: 'List this account’s API keys. The secret is never returned. Revoked and expired keys stay in the list.',
  }),
  V('POST', '/api/me/api-keys', {
    tag: 'API keys',
    auth: true,
    apiKey: false,
    summary:
      'Create a key from a browser session on /me. Body fields: name, level (read, voter, or officer), expiresIn (7d, 30d, 90d, 180d, 365d, or never; default 30d). The secret is displayed once and cannot be retrieved again. The account email says a key was created and does not include the key.',
    body: 'name, level, expiresIn',
  }),
  V('DELETE', '/api/me/api-keys/:id', {
    tag: 'API keys',
    auth: true,
    summary: 'Revoke one of this account’s keys. Later calls with that secret are rejected.',
  }),
  V('POST', '/api/me/pin/keypad', {
    tag: 'Vote PIN',
    auth: true,
    summary: 'Issue the scrambled phone keypad used to enter the vote PIN.',
  }),
  V('POST', '/api/me/pin', {
    tag: 'Vote PIN',
    auth: true,
    summary: 'Set the 4–8 digit vote PIN.',
    body: 'pin',
  }),
  V('POST', '/api/me/pin/verify', {
    tag: 'Vote PIN',
    auth: true,
    summary: 'Verify the vote PIN and receive a short-lived pinToken for POST /api/elections/:id/vote.',
    body: 'pin',
  }),
  V('POST', '/api/me/pin/forgot', {
    tag: 'Vote PIN',
    auth: true,
    summary: 'Start a PIN reset for the signed-in person. Completes with email MFA.',
  }),
  V('POST', '/api/pin/forgot', {
    tag: 'Vote PIN',
    summary: 'Start a PIN reset from an email address. Sends a one-time code.',
    body: 'email',
  }),

  R('/api/identity/methods', {
    tag: 'Identity',
    summary: 'Identity method types a person may bind: email, passkey, Web3, smart card, driver license, passport.',
  }),
  R('/api/me/identity', {
    tag: 'Identity',
    auth: true,
    summary: 'Full identity view for the signed-in person: emails, passkeys, Ethereum addresses, civic credentials. No trapdoor and no PIN.',
  }),
  V('POST', '/api/identity/email/start', {
    tag: 'Identity',
    auth: true,
    summary: 'Start binding another email. One email is primary. Cap is 5.',
    body: 'email',
  }),
  V('POST', '/api/identity/web3/challenge', {
    tag: 'Identity',
    auth: true,
    summary: 'Challenge used to prove control of an Ethereum address before it is bound.',
    body: 'address',
  }),
  V('POST', '/api/identity/web3/verify', {
    tag: 'Identity',
    auth: true,
    summary: 'Bind a signature-verified Ethereum address. Only one address is active.',
    body: 'address, signature',
  }),
  V('POST', '/api/identity/smart-card/challenge', {
    tag: 'Identity',
    auth: true,
    summary: 'Challenge for binding a smart card.',
  }),
  V('POST', '/api/identity/smart-card/verify', {
    tag: 'Identity',
    auth: true,
    summary: 'Bind a smart card after the reader signs the challenge.',
  }),
  V('POST', '/api/identity/civic-id/verify', {
    tag: 'Identity',
    auth: true,
    summary: 'Bind a hashed driver license or passport. Images and full document numbers are not stored.',
  }),
  R('/api/me/emails', {
    tag: 'Identity',
    auth: true,
    summary: 'Email methods on this person.',
  }),
  V('POST', '/api/me/emails/primary', {
    tag: 'Identity',
    auth: true,
    summary: 'Choose the primary email. Exactly one email is primary.',
    body: 'id or email',
  }),
  V('DELETE', '/api/me/emails/:id', {
    tag: 'Identity',
    auth: true,
    summary: 'Remove one email method.',
  }),
  R('/api/me/passkeys', {
    tag: 'Identity',
    auth: true,
    summary: 'Passkeys bound to this person. Cap is 5.',
  }),
  V('DELETE', '/api/me/passkeys/:credentialId', {
    tag: 'Identity',
    auth: true,
    summary: 'Remove one passkey.',
  }),
  R('/api/me/eth-accounts', {
    tag: 'Identity',
    auth: true,
    summary: 'Verified Ethereum addresses and which one is active.',
  }),
  V('POST', '/api/me/eth-accounts', {
    tag: 'Identity',
    auth: true,
    summary: 'Submit the signature that binds an Ethereum address.',
    body: 'address, signature',
  }),
  V('POST', '/api/me/eth-accounts/active', {
    tag: 'Identity',
    auth: true,
    summary: 'Switch the single active Ethereum address.',
    body: 'address',
  }),
  R('/api/me/credentials', {
    tag: 'Identity',
    auth: true,
    summary: 'Smart cards and civic documents on this person.',
  }),
  O('POST', '/api/persons/:id/person-key', {
    tag: 'Identity',
    auth: true,
    summary: 'Registrar or clerk binds the person key for someone on their jurisdiction.',
  }),
  O('POST', '/api/persons/:id/methods', {
    tag: 'Identity',
    auth: true,
    summary: 'Officer adds an identity method to a person in their jurisdiction.',
  }),
  O('POST', '/api/persons/:id/eth-accounts', {
    tag: 'Identity',
    auth: true,
    summary: 'Officer records an Ethereum address on a person.',
    body: 'address',
  }),
  O('POST', '/api/persons/:id/eth-accounts/active', {
    tag: 'Identity',
    auth: true,
    summary: 'Officer switches the person’s active Ethereum address.',
    body: 'address',
  }),
  R('/api/persons/:id/identity', {
    tag: 'Identity',
    auth: true,
    summary: 'Registrar or clerk reads a person’s identity. A read-only key still needs that officer grant.',
  }),
  R('/api/office/credentials', {
    tag: 'Identity',
    auth: true,
    summary: 'Credentials waiting for civil-officer review.',
  }),
  O('POST', '/api/persons/:id/methods/:methodId/review', {
    tag: 'Identity',
    auth: true,
    summary: 'Approve or reject a smart card or civic document.',
    body: 'decision',
  }),
  O('POST', '/api/persons/:id/methods/:methodId/revoke', {
    tag: 'Identity',
    auth: true,
    summary: 'Revoke an expired card or license. Revocation is an event.',
  }),
  V('POST', '/api/integrations/credentials/status', {
    tag: 'Identity',
    apiKey: false,
    summary:
      'Credential-provider status callback. Uses the host provider secret header, not a personal API key. An API key is refused.',
  }),

  R('/api/elections', {
    tag: 'Elections',
    summary: 'Published elections. Counts follow the hourly disclosure rule.',
  }),
  O('POST', '/api/elections', {
    tag: 'Elections',
    auth: true,
    summary: 'Clerk creates an election in a jurisdiction they already serve.',
    body: 'title, jurisdictionId, startTime, cutoffTime, questions or ballot, electionType (0 poll, 1 vote; omitted means poll). electionType is immutable'
  }),
  O('POST', '/api/elections/:id/l2-open', {
    tag: 'Elections',
    auth: true,
    summary: 'Retry the sequencer open for one election. Idempotent: an open election is not opened again.',
  }),
  O('POST', '/api/elections/:id/chain-dead-letter/replay', {
    tag: 'Elections',
    auth: true,
    summary: 'Writer puts dead-lettered ballots back on the queue. The tally stays blocked while any remain. Optional body nullifier replays one row.',
    body: 'nullifier (optional)',
  }),
  O('POST', '/api/elections/:id/chain-dead-letter/exclude', {
    tag: 'Elections',
    auth: true,
    summary: 'Two different tally operators exclude a dead-lettered ballot after the deadline. A failed replay is required, except a supplementary hold, which can be excluded once the deadline has passed. The public audit log stores the count and the fixed reason code. The operator note stays private. Excluded ballots are not counted. The ballot is not deleted.',
    body: 'nullifier, reason',
  }),
  R('/api/elections/:id', {
    tag: 'Elections',
    summary: 'One election. When the caller is signed in, includes that person’s registration status. Choice is never included.',
  }),
  O('PATCH', '/api/elections/:id', {
    tag: 'Elections',
    auth: true,
    summary: 'Clerk edits the ballot before the roll is frozen.',
  }),
  O('PUT', '/api/elections/:id', {
    tag: 'Elections',
    auth: true,
    summary: 'Same edit as PATCH.',
  }),
  O('DELETE', '/api/elections/:id', {
    tag: 'Elections',
    auth: true,
    summary:
      'Clerk deletes an unused election. Body confirmTitle must match the saved title. Refused after freeze, registration, a ballot, or a factory transaction.',
    body: 'confirmTitle',
  }),
  R('/api/elections/:id/info', {
    tag: 'Elections',
    summary: 'Voter-facing questions, options, and supporting info.',
  }),
  R('/api/elections/:id/info/:questionId/:optionId', {
    tag: 'Elections',
    summary: 'One option and its external links.',
  }),
  R('/api/elections/:id/results', {
    tag: 'Elections',
    summary: 'Plurality or IRV results from the final tally. Empty of option counts before tally. Excluded ballots are not counted.',
  }),
  R('/api/elections/:id/summary', {
    tag: 'Elections',
    summary: 'Short public status: state, window, disclosed ballot count, links.',
  }),
  R('/api/elections/:id/ballots', {
    tag: 'Elections',
    summary: 'Disclosed ballot proofs for closed hours. Choice is not a field.',
  }),
  R('/api/elections/:id/artifacts', {
    tag: 'Elections',
    summary: 'Auditor pack: roots, counts, and public checks. No Node private database.',
  }),
  R('/api/elections/:id/l1', {
    tag: 'Elections',
    summary: 'L1 certification status for the tally, when a tally exists.',
  }),
  R('/api/elections/:id/tally-key', {
    tag: 'Elections',
    summary: 'Public tally ceremony view. The Node does not return a tally private key.',
  }),
  R('/api/elections/:id/staff', {
    tag: 'Elections',
    auth: true,
    summary: 'Election staff list. Caller must already be staff for that election.',
  }),
  O('POST', '/api/elections/:id/staff', {
    tag: 'Elections',
    auth: true,
    summary: 'Platform admin approves election staff.',
    body: 'handle or userId',
  }),
  O('DELETE', '/api/elections/:id/staff', {
    tag: 'Elections',
    auth: true,
    summary: 'Platform admin revokes election staff.',
    body: 'handle or userId',
  }),
  R('/api/elections/:id/registrations', {
    tag: 'Elections',
    auth: true,
    summary: 'Clerk, registrar, or disqualification officer lists the roll and requests.',
  }),
  R('/api/elections/:id/registration-requests', {
    tag: 'Elections',
    auth: true,
    summary: 'Clerk or registrar lists registration requests. Filter with ?status=.',
  }),
  V('POST', '/api/elections/:id/register', {
    tag: 'Elections',
    auth: true,
    summary: 'Voter asks to join the roll. A registrar or clerk of that jurisdiction must approve.',
    body: 'identityCommitment',
  }),
  O('POST', '/api/elections/:id/registration-requests/:requestId/approve', {
    tag: 'Elections',
    auth: true,
    summary: 'Clerk or registrar approves a registration request and inserts the commitment.',
  }),
  O('POST', '/api/elections/:id/registration-requests/:requestId/deny', {
    tag: 'Elections',
    auth: true,
    summary: 'Clerk or registrar declines a registration request.',
    body: 'reason',
  }),
  O('POST', '/api/elections/:id/freeze', {
    tag: 'Elections',
    auth: true,
    summary: 'Clerk freezes the eligible and disqualification roots.',
  }),
  V('POST', '/api/elections/:id/vote', {
    tag: 'Elections',
    summary:
      'Submit one ballot. A signed-in voter must send pinToken from POST /api/me/pin/verify. The body is a proof plus ciphertext. Choice is not a public field. The same nullifier is accepted once. A read-only key is refused.',
    body: 'proof, public inputs, ciphertext, pinToken, identityCommitment when an external party is active',
  }),
  O('POST', '/api/elections/:id/disqualify', {
    tag: 'Elections',
    auth: true,
    summary: 'Disqualification officer applies a coded reason and an evidence hash.',
    body: 'identityCommitment, reasonCode, evidenceHash',
  }),
  O('POST', '/api/elections/:id/disqualify/revoke', {
    tag: 'Elections',
    auth: true,
    summary: 'Disqualification officer records a revocation event.',
  }),
  O('POST', '/api/elections/:id/revoke', {
    tag: 'Elections',
    auth: true,
    summary: 'Same revocation event as /disqualify/revoke.',
  }),
  R('/api/elections/:id/envelopes', {
    tag: 'Elections',
    auth: true,
    summary: 'Tally operator reads encrypted envelopes after cutoff. Plaintext choice is not stored.',
  }),
  O('POST', '/api/elections/:id/guardians', {
    tag: 'Elections',
    auth: true,
    summary: 'Tally operator enrolls a guardian in the opens-ballots ceremony. Non-production cryptography.',
  }),
  O('POST', '/api/elections/:id/guardians/deals', {
    tag: 'Elections',
    auth: true,
    summary: 'Tally operator posts a guardian deal.',
  }),
  R('/api/elections/:id/guardians/:index/inbox', {
    tag: 'Elections',
    summary: 'Encrypted shares addressed to one enrolled guardian index.',
  }),
  O('POST', '/api/elections/:id/guardians/partials', {
    tag: 'Elections',
    auth: true,
    summary: 'Tally operator submits partial decryptions after cutoff.',
  }),
  O('POST', '/api/elections/:id/tally', {
    tag: 'Elections',
    auth: true,
    summary: 'Tally operator posts the tally after cutoff. Invented counts that do not match opened ballots are rejected for opens-ballots.',
  }),
  O('POST', '/api/elections/:id/certify-l1', {
    tag: 'Elections',
    auth: true,
    summary: 'Tally operator asks the Node to mirror the tally to L1 when L1 env is set.',
  }),

  R('/api/elections/:id/parties', {
    tag: 'External parties',
    summary: 'External eligibility parties for an election. Endpoint URLs are included only for staff.',
  }),
  O('POST', '/api/elections/:id/parties', {
    tag: 'External parties',
    auth: true,
    summary: 'Election staff registers an external eligibility party.',
    body: 'name, mode, operatorHandle',
  }),
  O('POST', '/api/elections/:id/parties/check', {
    tag: 'External parties',
    auth: true,
    summary: 'Staff checks whether a commitment is cleared to cast.',
    body: 'identityCommitment',
  }),
  O('PATCH', '/api/elections/:id/parties/:partyId', {
    tag: 'External parties',
    auth: true,
    summary: 'Staff changes a party status.',
    body: 'status',
  }),
  R('/api/elections/:id/parties/:partyId/rejections', {
    tag: 'External parties',
    auth: true,
    summary: 'Staff lists party rejections.',
  }),
  O('POST', '/api/elections/:id/parties/:partyId/reject', {
    tag: 'External parties',
    auth: true,
    summary: 'Staff or the party operator records a rejection.',
    body: 'identityCommitment, reasonCode, evidenceHash',
  }),
  O('POST', '/api/elections/:id/parties/:partyId/clear', {
    tag: 'External parties',
    auth: true,
    summary: 'Staff or the party operator clears a rejection.',
    body: 'identityCommitment, evidenceHash',
  }),
  O('POST', '/api/elections/:id/parties/:partyId/attest', {
    tag: 'External parties',
    auth: true,
    summary: 'Staff or the party operator attests a commitment.',
    body: 'identityCommitment, expiresAt, evidenceHash',
  }),

  R('/api/jurisdictions', {
    tag: 'Jurisdictions',
    summary: 'Jurisdictions on this Node. Officer lists are included only for officers.',
  }),
  O('POST', '/api/jurisdictions', {
    tag: 'Jurisdictions',
    auth: true,
    summary: 'Platform admin creates a jurisdiction.',
    body: 'name, metadataURI. The Node assigns a UUID id; a caller cannot choose it.',
  }),
  R('/api/jurisdictions/:id', {
    tag: 'Jurisdictions',
    summary: 'One jurisdiction.',
  }),
  R('/api/jurisdictions/:id/roles', {
    tag: 'Jurisdictions',
    auth: true,
    summary: 'Officers granted on a jurisdiction. Caller must already be an officer.',
  }),
  O('POST', '/api/jurisdictions/:id/roles', {
    tag: 'Jurisdictions',
    auth: true,
    summary: 'Platform admin grants clerk, registrar, disqualification officer, tally operator, or election staff.',
    body: 'role, handle or userId',
  }),
  O('DELETE', '/api/jurisdictions/:id/roles', {
    tag: 'Jurisdictions',
    auth: true,
    summary: 'Platform admin revokes a jurisdiction grant.',
    body: 'role, handle or userId',
  }),
  O('POST', '/api/admin/roles', {
    tag: 'Jurisdictions',
    auth: true,
    summary: 'Same grant as POST /api/jurisdictions/:id/roles.',
    body: 'jurisdictionId, role, handle or userId',
  }),
  O('POST', '/api/admin/grant', {
    tag: 'Jurisdictions',
    auth: true,
    summary: 'Alias of POST /api/admin/roles.',
    body: 'jurisdictionId, role, handle or userId',
  }),
  R('/api/users', {
    tag: 'Jurisdictions',
    auth: true,
    summary: 'Platform admin lists accounts and their jurisdiction grants. A read-only key may list. It cannot change roles.',
  }),
  O('PATCH', '/api/users/:id', {
    tag: 'Jurisdictions',
    auth: true,
    summary:
      'Platform admin sets a role the account is already allowed to grant: voter, observer, clerk, registrar, disqualification_officer, tally_operator, or election_staff.',
    body: 'role',
  }),
  R('/api/reason-codes', {
    tag: 'Jurisdictions',
    summary: 'Public disqualification reason catalog.',
  }),

  R('/api/pages', {
    tag: 'Pages',
    summary: 'Published public pages and the shared-contract site view.',
  }),
  R('/api/pages/:slug', {
    tag: 'Pages',
    summary: 'One published page.',
  }),
  R('/api/site', {
    tag: 'Pages',
    summary: 'Public site record, including pinned contract addresses.',
  }),
  R('/api/office/site', {
    tag: 'Pages',
    auth: true,
    summary: 'Clerk reads the office site record.',
  }),
  O('PATCH', '/api/office/site', {
    tag: 'Pages',
    auth: true,
    summary: 'Clerk pins shared contract addresses. Environment pins win over the stored site.',
  }),
  R('/api/office/pages', {
    tag: 'Pages',
    auth: true,
    summary: 'Clerk lists CMS pages, including drafts they may edit.',
  }),
  O('POST', '/api/office/pages', {
    tag: 'Pages',
    auth: true,
    summary: 'Clerk creates a page.',
  }),
  R('/api/office/pages/:id', {
    tag: 'Pages',
    auth: true,
    summary: 'Clerk reads one CMS page.',
  }),
  O('PATCH', '/api/office/pages/:id', {
    tag: 'Pages',
    auth: true,
    summary: 'Clerk edits a CMS page.',
  }),
  O('DELETE', '/api/office/pages/:id', {
    tag: 'Pages',
    auth: true,
    summary: 'Clerk deletes a CMS page.',
  }),

  R('/api/terms', {
    tag: 'Terms',
    summary: 'Current Terms of Use metadata and whether the caller has accepted this PDF hash.',
  }),
  R('/api/terms.pdf', {
    tag: 'Terms',
    summary: 'Terms PDF bytes. SHA-256 is in the X-Pdf-SHA256 header.',
  }),
  R('/terms.pdf', {
    tag: 'Terms',
    summary: 'Same Terms PDF as GET /api/terms.pdf.',
  }),
  V('POST', '/api/terms/view', {
    tag: 'Terms',
    summary: 'Record that the signed-in person viewed the Terms.',
  }),
  V('POST', '/api/terms/accept', {
    tag: 'Terms',
    auth: true,
    summary: 'Accept the current Terms. Acceptance stores the SHA-256 of the PDF bytes.',
    body: 'acceptedTerms',
  }),

  R('/api/feedback', {
    tag: 'Feedback',
    summary: 'Feedback form limits, categories, and whether the operator inbox is configured.',
  }),
  V('POST', '/api/feedback', {
    tag: 'Feedback',
    summary:
      'Send one feedback message. This is also how a person contacts support. Rate-limited. A read-only key is refused because the call sends mail.',
    body: 'category, name, email, message, acceptedTerms',
  }),

  R('/api/receipts/metrics', {
    tag: 'Receipts',
    summary: 'Public receipt metrics and hourly turnout. No candidate and no option.',
  }),
  lookup('/api/receipts/verify', {
    tag: 'Receipts',
    summary: 'Check a hash-only receipt or its locked PDF. Returns whether the ballot counted. Never returns a choice.',
    body: 'proof or receipt text, or PDF bytes',
  }),
  V('POST', '/api/receipts/email', {
    tag: 'Receipts',
    auth: true,
    summary: 'Email the voter their hash-only receipt after the ballot is accepted.',
  }),
  V('POST', '/api/receipts/pdf', {
    tag: 'Receipts',
    auth: true,
    summary: 'Download the locked receipt PDF for a ballot this caller may access.',
  }),

  R('/api/outcomes', {
    tag: 'Outcomes',
    summary: 'Every election grouped before, during, and after voting. No unofficial option counts during the open window.',
  }),
  R('/api/outcomes/:id', {
    tag: 'Outcomes',
    summary: 'One election’s public outcome monitor.',
  }),
  R('/api/outcomes/reports', {
    tag: 'Outcomes',
    summary: 'Issued official outcome reports.',
  }),
  R('/api/outcomes/reports/:id', {
    tag: 'Outcomes',
    summary: 'One official outcome report record.',
  }),
  R('/api/outcomes/reports/:id/pdf', {
    tag: 'Outcomes',
    summary: 'Locked official outcome PDF.',
  }),
  lookup('/api/outcomes/verify', {
    tag: 'Outcomes',
    summary: 'Check an official outcome PDF was not modified.',
    body: 'pdf bytes or id',
  }),
  R('/api/me/outcome-subscriptions', {
    tag: 'Outcomes',
    auth: true,
    summary: 'Elections whose official PDF this person will be emailed. Subscription is opt-in; voting never subscribes anyone.',
  }),
  V('PUT', '/api/me/outcome-subscriptions/:electionId', {
    tag: 'Outcomes',
    auth: true,
    summary: 'Subscribe or confirm a subscription to an official outcome PDF.',
  }),
  V('POST', '/api/me/outcome-subscriptions', {
    tag: 'Outcomes',
    auth: true,
    summary: 'Subscribe the caller to an election’s official outcome PDF.',
    body: 'electionId',
  }),
  R('/api/admin/outcome-report-template', {
    tag: 'Outcomes',
    auth: true,
    summary: 'Platform admin reads the official outcome PDF template. QR and hash seals stay required.',
  }),
  O('PATCH', '/api/admin/outcome-report-template', {
    tag: 'Outcomes',
    auth: true,
    summary: 'Platform admin edits template copy. QR and hash seals cannot be removed.',
  }),
  O('POST', '/api/admin/outcome-report-template/preview', {
    tag: 'Outcomes',
    auth: true,
    summary: 'Platform admin previews the outcome PDF template.',
  }),

  R('/api/explorer/disclosure', {
    tag: 'Explorer',
    summary: 'Hourly disclosure window the explorer uses.',
  }),
  R('/api/explorer/blocks', {
    tag: 'Explorer',
    summary: 'Civic L2 blocks.',
  }),
  R('/api/explorer/blocks/:n', {
    tag: 'Explorer',
    summary: 'One civic L2 block.',
  }),
  R('/api/explorer/txs/:hash', {
    tag: 'Explorer',
    summary: 'One civic L2 transaction. Ballot plaintext is not a field.',
  }),
  R('/api/explorer/nullifiers/:value', {
    tag: 'Explorer',
    summary: 'Whether a nullifier was accepted. The nullifier does not reveal the choice or the person.',
  }),
  R('/api/explorer/search', {
    tag: 'Explorer',
    summary: 'Search blocks, transactions, and elections.',
  }),
  R('/api/explorer/elections/:id', {
    tag: 'Explorer',
    summary: 'Explorer view of one election.',
  }),
  O('POST', '/api/explorer/ingest', {
    tag: 'Explorer',
    summary:
      `Operator ingest of civic L2 events. Send the host ingest secret in X-ZK-Voting-Ingest-Secret. A personal API key does not replace that secret. Minimum key level when a key is also sent: officer.`,
  }),

  R('/api/polls', {
    tag: 'Polls',
    summary: 'Token polls when POLLS_ENABLED is on. Polls are signal, not binding elections. Omitted from the Node when the flag is off.',
  }),
  R('/api/polls/:id', {
    tag: 'Polls',
    summary: 'One token poll.',
  }),
  R('/api/polls/:id/weight', {
    tag: 'Polls',
    summary: 'Read-only token weight for an address. The Node does not move tokens.',
  }),
  R('/api/polls/:id/typed-data', {
    tag: 'Polls',
    summary: 'EIP-712 typed data a holder signs. Query: address, choices.',
  }),
  V('POST', '/api/polls/:id/ballots', {
    tag: 'Polls',
    summary: 'Submit a signed token-poll ballot. No account on this site is required. A read-only key is refused.',
  }),
  V('POST', '/api/polls/:id/tally', {
    tag: 'Polls',
    auth: true,
    summary: 'Any signed-in person may ask the Node to tally a closed token poll. Counts come from accepted ballots.',
  }),
  R('/api/polls/:id/results', {
    tag: 'Polls',
    summary: 'Token poll results after tally.',
  }),
  R('/api/polls/:id/artifacts', {
    tag: 'Polls',
    summary: 'Token poll auditor pack.',
  }),
  R('/api/polls/:id/ballots.json', {
    tag: 'Polls',
    summary: 'Disclosed token-poll ballots.',
  }),
  R('/api/polls/:id/outcome.pdf', {
    tag: 'Polls',
    summary: 'Token poll outcome PDF.',
  }),

  R('/api/mail/templates', {
    tag: 'Mail',
    auth: true,
    summary: 'Platform admin lists operator mail templates stored on the Node. Mail is never written to civic L2.',
  }),
  R('/api/mail/templates/:id', {
    tag: 'Mail',
    auth: true,
    summary: 'Platform admin previews one operator mail template, including api_key.created.',
  }),
  R('/api/mail/outbox', {
    tag: 'Mail',
    auth: true,
    summary: 'Platform admin lists queued operator mail. Bodies stay on the detail route.',
  }),
  R('/api/mail/outbox/:id', {
    tag: 'Mail',
    auth: true,
    summary: 'Platform admin reads one outbox message, including text and HTML.',
  }),
];

function specificity(path) {
  const segs = path.split('/').filter(Boolean);
  const statics = segs.filter((seg) => !seg.startsWith(':')).length;
  return statics * 100 + segs.length;
}

const COMPILED = BOT_OPERATIONS.map((entry) => ({
  ...entry,
  score: specificity(entry.path),
  re: new RegExp(
    `^${entry.path
      .split('/')
      .map((seg) => (seg.startsWith(':') ? '[^/]+' : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('/')}/?$`,
  ),
})).sort((a, b) => b.score - a.score);

export function matchBotOperation(method, path) {
  const verb = String(method || '').toUpperCase();
  const clean = String(path || '').split('?')[0];
  return COMPILED.find((entry) => entry.method === verb && entry.re.test(clean)) || null;
}

export function assertBotCopy(text, label = 'bot docs') {
  if (BOT_DOC_BANNED.test(String(text || ''))) {
    throw new Error(`${label} mentions host-only administration`);
  }
}

for (const entry of BOT_OPERATIONS) {
  assertBotCopy(`${entry.summary}\n${entry.body}\n${entry.path}`, entry.path);
}

export function botLevelsGuide() {
  return [
    {
      id: 'read',
      label: 'Read-only',
      summary:
        'GET and HEAD, plus receipt and outcome verification. Cannot create, vote, register, email, or change a profile.',
    },
    {
      id: 'voter',
      label: 'Voter',
      summary:
        'Read-only plus this person’s own actions: contact email, vote PIN, registration request, ballot submit, identity methods, notifications, feedback, and outcome subscriptions.',
    },
    {
      id: 'officer',
      label: 'Officer',
      summary:
        'Voter plus the clerk, registrar, disqualification officer, tally operator, election staff, and platform admin routes this account is already allowed to call. A key does not add a role the person does not hold.',
    },
  ];
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function botDiscovery() {
  return {
    nfp: true,
    notForProfit: true,
    product: brandName(),
    app: 'zk-voting',
    documentation: '/api',
    openapi: '/api/openapi.json',
    llms: '/api/llms.txt',
    profile: '/me',
    support: '/feedback',
    authentication: {
      type: 'apiKey',
      headers: ['Authorization: Bearer rk_…', 'X-Api-Key: rk_…'],
      secretPrefix: 'rk_',
      create: 'Browser session on /me, or POST /api/me/api-keys with the session cookie. An API key cannot mint another key.',
      revoke: 'DELETE /api/me/api-keys/:id',
      secretShownOnce: true,
      emailTemplate: 'api_key.created',
    },
    levels: botLevelsGuide(),
    expirations: [...API_KEY_EXPIRATIONS],
    defaultExpiration: API_KEY_DEFAULT_EXPIRATION,
    defaultLevel: 'read',
    operations: BOT_OPERATIONS.map((entry) => ({
      method: entry.method,
      path: entry.path,
      minLevel: entry.minLevel,
      auth: entry.auth,
      apiKey: entry.apiKey,
      tag: entry.tag,
      summary: entry.summary,
      ...(entry.body ? { body: entry.body } : {}),
    })),
  };
}

function openApiPathSchema(path, name) {
  if (name === 'index') return { type: 'integer', minimum: 0 };
  if (name === 'questionId' || name === 'optionId' || name === 'slug') {
    return { type: 'string', description: 'Ballot label or public slug. Not a count of people.' };
  }
  if (path.startsWith('/api/mail/templates') && name === 'id') {
    return { type: 'string', description: 'Stable mail template name.' };
  }
  if (['id', 'partyId', 'requestId', 'methodId', 'electionId'].includes(name)) {
    return {
      type: 'string',
      format: 'uuid',
      description: 'UUID. Sequential integers are rejected so the path does not reveal how many records exist.',
    };
  }
  return { type: 'string' };
}

export function renderOpenApi() {
  const paths = {};
  for (const entry of BOT_OPERATIONS) {
    const item = paths[entry.path] || {};
    const parameters = [];
    for (const match of entry.path.matchAll(/:([A-Za-z0-9_]+)/g)) {
      parameters.push({
        name: match[1],
        in: 'path',
        required: true,
        schema: openApiPathSchema(entry.path, match[1]),
      });
    }
    const operation = {
      tags: [entry.tag],
      operationId: `${entry.method.toLowerCase()}_${entry.path.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
      summary: entry.summary,
      description: [
        entry.summary,
        entry.apiKey
          ? `Minimum API key level: ${entry.minLevel}. The account’s own role is still enforced.`
          : 'An API key is refused. Use a browser session or the sign-in flow.',
        entry.auth ? 'Caller must be authenticated.' : 'Authentication is optional unless noted.',
        entry.body ? `JSON body: ${entry.body}.` : '',
        'Errors are JSON: { "error": string, "nfp": true, "code"?: string }.',
      ]
        .filter(Boolean)
        .join(' '),
      'x-zk-voting-min-level': entry.minLevel,
      'x-zk-voting-api-key': entry.apiKey,
      responses: {
        200: { description: 'JSON body. nfp is true.' },
        201: { description: 'Created. JSON body. nfp is true.' },
        400: { description: 'Invalid request.' },
        401: { description: 'Missing, revoked, or expired credential.' },
        403: { description: 'The key level or the account role does not allow this call.' },
        404: { description: 'Not found.' },
      },
    };
    if (parameters.length) operation.parameters = parameters;
    if (entry.auth) {
      operation.security = [{ bearerAuth: [] }, { apiKeyHeader: [] }];
    }
    if (entry.body && entry.method !== 'GET') {
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              description: entry.body,
            },
          },
        },
      };
    }
    item[entry.method.toLowerCase()] = operation;
    paths[entry.path] = item;
  }
  return {
    openapi: '3.0.3',
    info: {
      title: `${brandName()} bot API`,
      version: '1.0.0',
      description:
        'NOT FOR PROFIT civic voting API for an external bot. Create a personal API key on /me. Send Authorization: Bearer rk_… or X-Api-Key. Levels: read, voter, officer. Expiration: 7d, 30d, 90d, 180d, 365d, or never (default 30d).',
      license: { name: 'AGPL-3.0-or-later' },
    },
    servers: [{ url: '/' }],
    tags: [...new Set(BOT_OPERATIONS.map((entry) => entry.tag))].map((name) => ({ name })),
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'rk_',
          description: 'Personal API key. Example: Authorization: Bearer rk_…',
        },
        apiKeyHeader: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Api-Key',
          description: 'Personal API key. Same secret as the bearer token.',
        },
      },
    },
    paths,
  };
}

function guideBody() {
  const lines = [];
  lines.push(`# ${brandName()} bot API`);
  lines.push('');
  lines.push('> NOT FOR PROFIT — civic public good. Not a commercial product. No token. No fees to voters.');
  lines.push('');
  lines.push(
    'A person signs in at `/me` and creates one or more API keys. An external bot reads this guide, `GET /api`, or `GET /api/openapi.json`, then calls the JSON API with a key. The key can use the routes below, up to its level and the roles that person already holds.',
  );
  lines.push('');
  lines.push('## Authentication');
  lines.push('');
  lines.push('Send either header:');
  lines.push('');
  lines.push('- `Authorization: Bearer rk_…`');
  lines.push('- `X-Api-Key: rk_…`');
  lines.push('');
  lines.push(
    'The secret is displayed once, in the create response, and cannot be shown again. Only a SHA-256 hash is stored. Revoked and expired keys receive `401`. A read-only key that calls a write receives `403` with `code` `API_KEY_SCOPE`.',
  );
  lines.push('');
  lines.push('Create and revoke from the profile while the browser session is signed in:');
  lines.push('');
  lines.push('```http');
  lines.push('POST /api/me/api-keys');
  lines.push('Content-Type: application/json');
  lines.push('Cookie: zk-voting.sid=…');
  lines.push('');
  lines.push('{ "name": "assistant", "level": "read", "expiresIn": "30d" }');
  lines.push('```');
  lines.push('');
  lines.push(
    '`level` is `read`, `voter`, or `officer`. `expiresIn` is `7d`, `30d`, `90d`, `180d`, `365d`, or `never`. The default expiration is `30d`. The default level is `read`. An API key cannot call `POST /api/me/api-keys`. A voter or officer key can revoke with `DELETE /api/me/api-keys/:id`.',
  );
  lines.push('');
  lines.push(
    'Creating a key sends the transactional template `api_key.created` to the account contact email, or the primary email when no contact email is set. The message says an API key was created. If the person did not create it, they contact support as soon as possible at `/feedback` and revoke the key on `/me`. The email does not contain the API key.',
  );
  lines.push('');
  lines.push('## Levels');
  lines.push('');
  for (const level of botLevelsGuide()) {
    lines.push(`- \`${level.id}\` (${level.label}). ${level.summary}`);
  }
  lines.push('');
  lines.push(
    'WebAuthn ceremonies need a WebAuthn client. Email and Ethereum sign-in can be completed by a bot that can read mail or sign. A personal API key is the path that skips that ceremony. Sign-in routes refuse an API key so a key cannot mint a browser session.',
  );
  lines.push('');
  lines.push('## Identifiers');
  lines.push('');
  lines.push(
    'Path parameters named `id`, `partyId`, `requestId`, `methodId`, and `electionId` are UUIDs. A sequential integer is rejected with `400` and `code` `ID_NOT_UUID`. Counting `1`, `2`, `3` would reveal how many people, contests, keys, or other records exist.',
  );
  lines.push('');
  lines.push(
    'The on-chain election id is a circuit uint256 inside the election object. It is not a path id. Human short links `/v/{code}` and `/e/{code}` redirect to `/vote/{uuid}` and are not accepted on `/api/elections/:id`.',
  );
  lines.push('');
  lines.push(
    'These path values are not record counts: `questionId` and `optionId` are ballot labels, `guardians/:index` is a ceremony slot, `/api/mail/templates/:id` is a template name, and `/api/pages/:slug` is a public page slug. A new jurisdiction is assigned a UUID.',
  );
  lines.push('');
  lines.push('## Calling the API');
  lines.push('');
  lines.push('```bash');
  lines.push('curl -sS \\');
  lines.push('  -H "Authorization: Bearer $ZK_VOTING_API_KEY" \\');
  lines.push('  -H "Accept: application/json" \\');
  lines.push('  "$ORIGIN/api/me"');
  lines.push('```');
  lines.push('');
  lines.push(
    'JSON errors look like `{ "error": "…", "nfp": true, "code": "…" }`. Successful JSON includes `"nfp": true`. Ballot choice is never a response field. Public turnout waits until the hour closes, the disclosure delay elapses, the results gate opens, and the block meets the floor.',
  );
  lines.push('');
  lines.push('Machine-readable copies:');
  lines.push('');
  lines.push('- `GET /api/openapi.json`');
  lines.push('- `GET /api/llms.txt`');
  lines.push('- `GET /api?format=json`');
  lines.push('- Repo guide: `docs/BOT_API.md`');
  lines.push('');
  lines.push('## Routes');
  lines.push('');
  let tag = '';
  for (const entry of BOT_OPERATIONS) {
    if (entry.tag !== tag) {
      tag = entry.tag;
      lines.push(`### ${tag}`);
      lines.push('');
    }
    const gate = entry.apiKey ? `key ${entry.minLevel}${entry.auth ? ', signed in' : ''}` : 'API key refused';
    const body = entry.body ? ` Body: ${entry.body}.` : '';
    lines.push(`- \`${entry.method} ${entry.path}\` (${gate}). ${entry.summary}${body}`);
  }
  lines.push('');
  lines.push('Routes that are not listed here reject a personal API key.');
  lines.push('');
  lines.push('Civic public good. Not a commercial product.');
  lines.push('');
  return lines.join('\n');
}

export function renderBotGuideMarkdown() {
  const text = guideBody();
  assertBotCopy(text, 'bot guide');
  return text;
}

export function renderRepoLlmsTxt() {
  const text = [
    `# ${brandName()} (zk-voting)`,
    '',
    '> NOT FOR PROFIT — civic public good. Not a commercial product.',
    '',
    `This repository is a zero-knowledge voting monorepo (product name ${brandName()}). Read it in this order when answering questions or calling the Node API.`,
    '',
    '## Bot API',
    '',
    'A running Node publishes the user API for external bots:',
    '',
    '- Documentation page: `/api`',
    '- OpenAPI: `/api/openapi.json`',
    '- Live LLM guide: `/api/llms.txt`',
    '- Repo guide: `docs/BOT_API.md`',
    '',
    'A person creates API keys on the signed-in profile `/me`.',
    '',
    '- Levels: `read` (read-only), `voter`, `officer`',
    '- Expiration: `7d`, `30d`, `90d`, `180d`, `365d`, `never` (default `30d`)',
    '- Header: `Authorization: Bearer rk_…` or `X-Api-Key: rk_…`',
    '- Many keys, each with its own level and expiration. Revoke with `DELETE /api/me/api-keys/:id`.',
    '- Creating a key emails template `api_key.created`. If the person did not create the key, they contact support as soon as possible.',
    '- Path ids (`id`, `partyId`, `requestId`, `methodId`, `electionId`) are UUIDs. Sequential integers are rejected (`ID_NOT_UUID`).',
    '',
    '## Product map',
    '',
    `- \`README.md\` — what ${brandName()} is for and how to run it`,
    '- `docs/ARCHITECTURE.md` — packages and interfaces',
    '- `docs/BOT_API.md` — every bot route',
    '- `docs/IDENTITY.md` — person, emails, passkeys, vote PIN',
    '- `apps/node` — Express API and vanilla JS pages',
    '- `smart-contracts/` — Solidity',
    '- `circuits/` — vote, tally, identity',
    '- `l2/` — civic sequencer, chain id 27427',
    '',
    'Ballot choice is never printed on a receipt or in an API response.',
    '',
  ].join('\n');
  assertBotCopy(text, 'llms.txt');
  return text;
}

export function renderBotHtml() {
  const discovery = botDiscovery();
  const groups = new Map();
  for (const entry of BOT_OPERATIONS) {
    if (!groups.has(entry.tag)) groups.set(entry.tag, []);
    groups.get(entry.tag).push(entry);
  }
  const toc = [...groups.keys()]
    .map(
      (tag) =>
        `<li><a href="#${escapeHtml(tag.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}">${escapeHtml(tag)}</a></li>`,
    )
    .join('');
  const sections = [...groups.entries()]
    .map(([tag, rows]) => {
      const id = tag.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const body = rows
        .map((entry) => {
          const gate = entry.apiKey
            ? escapeHtml(entry.minLevel)
            : 'session';
          return `<tr>
            <td><code>${escapeHtml(entry.method)}</code></td>
            <td><code>${escapeHtml(entry.path)}</code></td>
            <td>${gate}</td>
            <td>${entry.auth ? 'Yes' : 'No'}</td>
            <td>${escapeHtml(entry.summary)}${entry.body ? ` <span class="muted">Body: ${escapeHtml(entry.body)}.</span>` : ''}</td>
          </tr>`;
        })
        .join('');
      return `<section aria-labelledby="${id}-heading">
        <h2 id="${id}-heading">${escapeHtml(tag)}</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Method</th>
                <th scope="col">Path</th>
                <th scope="col">Minimum key</th>
                <th scope="col">Sign-in</th>
                <th scope="col">What a bot does</th>
              </tr>
            </thead>
            <tbody>${body}</tbody>
          </table>
        </div>
      </section>`;
    })
    .join('');
  const levels = botLevelsGuide()
    .map(
      (level) =>
        `<li><strong><code>${escapeHtml(level.id)}</code> — ${escapeHtml(level.label)}.</strong> ${escapeHtml(level.summary)}</li>`,
    )
    .join('');
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Bot API · ${escapeHtml(brandName())}</title>
  <meta name="description" content="How an external bot calls a ${escapeHtml(brandName())} user’s API with a personal key."/>
  <link rel="describedby" href="/api/openapi.json" type="application/json"/>
  <link rel="describedby" href="/api/llms.txt" type="text/plain"/>
  <style>
    :root { color-scheme: light dark; --ink:#19191c; --muted:#525355; --navy:#0063e6; --paper:#f5f5f5; --card:#ffffff; --line:#d6d6d7; --danger:#b91c1c; --gold:#3f5c0a; }
    @media (prefers-color-scheme: dark) {
      :root { --ink:#ebebeb; --muted:#adaeb0; --navy:#30b3ff; --paper:#0e1014; --card:#16181a; --line:#2b2c30; --danger:#ff8d82; --gold:#e0ed34; }
    }
    body { margin:0; font-family: "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif; line-height:1.5; color:var(--ink); background:var(--paper); }
    a { color:var(--navy); }
    .skip { position:absolute; left:-999px; top:0; background:#fff; padding:0.5rem 1rem; }
    .skip:focus { left:0; }
    header, main, footer { max-width:72rem; margin:0 auto; padding:1rem 1.25rem; }
    header { padding-top:1.5rem; }
    .kicker { font-size:0.75rem; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:var(--gold); margin:0; }
    h1 { font-size:1.5rem; font-weight:500; line-height:1.2; margin:0.2rem 0 0.6rem; text-decoration:underline; text-underline-offset:0.28rem; text-decoration-thickness:1px; text-decoration-color:color-mix(in srgb, var(--gold) 80%, transparent); }
    h2 { margin-top:2rem; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:0.92em; }
    pre { overflow:auto; background:var(--card); border:1px solid var(--line); border-radius:0.5rem; padding:0.8rem 1rem; }
    table { width:100%; border-collapse:collapse; background:var(--card); }
    th, td { text-align:start; vertical-align:top; padding:0.55rem 0.6rem; border-bottom:1px solid var(--line); }
    th { background:var(--paper); color:var(--muted); font-size:0.75rem; letter-spacing:0.04em; text-transform:uppercase; }
    .table-wrap { overflow-x:auto; }
    .muted { color:var(--muted); }
    .notice { background:var(--card); border:1px solid var(--line); border-radius:0.5rem; padding:0.8rem 1rem; }
    .danger { border-color:var(--danger); }
    nav ul { padding-left:1.2rem; }
    footer { color:var(--muted); font-size:0.92rem; }
  </style>
</head>
<body>
  <a class="skip" href="#main">Skip to main content</a>
  <header>
    <p class="kicker">NOT FOR PROFIT</p>
    <h1>${escapeHtml(brandName())} bot API</h1>
    <p>Civic public good. Not a commercial product. No token. No fees to voters.</p>
  </header>
  <main id="main">
    <p>An external bot uses a personal API key to call the same JSON API a signed-in person uses. Create the key on <a href="/me">your profile</a>. Read <a href="/api/openapi.json">OpenAPI</a> or <a href="/api/llms.txt">the plain-text guide</a> if you are a language model.</p>
    <section aria-labelledby="auth-heading">
      <h2 id="auth-heading">How a bot authenticates</h2>
      <p>Send one of these headers on every call:</p>
      <pre><code>Authorization: Bearer rk_…
X-Api-Key: rk_…</code></pre>
      <p>The secret starts with <code>rk_</code>. It is shown once, with a copy button, and cannot be shown again. The Node stores only a SHA-256 hash. The email does not contain the API key.</p>
      <h2 id="ids-heading">Identifiers</h2>
      <p>Path parameters named <code>id</code>, <code>partyId</code>, <code>requestId</code>, <code>methodId</code>, and <code>electionId</code> are UUIDs. A sequential integer is rejected with <code>400</code> and <code>ID_NOT_UUID</code>, so the path does not reveal how many people or records exist. The on-chain election id stays inside the election object for the circuit. Short links <code>/v/{code}</code> and <code>/e/{code}</code> redirect to <code>/vote/{uuid}</code> and are not accepted as <code>/api/elections/:id</code>.</p>
      <p>Ballot labels (<code>questionId</code>, <code>optionId</code>), guardian slots (<code>:index</code>), mail template names, and page slugs are not record counts. A new jurisdiction is assigned a UUID.</p>
      <pre><code>curl -sS \\
  -H "Authorization: Bearer $ZK_VOTING_API_KEY" \\
  -H "Accept: application/json" \\
  "$ORIGIN/api/me"</code></pre>
    </section>
    <section aria-labelledby="levels-heading">
      <h2 id="levels-heading">Authorization levels</h2>
      <p>One account can hold many keys. Each key has its own level. The level is a ceiling. The person’s existing role is still enforced.</p>
      <ul>${levels}</ul>
    </section>
    <section aria-labelledby="expiry-heading">
      <h2 id="expiry-heading">Expiration</h2>
      <p>Choose one expiration when you create the key. The default is <code>${escapeHtml(API_KEY_DEFAULT_EXPIRATION)}</code>.</p>
      <ul>
        ${API_KEY_EXPIRATIONS.map((item) => `<li><code>${escapeHtml(item)}</code></li>`).join('')}
      </ul>
      <p>After <code>expiresAt</code>, the key is rejected. <code>never</code> does not expire. Revoke a key from the profile, or with <code>DELETE /api/me/api-keys/:id</code> using a voter or officer key. Revocation takes effect immediately.</p>
    </section>
    <section aria-labelledby="create-heading">
      <h2 id="create-heading">Create a key</h2>
      <p>Sign in, open <a href="/me">/me</a>, and use API keys. The browser session calls:</p>
      <pre><code>POST /api/me/api-keys
Content-Type: application/json

{ "name": "assistant", "level": "read", "expiresIn": "30d" }</code></pre>
      <p><code>level</code> is ${API_KEY_LEVELS.map((level) => `<code>${escapeHtml(level)}</code>`).join(', ')}. An API key cannot create another key.</p>
      <div class="notice danger">
        <p>Creating a key sends the email template <code>api_key.created</code> to the account contact email (or the primary email). The message says an API key was created and does not include the key. If you did not create it, contact support as soon as possible at <a href="/feedback">/feedback</a>, then revoke the key.</p>
      </div>
    </section>
    <section aria-labelledby="errors-heading">
      <h2 id="errors-heading">Errors</h2>
      <p>JSON errors use <code>{ "error": "…", "nfp": true, "code": "…" }</code>. <code>401</code> means the key is missing, unknown, revoked, or expired. <code>403</code> with <code>API_KEY_SCOPE</code> means this key’s level cannot make that call. Ballot choice is never a response field.</p>
    </section>
    <section aria-labelledby="contents-heading">
      <h2 id="contents-heading">Route groups</h2>
      <nav aria-label="Route groups"><ul>${toc}</ul></nav>
      <p>A route that is not listed here rejects a personal API key. Sign-in routes are listed so a bot can complete email or Ethereum login, and they refuse an API key so a key cannot mint a browser session.</p>
    </section>
    ${sections}
  </main>
  <footer>
    <p>NOT FOR PROFIT — ${escapeHtml(brandName())} is a civic public good. Not a commercial product.</p>
    <p>Machine-readable: <a href="/api/openapi.json">/api/openapi.json</a> · <a href="/api/llms.txt">/api/llms.txt</a> · <a href="/api?format=json">/api?format=json</a></p>
  </footer>
</body>
</html>`;
  assertBotCopy(html, 'bot html');
  assertBotCopy(JSON.stringify(discovery), 'bot discovery');
  return html;
}

export function apiKeyAllowsOperation(level, operation) {
  if (!operation || operation.apiKey === false) return false;
  return apiKeyLevelAllows(level, operation.minLevel);
}
