/**
 * NOT FOR PROFIT — Republic is a civic public good. Not a commercial product.
 * Shared list/remove UI for a person's emails (one primary) and passkeys (cap 5).
 */

export function identityCapsOf(identity) {
  return {
    emails: Number(identity?.caps?.emails || 5),
    passkeys: Number(identity?.caps?.passkeys || 5),
  };
}

export function identityCapNote(identity) {
  const caps = identityCapsOf(identity);
  const emails = identity?.emailCount ?? identity?.emails?.length ?? 0;
  const passkeys = identity?.passkeyCount ?? identity?.passkeys?.length ?? 0;
  return `Emails ${emails}/${caps.emails} (exactly one primary). Passkeys ${passkeys}/${caps.passkeys}.`;
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
