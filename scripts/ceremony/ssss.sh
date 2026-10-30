#!/usr/bin/env bash
# Shamir secret sharing for guardian key ceremony tooling.
#
# Share format (secrets.js compatible):
#   GF(256), reduction constant 29 (polynomial 0x11d), 8-bit shares.
#   UTF-8 text is encoded as UTF-16BE. A 1 bit is prefixed, then the bit
#   string is padded with zeros to a multiple of 1024 bits. Those bits are
#   split into bytes. A token is "8", two hex digits of the share id
#   (01 through ff), and the hex share data.
#
# A 4096-bit RSA PEM is text, so it can be one secret. Do not hex-encode
# or base64-encode it first. The 1024-bit pad is a minimum width, not a
# maximum, and the format does not reject a PEM of that size. This shell
# code loops once per byte per share, so a multi-kilobyte PEM is slow and
# the tokens are large. The guardian key ceremony does not put the PEM in
# the shares. It encrypts the PEM with a passphrase and splits that short
# passphrase. The encrypted PEM stays beside the shares. Both choices use
# this format.
#
# Requires bash, openssl, iconv, od, and tr.

SSSS_SH_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"

ssss_openssl_decrypt_command() {
    printf '%s\n' "openssl enc -d -aes-256-cbc -pbkdf2 -iter 10000 -a -in {inputfile}"
}

ssss_gf_init() {
    [[ "${SSSS_GF_READY:-0}" == 1 ]] && return 0
    local primitive=29 x=1 i
    local -a logs exps
    logs[0]=0
    for (( i=0; i<256; i++ )); do
        exps[i]=$x
        logs[x]=$i
        x=$((x << 1))
        if (( x >= 256 )); then
            x=$(( (x ^ primitive) & 255 ))
        fi
    done
    GF_LOG=("${logs[@]}")
    GF_EXP=("${exps[@]}")
    declare -gA SSSS_NIBBLE=(
        [0]=0000 [1]=0001 [2]=0010 [3]=0011
        [4]=0100 [5]=0101 [6]=0110 [7]=0111
        [8]=1000 [9]=1001 [a]=1010 [b]=1011
        [c]=1100 [d]=1101 [e]=1110 [f]=1111
        [A]=1010 [B]=1011 [C]=1100 [D]=1101
        [E]=1110 [F]=1111
    )
    SSSS_GF_READY=1
}

