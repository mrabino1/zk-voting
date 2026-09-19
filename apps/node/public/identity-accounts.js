/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Shared list/remove UI for a person's emails (one primary) and passkeys (cap 5).
 */

export function identityCapsOf(identity) {
  return {
    emails: Number(identity?.caps?.emails || 5),
    passkeys: Number(identity?.caps?.passkeys || 5),
    smartCards: Number(identity?.caps?.smartCards || 5),
    civicIds: Number(identity?.caps?.civicIds || 5),
  };
}

export function identityCapNote(identity) {
  const caps = identityCapsOf(identity);
  const emails = identity?.emailCount ?? identity?.emails?.length ?? 0;
  const passkeys = identity?.passkeyCount ?? identity?.passkeys?.length ?? 0;
  const cards = identity?.smartCardCount ?? (identity?.credentials || []).filter((c) => c.type === "smart_card").length;
  const civic = identity?.civicIdCount ?? (identity?.credentials || []).filter((c) => c.type === "civic_id").length;
  const eth = identity?.verifiedEthAddressCount ?? identity?.ethAccounts?.length ?? 0;
  return `Emails ${emails}/${caps.emails} (exactly one primary). Passkeys ${passkeys}/${caps.passkeys}. Smart cards ${cards}/${caps.smartCards}. Licenses/passports ${civic}/${caps.civicIds}. Verified Ethereum addresses ${eth} (one active).`;
}

export function atEmailCap(identity) {
  const caps = identityCapsOf(identity);
  const n = identity?.emailCount ?? identity?.emails?.length ?? 0;
  return n >= caps.emails;
}

export function atPasskeyCap(identity) {
  const caps = identityCapsOf(identity);
  const n = identity?.passkeyCount ?? identity?.passkeys?.length ?? 0;
  return n >= caps.passkeys;
}

export function renderEmailAccounts(h, identity, { busy, onPrimary, onRemove } = {}) {
  const emails = identity?.emails || [];
  const caps = identityCapsOf(identity);
  if (!emails.length) {
    return h("p", { class: "field-hint", text: `No email bound yet. You may add up to ${caps.emails}. The first becomes primary (MFA and SES default).` });
  }
  return h(
    "ul",
    { class: "identity-list", "aria-label": "Bound emails" },
    ...emails.map((row) =>
      h(
        "li",
        {},
        h("span", { class: "identity-list-main", text: row.email }),
        row.primary
          ? h("span", { class: "pill-primary", text: "Primary" })
          : h("span", { class: "field-hint", text: "Additional" }),
        row.primary
          ? null
          : h("button", {
              class: "btn btn-secondary",
              type: "button",
              disabled: Boolean(busy),
              text: "Make primary",
              onClick: () => onPrimary && onPrimary(row),
            }),
        h("button", {
          class: "btn btn-secondary",
          type: "button",
          disabled: Boolean(busy) || Boolean(row.primary),
          title: row.primary
            ? emails.length === 1
              ? "Add another email and make it primary before removing this one"
              : "Set another email as primary before removing this one"
            : "Remove this email",
          text: "Remove",
          onClick: () => onRemove && onRemove(row),
        })
      )
    )
  );
}

export function renderPasskeyAccounts(h, identity, { busy, onRemove } = {}) {
  const passkeys = identity?.passkeys || [];
  const caps = identityCapsOf(identity);
  if (!passkeys.length) {
    return h("p", { class: "field-hint", text: `No passkeys on this person yet. You may register up to ${caps.passkeys}. Any of them can sign in.` });
  }
  return h(
    "ul",
    { class: "identity-list", "aria-label": "Bound passkeys" },
    ...passkeys.map((row) =>
      h(
        "li",
        {},
        h("span", { class: "identity-list-main" }, h("code", { text: String(row.credentialId || row.id || "").slice(0, 18) + "…" })),
        h("span", { class: "field-hint", text: row.label || "Passkey" }),
        row.createdAt ? h("span", { class: "field-hint", text: String(row.createdAt).slice(0, 10) }) : null,
        h("button", {
          class: "btn btn-secondary",
          type: "button",
          disabled: Boolean(busy),
          text: "Remove",
          onClick: () => onRemove && onRemove(row),
        })
      )
    )
  );
}

export function renderEthAccounts(h, identity, { busy, onActive } = {}) {
  const accounts = identity?.ethAccounts || [];
  if (!accounts.length) {
    return h("p", {
      class: "field-hint",
      text: "No Ethereum address verified yet. Sign a challenge with each wallet. Several may be verified; exactly one is active.",
    });
  }
  return h(
    "ul",
    { class: "identity-list", "aria-label": "Verified Ethereum addresses" },
    ...accounts.map((row) =>
      h(
        "li",
        {},
        h("span", { class: "identity-list-main" }, h("code", { text: row.address })),
        row.active
          ? h("span", { class: "pill-primary", text: "Active" })
          : h("span", { class: "field-hint", text: row.verified ? "Verified" : "Unverified" }),
        h("span", { class: "field-hint", text: row.verifiedBy ? `via ${row.verifiedBy}` : row.source || "" }),
        row.active
          ? null
          : h("button", {
              class: "btn btn-secondary",
              type: "button",
              disabled: Boolean(busy) || !row.verified,
              text: "Make active",
              onClick: () => onActive && onActive(row),
            })
      )
    )
  );
}

function credentialTitle(row) {
  if (row.type === "civic_id") {
    return row.kind === "passport" ? "Passport" : "Driver’s license";
  }
  return row.label || "Smart card";
}

export function renderCivicCredentials(h, identity, { busy, officer, onRevoke, onReview } = {}) {
  const rows = identity?.credentials || [];
  const caps = identityCapsOf(identity);
  if (!rows.length) {
    return h("p", {
      class: "field-hint",
      text: `No smart card or driver’s license bound yet. You may bind up to ${caps.smartCards} cards and ${caps.civicIds} licenses or passports.`,
    });
  }
  return h(
    "ul",
    { class: "identity-list", "aria-label": "Smart cards and photo IDs" },
    ...rows.map((row) =>
      h(
        "li",
        {},
        h("span", { class: "identity-list-main", text: credentialTitle(row) }),
        h("span", { class: `pill-status status-${row.status || "active"}`, text: row.status || "active" }),
        row.issuer ? h("span", { class: "field-hint", text: `Issuer ${row.issuer}` }) : null,
        row.expiresAt
          ? h("span", { class: "field-hint", text: `Expires ${String(row.expiresAt).slice(0, 10)}` })
          : h("span", { class: "field-hint", text: "No expiry on file" }),
        officer && row.civicIdHash
          ? h("code", { text: String(row.civicIdHash).slice(0, 18) + "…" })
          : null,
        officer && row.fingerprint
          ? h("code", { text: String(row.fingerprint).slice(0, 18) + "…" })
          : null,
        officer
          ? h("button", {
              class: "btn btn-secondary",
              type: "button",
              disabled: Boolean(busy) || row.status === "revoked",
              text: "Revoke",
              onClick: () => onRevoke && onRevoke(row),
            })
          : null,
        officer && row.status !== "active"
          ? h("button", {
              class: "btn btn-secondary",
              type: "button",
              disabled: Boolean(busy),
              text: "Mark active",
              onClick: () => onReview && onReview(row, { status: "active" }),
            })
          : null
      )
    )
  );
}
