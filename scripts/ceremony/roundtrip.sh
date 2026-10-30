#!/usr/bin/env bash
# Throwaway key generation, Shamir split/combine, and a full ceremony recovery.
# All files stay in a temporary directory and are removed on exit.

set -euo pipefail
umask 077

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$ROOT"

TMP=$(mktemp -d)
cleanup() {
    local f
    if [[ -n "${TMP:-}" && -d "$TMP" ]]; then
        while IFS= read -r -d '' f; do
            shred -u -- "$f" >/dev/null 2>&1 || rm -f -- "$f" || true
        done < <(find "$TMP" -type f -print0 2>/dev/null || true)
        rm -rf -- "$TMP" || true
    fi
}
trap cleanup EXIT

sha256_file() {
    openssl dgst -sha256 "$1" | awk 'NF{print $NF; exit}'
}

new_passphrase() {
    openssl rand -base64 48 | tr -d '\n'
}

extract_combined_secret() {
    local raw=$1 dest=$2 header="" blank=""
    {
        IFS= read -r header || true
        IFS= read -r blank || true
        cat
    } < "$raw" > "$dest"
    [[ "$header" == "SSSS Combined output" ]]
    [[ -z "$blank" ]]
}

direct_round_trip() {
    local pass plain sealed recovered share_dir i
    pass=$(new_passphrase)
    printf '%s' "$pass" > "$TMP/direct-secret.txt"
    printf '%s\n' "$pass" > "$TMP/direct-pass.line"
    openssl enc -aes-256-cbc -pbkdf2 -iter 10000 -a -salt \
        -in "$TMP/original.pem" -out "$TMP/direct.b64" -pass "file:$TMP/direct-pass.line"
    bash "$ROOT/scripts/ceremony/ssss.sh" split -t 3 -n 5 -f "$TMP/direct-secret.txt" > "$TMP/direct-shares.txt"
    share_dir="$TMP/direct-shares"
    mkdir -p "$share_dir"
    i=0
    while IFS= read -r line || [[ -n "$line" ]]; do
        i=$((i + 1))
        printf '%s\n' "$line" > "$share_dir/share-$i.txt"
    done < "$TMP/direct-shares.txt"
    [[ "$i" -eq 5 ]]
    bash "$ROOT/scripts/ceremony/ssss.sh" combine \
        "$share_dir/share-1.txt" "$share_dir/share-2.txt" "$share_dir/share-3.txt" \
        > "$TMP/direct-combined.raw"
    extract_combined_secret "$TMP/direct-combined.raw" "$TMP/direct-combined.txt"
    cmp -s "$TMP/direct-secret.txt" "$TMP/direct-combined.txt"
    printf '%s\n' "$(cat "$TMP/direct-combined.txt")" > "$TMP/direct-combined.line"
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 10000 -a \
        -in "$TMP/direct.b64" -out "$TMP/direct-recovered.pem" -pass "file:$TMP/direct-combined.line"
    cmp -s "$TMP/original.pem" "$TMP/direct-recovered.pem"
    plain=$(sha256_file "$TMP/original.pem")
    recovered=$(sha256_file "$TMP/direct-recovered.pem")
    [[ "$plain" == "$recovered" ]]
    printf 'direct-split-round-trip: ok\n'
}