ssss_require_tools() {
    local IFS=$' \t\n'
    local quiet=0
    if [[ ${1:-} == --quiet ]]; then quiet=1; shift; fi
    local -a cmds=("$@")
    if (( ${#cmds[@]} == 0 )); then cmds=(openssl iconv od tr); fi
    local cmd path missing=0
    local -a absent=()
    (( quiet == 0 )) && echo "Checking required commands:" >&2
    for cmd in "${cmds[@]}"; do
        if path=$(command -v "$cmd" 2>/dev/null); then
            (( quiet == 0 )) && printf '  %s: %s\n' "$cmd" "$path" >&2
        else
            (( quiet == 0 )) && printf '  %s: not installed\n' "$cmd" >&2
            absent+=("$cmd"); missing=1
        fi
    done
    if (( missing )); then
        echo "ssss: required command not found: ${absent[*]}" >&2
        echo "ssss: install the missing commands before continuing" >&2
        return 1
    fi
    (( quiet == 0 )) && echo "Required commands are installed." >&2
    return 0
}

ssss__need_tools() { ssss_require_tools --quiet; }

ssss__next_coeff() {
    local hex i b
    if [[ "${SSSS_RNG_SEQ:-0}" == 1 ]]; then
        GF_R=$(( (SSSS_RNG_K * 17 + 1) % 255 + 1 ))
        SSSS_RNG_K=$((SSSS_RNG_K + 1))
        return 0
    fi
    while true; do
        hex=$(openssl rand -hex 32) || return 1
        for (( i=0; i<${#hex}; i+=2 )); do
            b=$((16#${hex:i:2}))
            if (( b != 0 )); then GF_R=$b; return 0; fi
        done
    done
}

ssss__horner() {
    local x=$1; shift
    local -a coeffs=("$@")
    local fx=0 i c logx
    logx=${GF_LOG[x]}
    for (( i=${#coeffs[@]}-1; i>=0; i-- )); do
        c=${coeffs[i]}
        if (( fx == 0 )); then fx=$c
        else fx=$(( GF_EXP[(logx + GF_LOG[fx]) % 255] ^ c )); fi
    done
    GF_R=$fx
}

ssss__lagrange0() {
    local n=$1
    local sum=0 i j yi xi xj product
    for (( i=0; i<n; i++ )); do
        yi=${SSSS_LY[i]}
        (( yi == 0 )) && continue
        product=${GF_LOG[yi]}
        xi=${SSSS_LX[i]}
        for (( j=0; j<n; j++ )); do
            (( i == j )) && continue
            xj=${SSSS_LX[j]}
            product=$(( (product + GF_LOG[xj] - GF_LOG[xi ^ xj] + 255) % 255 ))
        done
        sum=$(( sum ^ GF_EXP[product] ))
    done
    GF_R=$sum
}

ssss__bits8() { local v=$1 bit s=""; for (( bit=7; bit>=0; bit-- )); do s+=$(( (v >> bit) & 1 )); done; SSSS_BITS=$s; }
ssss__bits16() { local v=$1 bit s=""; for (( bit=15; bit>=0; bit-- )); do s+=$(( (v >> bit) & 1 )); done; SSSS_BITS=$s; }

ssss__bits_to_hex() {
    local b=$1 rem i nib
    local -a hexdigits=(0 1 2 3 4 5 6 7 8 9 a b c d e f)
    rem=$(( ${#b} % 4 ))
    if (( rem != 0 )); then b="$(printf '%*s' $((4 - rem)) '' | tr ' ' '0')${b}"; fi
    SSSS_HEX=""
    for (( i=0; i<${#b}; i+=4 )); do nib=$((2#${b:i:4})); SSSS_HEX+="${hexdigits[nib]}"; done
}

ssss__hex_to_bits() {
    local h=$1 i c
    SSSS_BITS=""
    for (( i=0; i<${#h}; i++ )); do
        c=${h:i:1}
        if [[ -z "${SSSS_NIBBLE[$c]:-}" ]]; then echo "ssss: invalid hex in share" >&2; return 1; fi
        SSSS_BITS+="${SSSS_NIBBLE[$c]}"
    done
}

ssss__secret_to_parts() {
    local secret=$1
    local raw b hi lo i
    local -a bytes=() units=()
    raw=$(set -o pipefail; printf '%s' "$secret" | iconv -f UTF-8 -t UTF-16BE | od -An -v -tu1) || {
        echo "ssss: could not encode the secret as text" >&2; return 1; }
    for b in $raw; do [[ -n "$b" ]] || continue; bytes+=($((10#$b))); done
    if (( ${#bytes[@]} == 0 || ${#bytes[@]} % 2 != 0 )); then echo "ssss: secret must be non-empty text" >&2; return 1; fi
    for (( i=0; i<${#bytes[@]}; i+=2 )); do hi=${bytes[i]}; lo=${bytes[i+1]}; units+=($(( (hi << 8) | lo ))); done
    local bits=""
    for (( i=${#units[@]}-1; i>=0; i-- )); do ssss__bits16 "${units[i]}"; bits+="$SSSS_BITS"; done
    bits="1${bits}"
    local len=${#bits}
    local rem=$(( len % 1024 ))
    if (( rem != 0 )); then bits="$(printf '%*s' $((1024 - rem)) '' | tr ' ' '0')${bits}"; fi
    SSSS_PARTS=()
    local pos=${#bits} start chunk
    while (( pos > 0 )); do
        start=$(( pos - 8 )); (( start < 0 )) && start=0
        chunk=${bits:start:pos-start}
        SSSS_PARTS+=($((2#$chunk)))
        pos=$start
    done
}

ssss__bytes_to_text() {
    local -a bytes=("$@")
    local i oct payload=""
    for (( i=0; i<${#bytes[@]}; i++ )); do printf -v oct '\\%03o' "${bytes[i]}"; payload+="$oct"; done
    set -o pipefail
    printf '%b' "$payload" | iconv -f UTF-16BE -t UTF-8
}

# ssss__split_text SECRET THRESHOLD COUNT DEST_ARRAY (filled at 1..COUNT)
# SSSS_RNG_SEQ=1 selects the deterministic coefficient stream used by selftest.
ssss__split_text() {
    local secret=$1 threshold=$2 count=$3
    local -n _dest=$4
    local IFS=$' \t\n'
    local LC_ALL=C
    ssss__need_tools || return 1
    ssss_gf_init || return 1
    if (( threshold < 2 || count < threshold || count > 255 )); then echo "ssss: need 2 <= threshold <= shares <= 255" >&2; return 1; fi
    if [[ -z "$secret" ]]; then echo "ssss: secret is empty" >&2; return 1; fi
    ssss__secret_to_parts "$secret" || return 1
    local nparts=${#SSSS_PARTS[@]}
    local -a share_bits=()
    local s
    for (( s=0; s<count; s++ )); do share_bits[s]=""; done
    local p k x
    local -a coeffs=()
    for (( p=0; p<nparts; p++ )); do
        coeffs=("${SSSS_PARTS[p]}")
        for (( k=1; k<threshold; k++ )); do ssss__next_coeff || return 1; coeffs+=("$GF_R"); done
        for (( x=1; x<=count; x++ )); do
            ssss__horner "$x" "${coeffs[@]}"
            ssss__bits8 "$GF_R"
            share_bits[x-1]="${SSSS_BITS}${share_bits[x-1]}"
        done
    done
    _dest=()
    for (( s=0; s<count; s++ )); do
        ssss__bits_to_hex "${share_bits[s]}"
        printf -v _dest[$((s + 1))] '8%02x%s' $((s + 1)) "$SSSS_HEX"
    done
    unset SSSS_PARTS SSSS_BITS SSSS_HEX
}

ssss_split_text() { unset SSSS_RNG_SEQ SSSS_RNG_K; ssss__split_text "$@"; }

ssss__collect_share_tokens() {
    SSSS_TOKENS=()
    local arg token
    for arg in "$@"; do
        for token in $arg; do
            token=${token%$'\r'}
            if [[ "$token" =~ ^8[0-9a-fA-F]{2}[0-9a-fA-F]+$ ]]; then SSSS_TOKENS+=("$token"); fi
        done
    done
}

ssss_combine_text() {
    local IFS=$' \t\n'
    local LC_ALL=C
    ssss__need_tools || return 1
    ssss_gf_init || return 1
    ssss__collect_share_tokens "$@"
    if (( ${#SSSS_TOKENS[@]} < 2 )); then echo "ssss: need at least two shares" >&2; return 1; fi
    local -a ids=() parts_flat=()
    local token id hex nparts=-1
    for token in "${SSSS_TOKENS[@]}"; do
        id=$((16#${token:1:2}))
        if (( id < 1 || id > 255 )); then echo "ssss: share id out of range" >&2; return 1; fi
        if (( ${#ids[@]} > 0 )); then
            local seen
            for seen in "${ids[@]}"; do
                if (( seen == id )); then echo "ssss: duplicate share id $id" >&2; return 1; fi
            done
        fi
        ids+=("$id")
        hex=${token:3}
        ssss__hex_to_bits "$hex" || return 1
        local bits=$SSSS_BITS
        local -a these=()
        local pos=${#bits} start chunk
        while (( pos > 0 )); do
            start=$(( pos - 8 )); (( start < 0 )) && start=0
            chunk=${bits:start:pos-start}
            these+=($((2#$chunk)))
            pos=$start
        done
        if (( nparts < 0 )); then nparts=${#these[@]}
        elif (( ${#these[@]} != nparts )); then echo "ssss: shares have different lengths" >&2; return 1; fi
        parts_flat+=("${these[@]}")
    done
    local nshares=${#ids[@]}
    local result="" pi si
    SSSS_LX=("${ids[@]}")
    for (( pi=0; pi<nparts; pi++ )); do
        SSSS_LY=()
        for (( si=0; si<nshares; si++ )); do SSSS_LY[si]=${parts_flat[si * nparts + pi]}; done
        ssss__lagrange0 "$nshares"
        ssss__bits8 "$GF_R"
        result="${SSSS_BITS}${result}"
    done
    local k idx=-1
    for (( k=0; k<${#result}; k++ )); do
        if [[ ${result:k:1} == 1 ]]; then idx=$k; break; fi
    done
    if (( idx < 0 )); then echo "ssss: reconstructed secret is not valid" >&2; return 1; fi
    local data=${result:idx+1}
    if (( ${#data} == 0 || ${#data} % 16 != 0 )); then echo "ssss: reconstructed secret is not valid" >&2; return 1; fi
    local -a units=() be=()
    local u
    for (( k=0; k<${#data}; k+=16 )); do units+=($((2#${data:k:16}))); done
    for (( k=${#units[@]}-1; k>=0; k-- )); do u=${units[k]}; be+=($(( (u >> 8) & 255 ))); be+=($(( u & 255 ))); done
    local text
    text=$(ssss__bytes_to_text "${be[@]}") || { echo "ssss: reconstructed secret is not valid text" >&2; return 1; }
    printf '%s' "$text"
    unset SSSS_TOKENS SSSS_LX SSSS_LY SSSS_BITS
}

# Returns 0 when THRESHOLD shares, and the full set, both reconstruct SECRET.
ssss_secret_matches() {
    local secret=$1 threshold=$2; shift 2
    local -a shares=("$@")
    local n=${#shares[@]} got
    if (( n < threshold || threshold < 2 )); then echo "ssss: not enough shares to verify" >&2; return 1; fi
    got=$(ssss_combine_text "${shares[@]}") || return 1
    [[ "$got" == "$secret" ]] || return 1
    if (( threshold < n )); then
        got=$(ssss_combine_text "${shares[@]:0:threshold}") || return 1
        [[ "$got" == "$secret" ]] || return 1
        got=$(ssss_combine_text "${shares[@]:n-threshold:threshold}") || return 1
        [[ "$got" == "$secret" ]] || return 1
    fi
    got=$(ssss_combine_text "${shares[@]:0:1}" "${shares[@]:1:1}" 2>/dev/null || true)
    if (( threshold > 2 )) && [[ -n "$got" && "$got" == "$secret" ]]; then
        echo "ssss: two shares reconstructed a secret that requires more" >&2; return 1
    fi
    return 0
}

# NATO phonetic codenames for guardian shares, in order, 26 names.
ssss_nato_names() {
    printf '%s\n' \
        ALFA BRAVO CHARLIE DELTA ECHO FOXTROT GOLF HOTEL INDIA \
        JULIETT KILO LIMA MIKE NOVEMBER OSCAR PAPA QUEBEC ROMEO \
        SIERRA TANGO UNIFORM VICTOR WHISKEY XRAY YANKEE ZULU
}

# ssss_write_distribution_guide DEST NAME DATE THRESHOLD COUNT CODENAME...
# Writes DISTRIBUTION.txt and RECOVERY.txt for a guardian key ceremony.
# Shares are shares of the passphrase that encrypts the ceremony private key.
ssss_write_distribution_guide() {
    local dest=$1 name=$2 date=$3 threshold=$4 count=$5
    shift 5
    local -a codes=("$@")
    local code i roster="" guardians_csv="" decrypt_cmd
    if [[ ! -d "$dest" ]]; then
        echo "ssss: distribution directory not found" >&2
        return 1
    fi
    if [[ ! "$name" =~ ^[A-Z0-9][A-Z0-9_-]{0,63}$ ]]; then
        echo "ssss: ceremony name is not valid" >&2
        return 1
    fi
    if [[ ! "$date" =~ ^[0-9]{8}$ ]]; then
        echo "ssss: ceremony date is not valid" >&2
        return 1
    fi
    if [[ ! "$threshold" =~ ^[0-9]+$ || ! "$count" =~ ^[0-9]+$ ]]; then
        echo "ssss: threshold and share count must be integers" >&2
        return 1
    fi
    threshold=$((10#$threshold))
    count=$((10#$count))
    if (( ${#codes[@]} == 0 )); then
        local -a all=()
        local line
        while IFS= read -r line; do
            [[ -n "$line" ]] && all+=("$line")
        done < <(ssss_nato_names)
        if (( count < 1 || count > ${#all[@]} )); then
            echo "ssss: share count is outside the codename list" >&2
            return 1
        fi
        codes=("${all[@]:0:count}")
    fi
    if (( ${#codes[@]} != count )); then
        echo "ssss: codename count does not match share count" >&2
        return 1
    fi
    if (( threshold < 2 || threshold > count )); then
        echo "ssss: threshold is out of range" >&2
        return 1
    fi
    for (( i=0; i<count; i++ )); do
        code=${codes[i]}
        if [[ ! "$code" =~ ^[A-Z]+$ ]]; then
            echo "ssss: codename is not valid" >&2
            return 1
        fi
        roster+="$(printf '%d  %s\n' "$((i + 1))" "$code")"
        if (( i < threshold )); then
            if (( i > 0 )); then guardians_csv+=","; fi
            guardians_csv+="$code"
        fi
    done
    decrypt_cmd=$(ssss_openssl_decrypt_command)
    decrypt_cmd=${decrypt_cmd//\{inputfile\}/ciphertext.b64}

    cat > "$dest/DISTRIBUTION.txt" <<EOF
Guardian key distribution
=========================

Ceremony: $name
Date: $date
Threshold: $threshold of $count

This directory is the output of the guardian key ceremony tooling.
This private key is a ceremony and backup key.
It is not wired into contracts or the application.
Record the public key and its fingerprint yourself.
This tooling does not connect to a network.

Publish these files only:
  public/public.pem
  public/fingerprint.txt

The fingerprint is the SHA-256 hash of the public key in DER form.

Keep these offline:
  payload/secured/${date}_${name}_secured_private_key.txt
      Private key, encrypted with the key passphrase.
  shards/CODENAME/secured/${date}_${name}_CODENAME_secured_share.txt
      One sealed share of that key passphrase.
  shards/CODENAME/communication/${date}_${name}_CODENAME_communication.txt
      Paper sheet. It holds that guardian's passphrase, not the share.

shards/CODENAME/unsecured/ holds instructions and a roster excerpt.
Those files are not shares and do not contain the key passphrase.

What the shares hold
--------------------
Each share is a share of the key passphrase, not a piece of the PEM.
That passphrase decrypts the sealed private key above.
The share format can hold a PEM as one text secret. Do not hex-encode
or base64-encode the PEM first. The 1024-bit pad is a minimum width,
not a maximum, so a 4096-bit PEM is not rejected. This shell code loops
once per byte, so the ceremony splits the short passphrase instead and
keeps the encrypted PEM beside the shares.

Guardians
---------
$roster
Rules
-----
- One sealed share per guardian.
- Never email or message a plaintext share.
- Hand each guardian the communication sheet in person, on paper.
- Hand the sealed share file over in a separate physical transfer.
- After the handoff, do not keep the sheet and the sealed share together.
- Do not commit keys, passphrases, shares, or this directory.
- Recover only on an offline machine. Follow RECOVERY.txt.
- Delete working copies when you are done. shred can overwrite a file
  on a hard disk. A solid-state drive may keep old blocks. Prefer a
  live system you can discard, or wipe the disk when the ceremony is over.
EOF

    cat > "$dest/RECOVERY.txt" <<EOF
Guardian key recovery
=====================

Ceremony: $name
Date: $date
Threshold: $threshold of $count

Recover only on an offline machine.
You need the encrypted private key, at least $threshold sealed shares,
and the matching communication sheets. Bring the sheets and the sealed
files together only on that machine.

1. Check the public fingerprint you recorded against public/fingerprint.txt.

2. For each guardian, copy that guardian's sealed share and extract the
   ciphertext. The sealed file has a BEGIN CIPHERTEXT line and an
   END CIPHERTEXT line. Write the lines between them to ciphertext.b64.

   Decrypt with the passphrase printed on that guardian's paper sheet:

   $decrypt_cmd

   Add -out and a mode 600 path if you do not want the share on the screen.
   The output is one share token. Never email or message a plaintext share.

3. Combine at least $threshold share tokens. From the repository root,
   after you have written one share token per file:

   scripts/ceremony/ssss.sh combine share-1.txt share-2.txt

   Pass one file per guardian, at least $threshold files. The command
   prints a header, a blank line, and then the key passphrase. Write
   that passphrase to a mode 600 file.

4. Decrypt the private key the same way. The sealed file is:

   payload/secured/${date}_${name}_secured_private_key.txt

   Extract its ciphertext block and run the openssl command from step 2.
   When openssl asks for a passphrase, use the key passphrase from step 3.
   Save the output as a mode 600 PEM.

5. Check the key.

   openssl pkey -in private.pem -noout -text

   Confirm the line that reports 4096 bits.

   openssl pkey -in private.pem -pubout -outform DER | openssl dgst -sha256

   Confirm the hash matches public/fingerprint.txt and the fingerprint
   you recorded when the ceremony was run.

6. The same checks can be run with:

   scripts/ceremony/guardian_key_ceremony.sh recover --dir CEREMONY_DIR --out private.pem --guardians $guardians_csv

   CEREMONY_DIR is the directory that contains this file. List at least
   $threshold codenames. The command reads each passphrase from that
   guardian's communication sheet. Use it only on an offline machine.
   It writes the private key only after the fingerprint matches.

7. Destroy the working copies of the private key, the key passphrase,
   and the decrypted share files.

   shred -u private.pem

   If shred is not installed, delete the files and treat the disk as
   still holding them. shred cannot promise that a solid-state drive
   erased the old data. Discard a live system, or wipe the whole disk.
EOF
    chmod 644 "$dest/DISTRIBUTION.txt" "$dest/RECOVERY.txt"
}

ssss_usage() {
    cat <<'EOF'
Usage:
  ssss.sh split -t THRESHOLD -n SHARES [-f FILE]
  ssss.sh combine [FILE_OR_SHARE ...]
  ssss.sh selftest

split reads the secret from FILE, or from stdin when FILE is omitted.
On a terminal, split prompts once and does not echo the secret.
The file is read as-is, including a trailing newline if the file has one.
Shares are printed one per line.

combine reads files, share tokens, or stdin.
On a terminal, finish stdin with a line that is exactly: done
combine prints a header, a blank line, and then the secret.

Shares use 8-bit Shamir sharing over GF(256) with 1024-bit padding.
The token format is secrets.js compatible: 8, two hex digits of the
share id (01 through ff), then the hex share data.

The secret is UTF-8 text. A 4096-bit RSA PEM can be one secret with no
extra encoding. The ceremony driver does not split the PEM. It splits
the passphrase that encrypts the PEM. See
docs/ceremony/guardian-key-ceremony.md.

selftest checks one fixed vector and five random round trips.
EOF
}

ssss_cli_split() {
    local threshold="" count="" file=""
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -t|--threshold)
                [[ $# -ge 2 ]] || { echo "ssss: -t needs a value" >&2; return 1; }
                threshold=$2
                shift 2
                ;;
            -n|--shares)
                [[ $# -ge 2 ]] || { echo "ssss: -n needs a value" >&2; return 1; }
                count=$2
                shift 2
                ;;
            -f|--file)
                [[ $# -ge 2 ]] || { echo "ssss: -f needs a value" >&2; return 1; }
                file=$2
                shift 2
                ;;
            *)
                echo "ssss: unknown option: $1" >&2
                return 1
                ;;
        esac
    done
    if [[ -z "$threshold" || -z "$count" ]]; then
        echo "ssss: split requires -t THRESHOLD and -n SHARES" >&2
        return 1
    fi
    if [[ ! "$threshold" =~ ^[0-9]+$ || ! "$count" =~ ^[0-9]+$ ]]; then
        echo "ssss: threshold and share count must be integers" >&2
        return 1
    fi
    threshold=$((10#$threshold))
    count=$((10#$count))
    local secret=""
    if [[ -n "$file" ]]; then
        if [[ ! -f "$file" ]]; then
            echo "ssss: file not found: $file" >&2
            return 1
        fi
        secret=$(cat -- "$file"; printf x) || return 1
        secret=${secret%x}
    elif [[ -t 0 ]]; then
        read -r -s -p "Secret: " secret </dev/tty || return 1
        printf '\n' >&2
    else
        secret=$(cat; printf x) || return 1
        secret=${secret%x}
    fi
    local -a shares=()
    ssss_split_text "$secret" "$threshold" "$count" shares
    local i
    for (( i=1; i<=count; i++ )); do
        printf '%s\n' "${shares[i]}"
    done
}

ssss_cli_combine() {
    local -a raw=()
    if [[ $# -eq 0 ]]; then
        local line
        if [[ -t 0 ]]; then
            echo "Enter share tokens or file names, one per line. Finish with: done" >&2
            while IFS= read -r line; do
                [[ "$line" == "done" ]] && break
                raw+=("$line")
            done
        else
            while IFS= read -r line || [[ -n "$line" ]]; do
                raw+=("$line")
            done
        fi
    else
        raw=("$@")
    fi
    local -a expanded=()
    local arg line
    for arg in "${raw[@]}"; do
        if [[ -f "$arg" ]]; then
            while IFS= read -r line || [[ -n "$line" ]]; do
                expanded+=("$line")
            done < "$arg"
        else
            expanded+=("$arg")
        fi
    done
    if [[ ${#expanded[@]} -eq 0 ]]; then
        echo "ssss: no shares were provided" >&2
        return 1
    fi
    local tmp
    tmp=$(mktemp)
    if ! ssss_combine_text "${expanded[@]}" > "$tmp"; then
        rm -f -- "$tmp"
        return 1
    fi
    printf '%s\n\n' "SSSS Combined output"
    cat -- "$tmp"
    rm -f -- "$tmp"
}

# Fixed share-format vectors below are test strings, not passphrases.
ssss_selftest() {
    ssss_require_tools openssl iconv od tr mktemp || return 1
    local expect1 expect2
    expect1=8017968574635241302f0dfcebdac9b8a7968574635241302f0dfcebdac9b8a7968574635241302f0dfcebdac9b8a7968574635241302f0dfcebdac9b8a7968574635241302f0dfcebdac9b8a7968574635241302f0dfcebdac9b8a7968574635241302f0dfcebdac9b8a7968574635241302f0dfcebdac9b8a79685747354d136a
    expect2=802f2d0ae8c6a482604fda38167452b09f2d0ae8c6a482604fda38167452b09f2d0ae8c6a482604fda38167452b09f2d0ae8c6a482604fda38167452b09f2d0ae8c6a482604fda38167452b09f2d0ae8c6a482604fda38167452b09f2d0ae8c6a482604fda38167452b09f2d0ae8c6a482604fda38167452b09f2d0ae8d6a21266c
    local -a shares=()
    local secret="hi"
    echo "ssss selftest: fixed vector (2 of 2)"
    SSSS_RNG_SEQ=1
    SSSS_RNG_K=0
    if ! ssss__split_text "$secret" 2 2 shares; then
        unset SSSS_RNG_SEQ SSSS_RNG_K
        echo "ssss selftest: fixed split failed" >&2
        return 1
    fi
    unset SSSS_RNG_SEQ SSSS_RNG_K
    if [[ "${shares[1]}" != "$expect1" ]]; then
        echo "ssss selftest: fixed share 1 mismatch" >&2
        printf 'got %s\n' "${shares[1]}" >&2
        return 1
    fi
    if [[ "${shares[2]}" != "$expect2" ]]; then
        echo "ssss selftest: fixed share 2 mismatch" >&2
        printf 'got %s\n' "${shares[2]}" >&2
        return 1
    fi
    echo "ssss selftest: fixed shares match"
    local got=""
    if ! got=$(ssss_combine_text "${shares[1]}" "${shares[2]}"); then
        echo "ssss selftest: fixed combine failed" >&2
        return 1
    fi
    if [[ "$got" != "$secret" ]]; then
        echo "ssss selftest: fixed combine mismatch" >&2
        return 1
    fi
    echo "ssss selftest: fixed combine matches"
    local cli_raw cli_header cli_blank cli_secret
    cli_raw=$(mktemp)
    if ! ssss_cli_combine "${shares[1]}" "${shares[2]}" > "$cli_raw"; then
        rm -f -- "$cli_raw"
        echo "ssss selftest: fixed cli combine failed" >&2
        return 1
    fi
    {
        IFS= read -r cli_header || true
        IFS= read -r cli_blank || true
        cli_secret=$(cat; printf x)
        cli_secret=${cli_secret%x}
    } < "$cli_raw"
    rm -f -- "$cli_raw"
    if [[ "$cli_header" != "SSSS Combined output" || -n "$cli_blank" || "$cli_secret" != "$secret" ]]; then
        echo "ssss selftest: fixed cli output mismatch" >&2
        return 1
    fi
    echo "ssss selftest: fixed cli output matches"

    local -a samples=()
    local -a titles=()
    samples+=("hello")
    titles+=("hello")
    samples+=($'line\nbreak')
    titles+=("line-break")
    samples+=("héllo")
    titles+=("accented")
    samples+=("a😀b")
    titles+=("emoji")
    samples+=("AbC+/=")
    titles+=("symbols")
    local n t idx title above below below_n
    local -a all=()
    for idx in "${!samples[@]}"; do
        secret=${samples[idx]}
        title=${titles[idx]}
        n=$((idx + 1))
        t=$((RANDOM % 9 + 2))
        echo "ssss selftest: random ${n}/5 ${title} threshold ${t} of 10"
        if ! ssss_split_text "$secret" "$t" 10 shares; then
            echo "ssss selftest: random ${n}/5 split failed" >&2
            return 1
        fi
        all=()
        local i
        for (( i=1; i<=10; i++ )); do
            all+=("${shares[i]}")
        done
        if ! ssss_secret_matches "$secret" "$t" "${all[@]}"; then
            echo "ssss selftest: random ${n}/5 secret match failed" >&2
            return 1
        fi
        echo "ssss selftest: random ${n}/5 exact threshold and full set match"
        if (( t < 10 )); then
            if ! above=$(ssss_combine_text "${all[@]:0:t+1}"); then
                echo "ssss selftest: random ${n}/5 above threshold failed" >&2
                return 1
            fi
            if [[ "$above" != "$secret" ]]; then
                echo "ssss selftest: random ${n}/5 above threshold mismatch" >&2
                return 1
            fi
            echo "ssss selftest: random ${n}/5 above threshold matches"
        else
            echo "ssss selftest: random ${n}/5 above threshold is the full set"
        fi
        below_n=$((t - 1))
        below=""
        if (( below_n < 2 )); then
            echo "ssss selftest: random ${n}/5 below threshold rejected (fewer than 2 shares)"
        else
            if below=$(ssss_combine_text "${all[@]:0:below_n}" 2>/dev/null); then
                if [[ "$below" == "$secret" ]]; then
                    echo "ssss selftest: random ${n}/5 below threshold reconstructed the secret" >&2
                    return 1
                fi
            fi
            echo "ssss selftest: random ${n}/5 below threshold does not match"
        fi
    done
    echo "ssss selftest: ok"
}

ssss_main() {
    set -euo pipefail
    local cmd=${1:-}
    if [[ $# -gt 0 ]]; then
        shift
    fi
    case "$cmd" in
        split) ssss_cli_split "$@" ;;
        combine) ssss_cli_combine "$@" ;;
        selftest) ssss_selftest ;;
        help|-h|--help) ssss_usage ;;
        "") ssss_usage >&2; return 1 ;;
        *)
            echo "ssss: unknown command: $cmd" >&2
            ssss_usage >&2
            return 1
            ;;
    esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
    ssss_main "$@"
fi