ceremony_round_trip() {
    local i pass dir fp before after subset_a subset_b
    : > "$TMP/guardians.txt"
    for i in 1 2 3 4 5; do
        pass=$(new_passphrase)
        printf '%s\n' "$pass" >> "$TMP/guardians.txt"
    done
    new_passphrase > "$TMP/key-passphrase.txt"
    printf '\n' >> "$TMP/key-passphrase.txt"
    before=$(sha256_file "$TMP/original.pem")
    bash "$ROOT/scripts/ceremony/guardian_key_ceremony.sh" --noninteractive \
        --name "ROUNDTRIP" \
        --out "$TMP/out" \
        --threshold 3 \
        --shares 5 \
        --import "$TMP/original.pem" \
        --key-passphrase-file "$TMP/key-passphrase.txt" \
        --guardian-passphrase-file "$TMP/guardians.txt" \
        > "$TMP/ceremony.stdout"
    after=$(sha256_file "$TMP/original.pem")
    [[ "$before" == "$after" ]]
    dir=$(sed -n 's/^ceremony_dir=//p' "$TMP/ceremony.stdout")
    fp=$(sed -n 's/^fingerprint_sha256=//p' "$TMP/ceremony.stdout")
    if [[ ! -d "$dir" ]]; then
        echo "ceremony directory was not created" >&2
        exit 1
    fi
    if [[ ! "$fp" =~ ^[0-9a-f]{64}$ ]]; then
        echo "fingerprint was not printed" >&2
        exit 1
    fi
    check_text() {
        if ! grep -F -q -e "$2" -- "$1"; then
            printf 'missing expected text in %s\n' "$1" >&2
            exit 1
        fi
    }
    check_text "$dir/public/fingerprint.txt" "$fp"
    check_text "$dir/metadata.txt" "$fp"
    check_text "$dir/DISTRIBUTION.txt" "One sealed share per guardian."
    check_text "$dir/DISTRIBUTION.txt" "Never email or message a plaintext share."
    check_text "$dir/DISTRIBUTION.txt" "It is not wired into contracts or the application."
    check_text "$dir/RECOVERY.txt" "Recover only on an offline machine."
    check_text "$dir/RECOVERY.txt" "scripts/ceremony/ssss.sh combine"
    if grep -R -F -q -e "BEGIN PRIVATE KEY" -e "BEGIN RSA PRIVATE KEY" "$dir"; then
        echo "ceremony directory contains a private key" >&2
        exit 1
    fi
    # The key passphrase must not appear outside sealed ciphertext.
    # Communication sheets hold guardian passphrases, not this one.
    if grep -R -F -q --exclude-dir=secured -e "$(tr -d '\n' < "$TMP/key-passphrase.txt")" "$dir"; then
        echo "key passphrase leaked into a ceremony file" >&2
        exit 1
    fi
    derived=$(openssl pkey -in "$TMP/original.pem" -pubout -outform DER | openssl dgst -sha256 | awk 'NF{print $NF; exit}')
    [[ "$derived" == "$fp" ]]

    bash "$ROOT/scripts/ceremony/guardian_key_ceremony.sh" recover \
        --dir "$dir" \
        --out "$TMP/recovered-a.pem" \
        --guardians ALFA,BRAVO,CHARLIE \
        > "$TMP/recover-a.stdout"
    bash "$ROOT/scripts/ceremony/guardian_key_ceremony.sh" recover \
        --dir "$dir" \
        --out "$TMP/recovered-b.pem" \
        --guardians CHARLIE,DELTA,ECHO \
        > "$TMP/recover-b.stdout"
    cmp -s "$TMP/original.pem" "$TMP/recovered-a.pem"
    cmp -s "$TMP/original.pem" "$TMP/recovered-b.pem"
    subset_a=$(sha256_file "$TMP/recovered-a.pem")
    subset_b=$(sha256_file "$TMP/recovered-b.pem")
    [[ "$subset_a" == "$before" && "$subset_b" == "$before" ]]
    grep -F -q "fingerprint_match=yes" "$TMP/recover-a.stdout"
    grep -F -q "fingerprint_match=yes" "$TMP/recover-b.stdout"

    if bash "$ROOT/scripts/ceremony/guardian_key_ceremony.sh" recover \
        --dir "$dir" \
        --out "$TMP/should-not.pem" \
        --guardians ALFA,BRAVO \
        > "$TMP/recover-low.stdout" 2> "$TMP/recover-low.stderr"; then
        echo "below-threshold recover should have failed" >&2
        exit 1
    fi
    if [[ -e "$TMP/should-not.pem" ]]; then
        echo "below-threshold recover wrote a private key" >&2
        exit 1
    fi

    printf 'ceremony-round-trip: ok\n'
    printf 'private-key-sha256: %s\n' "$before"
    printf 'fingerprint-sha256: %s\n' "$fp"
    printf 'subset-a: ok\n'
    printf 'subset-b: ok\n'
    printf 'below-threshold: rejected\n'
}

openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$TMP/original.pem" >/dev/null 2>&1
chmod 400 "$TMP/original.pem"
direct_round_trip
ceremony_round_trip
printf 'round-trip: ok\n'
