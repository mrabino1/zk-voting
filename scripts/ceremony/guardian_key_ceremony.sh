#!/usr/bin/env bash
# Offline guardian key ceremony.
#
# Generates or imports a 4096-bit RSA key, encrypts the private key with a
# passphrase, and splits that passphrase into one sealed share per guardian.
# The private key is ceremony and backup tooling. It is not wired into
# contracts or the application. This key is separate from the ballot
# encryption key. This ceremony does not produce the ballot encryption key.
# The L2 operator gets public/ only, never a share.
#
# Passphrases are read from the terminal or from mode 600 files. They are
# not accepted on the command line. A key passphrase of at least 32
# characters may be generated with openssl rand -base64 48. That value is
# not printed. The private key is encrypted with AES-256-CBC, PBKDF2-HMAC-SHA256,
# 600000 iterations. Splitting the passphrase means the full private key
# sits in payload/secured. A share is useless without that encrypted PEM.
# Keep at least two offline copies of the sealed private key.

set -euo pipefail
umask 077

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=scripts/ceremony/ssss.sh
source "$SCRIPT_DIR/ssss.sh"

WORK=""
STAGE=""
DATE_DIR=""
OUT_PARENT=""
PUBLISHED=0
RECOVER_PUBLISHED=0
COMMAND=run
NONINTERACTIVE=0
NAME=""
OUT=""
THRESHOLD=""
SHARES=""
KEY_PASS_FILE=""
GUARDIAN_PASS_FILE=""
IMPORT=""
RECOVER_DIR=""
RECOVER_OUT=""
GUARDIANS=""
KEY_PASS=""
KEY_TYPE=""
FINGERPRINT=""
DATE=""
META_NAME=""
META_DATE=""
META_THRESHOLD=""
META_COUNT=""
META_CODENAMES=""
META_FINGERPRINT=""
META_BITS=""
META_KEY_TYPE=""
declare -a NATO=()
declare -a GUARDIAN_PASS=()
declare -a SHARE_AT=()

ceremony_note() { printf '%s\n' "$*" >&2; }

ceremony_die() {
    printf 'error: %s\n' "$*" >&2
    if [[ "$COMMAND" == "run" && "$PUBLISHED" != 1 ]]; then
        printf '%s\n' "No ceremony directory was written." >&2
    fi
    if [[ "$COMMAND" == "recover" && "$RECOVER_PUBLISHED" != 1 ]]; then
        printf '%s\n' "No recovered private key was written." >&2
    fi
    exit 1
}

ceremony_shred_tree() {
    local d=$1 f
    [[ -d "$d" ]] || return 0
    while IFS= read -r -d '' f; do
        if command -v shred >/dev/null 2>&1; then
            shred -u -- "$f" >/dev/null 2>&1 || rm -f -- "$f" || true
        else
            rm -f -- "$f" || true
        fi
    done < <(find "$d" -type f -print0 2>/dev/null || true)
    rm -rf -- "$d" || true
}

ceremony_cleanup() {
    if [[ "$PUBLISHED" != 1 && -n "$STAGE" && -d "$STAGE" ]]; then
        ceremony_shred_tree "$STAGE"
    fi
    if [[ -n "$WORK" && -d "$WORK" ]]; then
        ceremony_shred_tree "$WORK"
    fi
    if [[ "$PUBLISHED" != 1 && -n "$DATE_DIR" ]]; then
        rmdir "$DATE_DIR" 2>/dev/null || true
        if [[ -n "$OUT_PARENT" ]]; then
            rmdir "$OUT_PARENT" 2>/dev/null || true
        fi
    fi
}
trap ceremony_cleanup EXIT

usage() {
    cat <<'EOF'
Usage:
  guardian_key_ceremony.sh
  guardian_key_ceremony.sh --noninteractive --name NAME --out DIR \
      --threshold K --shares N \
      --guardian-passphrase-file FILE \
      [--key-passphrase-file FILE] [--type VOTE|POLL] [--import PEM]
  guardian_key_ceremony.sh recover --dir DIR --out PRIVATE_PEM \
      --guardians ALFA,BRAVO,CHARLIE [--guardian-passphrase-file FILE]

The interactive run asks for a ceremony name, generates a new 4096-bit RSA
key or imports an unencrypted PEM, encrypts the private key with a
passphrase, and splits that passphrase into guardian shares.

--name is the election name. --type VOTE or --type POLL appends that
suffix, so the ceremony directory is NAME-VOTE or NAME-POLL, and writes
key_type= into metadata.txt. Recover prints key_type= when it is set.
Omit --type to leave the name unchanged.

--out must be outside the git working tree. When git is installed, the
script refuses a path inside the repository. When git is not installed,
it warns and continues. There is no default directory inside the tree.

--key-passphrase-file is one line of at least 32 characters. One trailing
newline is removed. When the file is omitted, the script generates a
passphrase with: openssl rand -base64 48
That generated value is not printed.
--guardian-passphrase-file has one line per guardian, in codename order
(ALFA, then BRAVO, and so on). It must contain exactly N lines.
Each line is at least 32 characters. The file must be mode 600 or 400.
Do not pass a passphrase on the command line.

recover reads communication sheets unless --guardian-passphrase-file is
set. That file then has one line per codename listed in --guardians, in
that order. A private key is written only after the public fingerprint
matches. --out for recover is the private-key path. When git is
installed, that path must also be outside the git working tree.

This key is ceremony and backup tooling. It is not wired into contracts
or the application.
This key is separate from the ballot encryption key.
This ceremony does not produce the ballot encryption key.
The L2 operator gets public/ only, never a share.

When a flag is omitted, the matching environment variable is used:
  CEREMONY_NONINTERACTIVE=1
  CEREMONY_NAME CEREMONY_OUT CEREMONY_THRESHOLD CEREMONY_SHARES
  CEREMONY_KEY_PASSPHRASE_FILE CEREMONY_GUARDIAN_PASSPHRASE_FILE
  CEREMONY_IMPORT_PEM CEREMONY_TYPE

Suggested passphrase generator (this is a command, not a passphrase):
  openssl rand -base64 48
EOF
}

ceremony_opsec() {
    cat >&2 <<'EOF'
OPSEC
-----
Run this on an offline, air-gapped machine.
Disconnect the network before you generate a key or print a share.

This private key is a ceremony and backup key for this tooling.
It is not wired into contracts or the application.
This key is separate from the ballot encryption key.
This ceremony does not produce the ballot encryption key.
The L2 operator gets public/ only, never a share.

- Never commit a private key, a passphrase, or a share.
- Never email or message a plaintext share.
- One sealed share per guardian.
- Hand each guardian a paper communication sheet.
- Hand that guardian's sealed share over in a separate physical transfer.
- Recover only on an offline machine.
- Destroy working copies when you are finished.
  shred -u FILE overwrites a file and unlinks it.
  On a solid-state drive, shred may not erase the stored blocks.
  Prefer a live system you can discard, or wipe the disk afterward.
EOF
}

ceremony_load_nato() {
    NATO=()
    local name
    while IFS= read -r name; do
        [[ -n "$name" ]] || continue
        NATO+=("$name")
    done < <(ssss_nato_names)
    (( ${#NATO[@]} == 26 )) || ceremony_die "The codename list is incomplete."
}

ceremony_require_passphrase_file_mode() {
    local file=$1
    [[ -f "$file" ]] || ceremony_die "Passphrase file not found."
    [[ $(stat -c %a -- "$file") == 600 || $(stat -c %a -- "$file") == 400 ]] \
        || ceremony_die "Passphrase file must be mode 600 or 400."
}

ceremony_require_mode_600() {
    local file=$1
    [[ -f "$file" ]] || ceremony_die "Secret file not found."
    [[ $(stat -c %a -- "$file") == 600 ]] || ceremony_die "Secret file must be mode 600."
}

ceremony_require_mode_700() {
    local dir=$1
    [[ -d "$dir" ]] || ceremony_die "Directory not found."
    [[ $(stat -c %a -- "$dir") == 700 ]] || ceremony_die "Directory must be mode 700."
}

ceremony_chmod_tree_dirs() {
    local tree=$1 d
    while IFS= read -r -d '' d; do
        chmod 700 "$d" || ceremony_die "Could not set directory mode."
        ceremony_require_mode_700 "$d"
    done < <(find "$tree" -type d -print0)
}

ceremony_assign_outside_repo() {
    local __dest=$1 target=$2 abs parent top
    if [[ "$target" != /* ]]; then
        target="$PWD/$target"
    fi
    command -v realpath >/dev/null 2>&1 || ceremony_die "realpath is required."
    abs=$(realpath -m -- "$target") || ceremony_die "Could not resolve the output path."
    if [[ -d "$abs" ]]; then
        parent=$abs
    else
        parent=$(dirname -- "$abs")
    fi
    while [[ ! -d "$parent" && "$parent" != "/" ]]; do
        parent=$(dirname -- "$parent")
    done
    if ! command -v git >/dev/null 2>&1; then
        ceremony_note "warning: git not found; cannot check that --out is outside a repository. Make sure --out is not inside a repository."
    elif top=$(env -u GIT_DIR -u GIT_WORK_TREE git -C "$parent" rev-parse --show-toplevel 2>/dev/null); then
        top=$(realpath -m -- "$top") || ceremony_die "Could not resolve the git working tree."
        case "$abs/" in
            "$top/"*)
                ceremony_die "Refusing to write inside the git working tree ($top)."
                ;;
        esac
    fi
    printf -v "$__dest" '%s' "$abs"
}

ceremony_apply_key_type() {
    [[ -n "$KEY_TYPE" ]] || return 0
    KEY_TYPE=${KEY_TYPE^^}
    [[ "$KEY_TYPE" == "VOTE" || "$KEY_TYPE" == "POLL" ]] || ceremony_die "--type must be VOTE or POLL."
    if [[ "$NAME" != *-"$KEY_TYPE" ]]; then
        NAME="${NAME}-${KEY_TYPE}"
    fi
    [[ "$NAME" =~ ^[A-Z0-9][A-Z0-9_-]{0,63}$ ]] || ceremony_die "The ceremony name with the type suffix must be 1 to 64 characters."
}

ceremony_generate_key_passphrase() {
    local generated
    generated=$(openssl rand -base64 48 | tr -d '\n') || return 1
    ceremony_check_passphrase "$generated" || return 1
    printf '%s' "$generated"
}

ceremony_check_passphrase() {
    local p=$1
    if (( ${#p} < 32 )); then
        echo "Use a passphrase of at least 32 characters." >&2
        return 1
    fi
    if (( ${#p} > 1024 )); then
        echo "A passphrase longer than 1024 characters is not accepted here." >&2
        return 1
    fi
    if [[ "$p" == *$'\n'* || "$p" == *$'\r'* ]]; then
        echo "A passphrase must be a single line." >&2
        return 1
    fi
    return 0
}

ceremony_read_passphrase_file() {
    local file=$1
    local data
    ceremony_require_passphrase_file_mode "$file"
    data=$(cat -- "$file"; printf x) || ceremony_die "Could not read the passphrase file."
    data=${data%x}
    data=${data%$'\n'}
    data=${data%$'\r'}
    ceremony_check_passphrase "$data" || ceremony_die "Key passphrase file is not valid."
    printf '%s' "$data"
}

ceremony_prompt_passphrase() {
    local __dest=$1 label=$2
    local first="" second=""
    ceremony_note "Generate one with this command, then paste it. It will not be echoed."
    ceremony_note "  openssl rand -base64 48"
    read -r -s -p "$label: " first </dev/tty || return 1
    printf '\n' >/dev/tty
    read -r -s -p "Confirm $label: " second </dev/tty || return 1
    printf '\n' >/dev/tty
    if [[ "$first" != "$second" ]]; then
        echo "The two entries did not match." >&2
        return 1
    fi
    ceremony_check_passphrase "$first" || return 1
    printf -v "$__dest" '%s' "$first"
}

ceremony_require_yes() {
    local prompt=$1 reply=""
    read -r -p "$prompt" reply </dev/tty || return 1
    [[ "$reply" == "YES" ]]
}

ceremony_prompt_line() {
    local __dest=$1 prompt=$2 reply=""
    read -r -p "$prompt: " reply </dev/tty || return 1
    printf -v "$__dest" '%s' "$reply"
}

ceremony_need_int() {
    local label=$1 value=$2 min=$3 max=$4 n
    if [[ ! "$value" =~ ^[0-9]+$ ]]; then
        echo "$label must be an integer." >&2
        return 1
    fi
    n=$((10#$value))
    if (( n < min || n > max )); then
        echo "$label must be from $min to $max." >&2
        return 1
    fi
    printf '%s' "$n"
}

ceremony_fingerprint_private() {
    openssl pkey -in "$1" -pubout -outform DER | openssl dgst -sha256 | awk 'NF{print $NF; exit}'
}

ceremony_fingerprint_public() {
    openssl pkey -in "$1" -pubin -outform DER | openssl dgst -sha256 | awk 'NF{print $NF; exit}'
}

ceremony_assert_rsa_4096() {
    local pem=$1 text header
    [[ -f "$pem" ]] || return 1
    header=$(head -n 1 -- "$pem" || true)
    if [[ "$header" != "-----BEGIN PRIVATE KEY-----" && "$header" != "-----BEGIN RSA PRIVATE KEY-----" ]]; then
        echo "The PEM is not an unencrypted private key." >&2
        return 1
    fi
    if grep -q -E 'BEGIN ENCRYPTED PRIVATE KEY|Proc-Type: 4,ENCRYPTED' -- "$pem"; then
        echo "The PEM is encrypted. Decrypt it on the offline machine before import." >&2
        return 1
    fi
    text=$(openssl pkey -in "$pem" -noout -text 2>/dev/null) || {
        echo "openssl could not read the private key." >&2
        return 1
    }
    [[ "$text" == *"Private-Key: (4096 bit"* ]] || {
        echo "The private key is not 4096 bits." >&2
        return 1
    }
}

ceremony_passfile() {
    local dest=$1 pass=$2
    printf '%s\n' "$pass" > "$dest"
    chmod 600 "$dest"
    ceremony_require_mode_600 "$dest"
}

ceremony_extract_ciphertext() {
    local in=$1 out=$2
    awk '/^##### BEGIN CIPHERTEXT #####$/{p=1;next}/^##### END CIPHERTEXT #####$/{p=0}p' "$in" > "$out"
    [[ -s "$out" ]]
}

ceremony_decrypt_sealed() {
    local sealed=$1 out=$2 passfile=$3 b64
    b64=$(mktemp "$WORK/cipher.XXXXXX")
    ceremony_extract_ciphertext "$sealed" "$b64" || {
        rm -f -- "$b64"
        return 1
    }
    openssl enc -d -aes-256-cbc -md sha256 -pbkdf2 -iter 600000 -a \
        -in "$b64" -out "$out" -pass "file:${passfile}" || {
        rm -f -- "$b64"
        return 1
    }
    rm -f -- "$b64"
    chmod 600 "$out"
    ceremony_require_mode_600 "$out"
}

ceremony_seal() {
    local in=$1 out=$2 passfile=$3
    shift 3
    local -a extra=("$@")
    local b64 decrypt_cmd line
    b64=$(mktemp "$WORK/seal.XXXXXX")
    openssl enc -aes-256-cbc -md sha256 -pbkdf2 -iter 600000 -a -salt \
        -in "$in" -out "$b64" -pass "file:${passfile}"
    decrypt_cmd=$(ssss_openssl_decrypt_command)
    decrypt_cmd=${decrypt_cmd//\{inputfile\}/ciphertext.b64}
    {
        echo "##### BEGIN SECURED FILE #####"
        echo "ceremony: $NAME"
        echo "date: $DATE"
        for line in "${extra[@]}"; do
            printf '%s\n' "$line"
        done
        echo "##### BEGIN CIPHERTEXT #####"
        cat -- "$b64"
        echo "##### END CIPHERTEXT #####"
        echo "Decrypt on an offline machine. Write the lines between BEGIN CIPHERTEXT and END CIPHERTEXT to ciphertext.b64, then run:"
        printf '%s\n' "$decrypt_cmd"
        echo "##### END SECURED FILE #####"
    } > "$out"
    rm -f -- "$b64"
    chmod 600 "$out"
    ceremony_require_mode_600 "$out"
}

ceremony_first_file() {
    local dir=$1 pattern=$2 f
    local -a found=()
    [[ -d "$dir" ]] || return 1
    while IFS= read -r -d '' f; do
        found+=("$f")
    done < <(find "$dir" -type f -name "$pattern" -print0)
    if (( ${#found[@]} == 0 )); then
        printf 'error: no file matches %s in %s\n' "$pattern" "$dir" >&2
        return 1
    fi
    if (( ${#found[@]} > 1 )); then
        printf 'error: more than one file matches %s in %s\n' "$pattern" "$dir" >&2
        return 1
    fi
    printf '%s' "${found[0]}"
}

ceremony_sheet_passphrase() {
    local file=$1 line val=""
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" == "passphrase: "* ]]; then
            val=${line#passphrase: }
        fi
    done < "$file"
    [[ -n "$val" ]] || return 1
    printf '%s' "$val"
}

ceremony_load_guardian_passphrases() {
    local i line code
    GUARDIAN_PASS=()
    if (( NONINTERACTIVE )); then
        [[ -n "$GUARDIAN_PASS_FILE" && -f "$GUARDIAN_PASS_FILE" ]] || ceremony_die "A guardian passphrase file is required."
        ceremony_require_passphrase_file_mode "$GUARDIAN_PASS_FILE"
        local -a lines=()
        mapfile -t lines < "$GUARDIAN_PASS_FILE"
        if (( ${#lines[@]} != SHARES )); then
            ceremony_die "The guardian passphrase file must contain exactly $SHARES lines."
        fi
        for (( i=0; i<SHARES; i++ )); do
            line=${lines[i]%$'\r'}
            ceremony_check_passphrase "$line" || ceremony_die "Guardian passphrase on line $((i + 1)) is not valid."
            GUARDIAN_PASS[i+1]=$line
        done
    else
        for (( i=1; i<=SHARES; i++ )); do
            code=${NATO[i-1]}
            ceremony_note "Guardian $code."
            if ! ceremony_prompt_passphrase line "Passphrase for $code"; then
                ceremony_die "Guardian passphrase was not accepted."
            fi
            GUARDIAN_PASS[i]=$line
        done
    fi
}

ceremony_write_roster_lines() {
    local i code
    for (( i=1; i<=SHARES; i++ )); do
        code=${NATO[i-1]}
        printf '%d %s Guardian %s - placeholder contact\n' "$i" "$code" "$code"
    done
}

ceremony_assert_plaintext_clean() {
    local tree=$1 i pat
    pat="$WORK/forbidden.pat"
    : > "$pat"
    chmod 600 "$pat"
    {
        printf '%s\n' "$KEY_PASS"
        for (( i=1; i<=SHARES; i++ )); do
            printf '%s\n' "${SHARE_AT[i]}"
        done
    } > "$pat"
    chmod 600 "$pat"
    ceremony_require_mode_600 "$pat"
    # Patterns stay in the mode 700 work directory. grep reads them from
    # the file so the passphrase and share tokens are not process arguments.
    if grep -R -F -q -f "$pat" --exclude-dir=secured -- "$tree"; then
        ceremony_die "A plaintext ceremony file contains the key passphrase or a share token."
    fi
    if grep -R -F -q -e "BEGIN PRIVATE KEY" -e "BEGIN RSA PRIVATE KEY" -- "$tree"; then
        ceremony_die "A ceremony file contains a private key."
    fi
}

ceremony_build_tree() {
    local tree=$1 i code token passfile sealed plain out notes comm
    local -a codes=()
    rm -rf -- "$tree"
    mkdir -p "$tree/public" "$tree/payload/secured" "$tree/payload/unsecured"
    for (( i=1; i<=SHARES; i++ )); do
        code=${NATO[i-1]}
        codes+=("$code")
        mkdir -p "$tree/shards/$code/secured" "$tree/shards/$code/unsecured" "$tree/shards/$code/communication"
    done
    ceremony_chmod_tree_dirs "$tree"

    cp -- "$WORK/public.pem" "$tree/public/public.pem"
    chmod 644 "$tree/public/public.pem"
    cat > "$tree/public/fingerprint.txt" <<EOF
SHA-256 of the DER encoding of the public key
$FINGERPRINT
EOF
    chmod 644 "$tree/public/fingerprint.txt"

    {
        printf 'ceremony_name=%s\n' "$NAME"
        printf 'ceremony_date=%s\n' "$DATE"
        printf 'threshold=%s\n' "$THRESHOLD"
        printf 'share_count=%s\n' "$SHARES"
        printf 'codenames='
        printf '%s' "${codes[0]}"
        for (( i=1; i<SHARES; i++ )); do
            printf ' %s' "${codes[i]}"
        done
        printf '\n'
        printf 'key_bits=4096\n'
        if [[ -n "$KEY_TYPE" ]]; then
            printf 'key_type=%s\n' "$KEY_TYPE"
        fi
        printf 'fingerprint_sha256=%s\n' "$FINGERPRINT"
    } > "$tree/metadata.txt"
    chmod 644 "$tree/metadata.txt"

    {
        echo "Guardian roster"
        echo "Ceremony: $NAME"
        echo "Date: $DATE"
        echo "Threshold: $THRESHOLD of $SHARES"
        echo
        echo "Placeholder contacts only. Do not put a real name, postal address, or phone number in this file."
        echo
        ceremony_write_roster_lines
    } > "$tree/roster.txt"
    chmod 644 "$tree/roster.txt"

    cat > "$tree/payload/unsecured/${DATE}_${NAME}_unsecured_notes.txt" <<EOF
##### CEREMONY NOTES #####
ceremony: $NAME
date: $DATE
key_bits: 4096
fingerprint_sha256: $FINGERPRINT
threshold: $THRESHOLD
share_count: $SHARES

This file is not a key and not a share.
The private key is encrypted in the secured directory beside this file.
The key passphrase was split into one sealed share per guardian.
This private key is a ceremony and backup key.
It is not wired into contracts or the application.
This key is separate from the ballot encryption key.
This ceremony does not produce the ballot encryption key.
The L2 operator gets public/ only, never a share.
Publish public/public.pem and public/fingerprint.txt for reference only. They are not used on chain.
Record them where the ceremony log lives, for example the L2.
This tooling does not connect to a network.
Splitting the passphrase means the full private key sits in payload/secured.
A share is useless without that encrypted PEM.
Keep at least two offline copies of the sealed private key.
Never email or message a plaintext share.
Recover only on an offline machine.
##### END CEREMONY NOTES #####
EOF
    chmod 644 "$tree/payload/unsecured/${DATE}_${NAME}_unsecured_notes.txt"

    ceremony_passfile "$WORK/key.pass" "$KEY_PASS"
    sealed="$tree/payload/secured/${DATE}_${NAME}_secured_private_key.txt"
    ceremony_seal "$WORK/private.pem" "$sealed" "$WORK/key.pass" "label: private-key"
    ceremony_decrypt_sealed "$sealed" "$WORK/private.check.pem" "$WORK/key.pass" \
        || ceremony_die "The sealed private key did not decrypt."
    cmp -s -- "$WORK/private.pem" "$WORK/private.check.pem" \
        || ceremony_die "The sealed private key does not match the generated key."

    for (( i=1; i<=SHARES; i++ )); do
        code=${NATO[i-1]}
        token=${SHARE_AT[i]}
        plain="$WORK/share.$i.txt"
        printf '%s\n' "$token" > "$plain"
        chmod 600 "$plain"
        ceremony_require_mode_600 "$plain"
        passfile="$WORK/gpass.$i"
        ceremony_passfile "$passfile" "${GUARDIAN_PASS[i]}"
        sealed="$tree/shards/$code/secured/${DATE}_${NAME}_${code}_secured_share.txt"
        ceremony_seal "$plain" "$sealed" "$passfile" "label: share" "guardian: $code" "share_id: $i"
        out="$WORK/share.$i.out"
        ceremony_decrypt_sealed "$sealed" "$out" "$passfile" \
            || ceremony_die "The sealed share for $code did not decrypt."
        cmp -s -- "$plain" "$out" || ceremony_die "The sealed share for $code does not match."

        notes="$tree/shards/$code/unsecured/${DATE}_${NAME}_${code}_unsecured_notes.txt"
        {
            echo "##### GUARDIAN NOTES #####"
            echo "ceremony: $NAME"
            echo "date: $DATE"
            echo "guardian: $code"
            echo "share_id: $i"
            echo "threshold: $THRESHOLD"
            echo "share_count: $SHARES"
            echo
            echo "This file is not a share. It does not contain a passphrase."
            echo "The sealed share is in the secured directory beside this file."
            echo "The passphrase for that sealed file is on the paper communication sheet."
            echo "One sealed share per guardian."
            echo "Never email or message a plaintext share."
            echo "Recover only on an offline machine."
            echo
            echo "Roster:"
            ceremony_write_roster_lines
            echo "##### END GUARDIAN NOTES #####"
        } > "$notes"
        chmod 644 "$notes"

        comm="$tree/shards/$code/communication/${DATE}_${NAME}_${code}_communication.txt"
        cat > "$comm" <<EOF
##### COMMUNICATION SHEET #####
ceremony: $NAME
date: $DATE
guardian: $code
share_id: $i
threshold: $THRESHOLD
share_count: $SHARES
passphrase: ${GUARDIAN_PASS[i]}
secured_share: shards/$code/secured/${DATE}_${NAME}_${code}_secured_share.txt
Keep this sheet on paper.
Do not type the passphrase until recovery on an offline machine.
Do not read this sheet aloud over a phone, and do not send it in a network message.
Any $THRESHOLD of $SHARES guardians can reconstruct the key passphrase.
This sheet is not a share. The sealed share is a separate file.
One sealed share per guardian.
Never email or message a plaintext share.
This ceremony directory holds the sealed private key, the sealed shares, and these sheets.
Together they can rebuild the private key with no other secret.
Distribute this sheet and the sealed share separately.
After the handoff, shred this sheet from the ceremony machine.
##### END COMMUNICATION SHEET #####
EOF
        chmod 600 "$comm"
        ceremony_require_mode_600 "$comm"
    done

    ssss_write_distribution_guide "$tree" "$NAME" "$DATE" "$THRESHOLD" "$SHARES" "${codes[@]}" \
        || ceremony_die "Could not write the distribution guide."
    ceremony_assert_plaintext_clean "$tree"
}

ceremony_publish_tree() {
    local tree=$1 parent
    parent="$OUT/$DATE"
    FINAL_DIR="$parent/$NAME"
    OUT_PARENT=$OUT
    DATE_DIR=$parent
    if [[ -e "$FINAL_DIR" ]]; then
        ceremony_die "Refusing to overwrite $FINAL_DIR"
    fi
    mkdir -p -- "$parent"
    chmod 700 "$parent"
    ceremony_require_mode_700 "$parent"
    STAGE=$(mktemp -d "$parent/.stage.XXXXXX")
    chmod 700 "$STAGE"
    ceremony_require_mode_700 "$STAGE"
    cp -a -- "$tree/." "$STAGE/" || ceremony_die "Could not stage the ceremony directory."
    ceremony_chmod_tree_dirs "$STAGE"
    mv -- "$STAGE" "$FINAL_DIR" || ceremony_die "Could not publish the ceremony directory."
    STAGE=""
    chmod 700 "$FINAL_DIR" || {
        ceremony_shred_tree "$FINAL_DIR"
        ceremony_die "Could not set directory mode."
    }
    if [[ $(stat -c %a -- "$FINAL_DIR") != 700 ]]; then
        ceremony_shred_tree "$FINAL_DIR"
        ceremony_die "Directory must be mode 700."
    fi
    PUBLISHED=1
}

ceremony_prepare_key() {
    local fp_priv fp_pub pubtext
    WORK=$(mktemp -d)
    chmod 700 "$WORK"
    ceremony_require_mode_700 "$WORK"
    if [[ -n "$IMPORT" ]]; then
        [[ -f "$IMPORT" ]] || ceremony_die "Import file not found."
        ceremony_assert_rsa_4096 "$IMPORT" || ceremony_die "The import file is not a 4096-bit RSA private key."
        cp -- "$IMPORT" "$WORK/private.pem"
    else
        ceremony_note "Generating a 4096-bit RSA key."
        openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$WORK/private.pem" \
            || ceremony_die "openssl could not generate a key."
    fi
    chmod 600 "$WORK/private.pem"
    ceremony_require_mode_600 "$WORK/private.pem"
    ceremony_assert_rsa_4096 "$WORK/private.pem" || ceremony_die "Key generation did not produce a 4096-bit RSA key."
    openssl pkey -in "$WORK/private.pem" -pubout -out "$WORK/public.pem"
    chmod 644 "$WORK/public.pem"
    pubtext=$(openssl pkey -in "$WORK/public.pem" -pubin -noout -text 2>/dev/null) || ceremony_die "Could not read the public key."
    [[ "$pubtext" == *"Public-Key: (4096 bit)"* ]] || ceremony_die "The public key is not 4096 bits."
    fp_priv=$(ceremony_fingerprint_private "$WORK/private.pem") || ceremony_die "Could not fingerprint the private key."
    fp_pub=$(ceremony_fingerprint_public "$WORK/public.pem") || ceremony_die "Could not fingerprint the public key."
    [[ "$fp_priv" == "$fp_pub" && "$fp_priv" =~ ^[0-9a-f]{64}$ ]] || ceremony_die "The public key does not match the private key."
    FINGERPRINT=$fp_priv
    ceremony_note "Key size: 4096-bit RSA."
    ceremony_note "Public key fingerprint (SHA-256 of the DER encoding): $FINGERPRINT"
}

ceremony_run() {
    local choice="" final list_i
    local -a list=()
    ceremony_load_nato
    if (( ! NONINTERACTIVE )) && [[ ! -r /dev/tty ]]; then
        ceremony_die "No terminal is available. Re-run with --noninteractive."
    fi
    if (( ! NONINTERACTIVE )) && [[ -t 1 ]]; then
        clear >/dev/tty 2>/dev/null || true
    fi
    ceremony_note "Guardian key ceremony"
    ceremony_note ""
    ceremony_note "This creates a 4096-bit RSA key, encrypts the private key with a passphrase,"
    ceremony_note "and splits that passphrase into guardian shares."
    ceremony_note ""
    ceremony_opsec
    ceremony_note ""
    ssss_require_tools openssl iconv od tr mktemp awk grep sed date find realpath stat \
        || ceremony_die "Install the missing commands and run this again."
    if (( ! NONINTERACTIVE )); then
        ceremony_require_yes "Type YES to continue: " || ceremony_die "Stopped."
    fi

    if [[ -z "$NAME" ]]; then
        (( NONINTERACTIVE )) && ceremony_die "A ceremony name is required."
        ceremony_prompt_line NAME "Ceremony name" || ceremony_die "A ceremony name is required."
    fi
    NAME=${NAME^^}
    [[ "$NAME" =~ ^[A-Z0-9][A-Z0-9_-]{0,63}$ ]] || ceremony_die "The ceremony name must be 1 to 64 characters: letters, digits, underscore, or hyphen."
    if (( ! NONINTERACTIVE )) && [[ -z "$KEY_TYPE" ]]; then
        ceremony_note "Optional type: VOTE or POLL. Leave blank to keep the ceremony name unchanged."
        ceremony_prompt_line KEY_TYPE "Type" || ceremony_die "Could not read the type."
    fi
    ceremony_apply_key_type

    if [[ -z "$OUT" ]]; then
        (( NONINTERACTIVE )) && ceremony_die "--out is required."
        ceremony_note "Choose a directory outside the git working tree."
        ceremony_prompt_line OUT "Output directory" || ceremony_die "--out is required."
        [[ -n "$OUT" ]] || ceremony_die "--out is required."
    fi
    ceremony_assign_outside_repo OUT "$OUT"
    ceremony_note "Do not commit the ceremony directory."

    if [[ -z "$SHARES" ]]; then
        (( NONINTERACTIVE )) && ceremony_die "--shares is required."
        ceremony_prompt_line SHARES "Number of guardians (2-26)" || ceremony_die "A share count is required."
    fi
    SHARES=$(ceremony_need_int "Share count" "$SHARES" 2 26) || ceremony_die "Share count was not accepted."
    if [[ -z "$THRESHOLD" ]]; then
        (( NONINTERACTIVE )) && ceremony_die "--threshold is required."
        ceremony_prompt_line THRESHOLD "Threshold (2 through $SHARES)" || ceremony_die "A threshold is required."
    fi
    THRESHOLD=$(ceremony_need_int "Threshold" "$THRESHOLD" 2 "$SHARES") || ceremony_die "Threshold was not accepted."

    if (( ! NONINTERACTIVE )) && [[ -z "$IMPORT" ]]; then
        ceremony_note "Key source:"
        ceremony_note "  1  Generate a new 4096-bit RSA private key"
        ceremony_note "  2  Import an unencrypted PEM"
        ceremony_prompt_line choice "Choice [1]" || ceremony_die "A key source is required."
        choice=${choice:-1}
        if [[ "$choice" == "2" ]]; then
            ceremony_prompt_line IMPORT "Path to the unencrypted PEM" || ceremony_die "An import path is required."
        elif [[ "$choice" != "1" ]]; then
            ceremony_die "Choose 1 or 2."
        fi
    fi
    if [[ -n "$IMPORT" && "$IMPORT" != /* ]]; then
        IMPORT="$PWD/$IMPORT"
    fi

    if (( NONINTERACTIVE )); then
        if [[ -n "$KEY_PASS_FILE" ]]; then
            KEY_PASS=$(ceremony_read_passphrase_file "$KEY_PASS_FILE")
        else
            KEY_PASS=$(ceremony_generate_key_passphrase) || ceremony_die "Could not generate a key passphrase."
            ceremony_note "Generated a key passphrase. It is not printed."
        fi
        ceremony_load_guardian_passphrases
    fi

    DATE=$(date -u +%Y%m%d)
    ceremony_prepare_key
    if (( ! NONINTERACTIVE )); then
        ceremony_note "The public key and this fingerprint are published for reference only. They are not used on chain."
        ceremony_note "Record them where the ceremony log lives, for example the L2."
        ceremony_note "This program does not connect to a network."
        ceremony_require_yes "Type YES to encrypt this key and split the passphrase: " || ceremony_die "Stopped."
        ceremony_note "Key passphrase:"
        ceremony_note "  1  Enter a passphrase twice (32 to 1024 characters)"
        ceremony_note "  2  Generate one with openssl rand -base64 48 (it is not printed)"
        ceremony_prompt_line choice "Choice [2]" || ceremony_die "A key passphrase choice is required."
        choice=${choice:-2}
        if [[ "$choice" == "2" ]]; then
            KEY_PASS=$(ceremony_generate_key_passphrase) || ceremony_die "Could not generate a key passphrase."
            ceremony_note "Generated a key passphrase. It is not printed."
        elif [[ "$choice" == "1" ]]; then
            ceremony_prompt_passphrase KEY_PASS "Key passphrase" || ceremony_die "Key passphrase was not accepted."
        else
            ceremony_die "Choose 1 or 2."
        fi
    fi

    SHARE_AT=()
    ssss_split_text "$KEY_PASS" "$THRESHOLD" "$SHARES" SHARE_AT \
        || ceremony_die "Could not split the key passphrase."
    list=()
    for (( list_i=1; list_i<=SHARES; list_i++ )); do
        list+=("${SHARE_AT[list_i]}")
    done
    # Do not create the ceremony directory unless this check returns success.
    if ! ssss_secret_matches "$KEY_PASS" "$THRESHOLD" "${list[@]}"; then
        ceremony_die "Share check failed."
    fi
    ceremony_note "Share check passed ($THRESHOLD of $SHARES)."

    if (( ! NONINTERACTIVE )); then
        ceremony_load_guardian_passphrases
    fi

    ceremony_build_tree "$WORK/tree"
    ceremony_publish_tree "$WORK/tree"
    final=$FINAL_DIR
    ceremony_note ""
    ceremony_note "Ceremony directory: $final"
    ceremony_note "Public fingerprint: $FINGERPRINT"
    ceremony_note "This private key is a ceremony and backup key. It is not wired into contracts or the application."
    ceremony_note "This key is separate from the ballot encryption key."
    ceremony_note "This ceremony does not produce the ballot encryption key."
    ceremony_note "The L2 operator gets public/ only, never a share."
    ceremony_note "WARNING: this ceremony directory holds the sealed private key, the sealed shares, and the communication sheets."
    ceremony_note "Together they can rebuild the private key with no other secret."
    ceremony_note "Distribute the sheets and the sealed shares separately, then shred the communication sheets from this machine."
    ceremony_note "Transfer only sealed files. Print the communication sheets. Read DISTRIBUTION.txt."
    ceremony_note "Recovery steps are in RECOVERY.txt."
    printf 'ceremony_dir=%s\n' "$final"
    if [[ -n "$KEY_TYPE" ]]; then
        printf 'key_type=%s\n' "$KEY_TYPE"
    fi
    printf 'fingerprint_sha256=%s\n' "$FINGERPRINT"
}

ceremony_load_metadata() {
    local file=$1 line key val
    META_NAME=""
    META_DATE=""
    META_THRESHOLD=""
    META_COUNT=""
    META_CODENAMES=""
    META_FINGERPRINT=""
    META_BITS=""
    META_KEY_TYPE=""
    [[ -f "$file" ]] || return 1
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" == *=* ]] || continue
        key=${line%%=*}
        val=${line#*=}
        case "$key" in
            ceremony_name) META_NAME=$val ;;
            ceremony_date) META_DATE=$val ;;
            threshold) META_THRESHOLD=$val ;;
            share_count) META_COUNT=$val ;;
            codenames) META_CODENAMES=$val ;;
            fingerprint_sha256) META_FINGERPRINT=$val ;;
            key_bits) META_BITS=$val ;;
            key_type) META_KEY_TYPE=$val ;;
        esac
    done < "$file"
    if [[ -n "$META_KEY_TYPE" && "$META_KEY_TYPE" != "VOTE" && "$META_KEY_TYPE" != "POLL" ]]; then
        return 1
    fi
    [[ "$META_NAME" =~ ^[A-Z0-9][A-Z0-9_-]{0,63}$ ]] || return 1
    [[ "$META_DATE" =~ ^[0-9]{8}$ ]] || return 1
    [[ "$META_THRESHOLD" =~ ^[0-9]+$ ]] || return 1
    [[ "$META_COUNT" =~ ^[0-9]+$ ]] || return 1
    [[ "$META_FINGERPRINT" =~ ^[0-9a-f]{64}$ ]] || return 1
    [[ "$META_BITS" == "4096" ]] || return 1
    [[ -n "$META_CODENAMES" ]] || return 1
}

ceremony_recover() {
    local -a want=() codes=() tokens=() passlines=()
    local part code sealed comm pass passfile payload fp filefp i seen=" " outdir stage line=""
    [[ -n "$RECOVER_DIR" && -n "$RECOVER_OUT" && -n "$GUARDIANS" ]] \
        || ceremony_die "recover needs --dir, --out, and --guardians."
    ceremony_assign_outside_repo RECOVER_OUT "$RECOVER_OUT"
    [[ ! -e "$RECOVER_OUT" ]] || ceremony_die "Refusing to overwrite the output file."
    [[ -d "$RECOVER_DIR" ]] || ceremony_die "Ceremony directory not found."
    ceremony_load_metadata "$RECOVER_DIR/metadata.txt" || ceremony_die "metadata.txt is missing or not valid."
    local IFS=','
    read -r -a want <<< "$GUARDIANS"
    IFS=$' \t\n'
    for part in "${want[@]}"; do
        part=${part//[[:space:]]/}
        part=${part^^}
        [[ -n "$part" ]] || continue
        codes+=("$part")
    done
    if (( ${#codes[@]} < META_THRESHOLD )); then
        ceremony_die "Need at least $META_THRESHOLD guardians."
    fi
    for code in "${codes[@]}"; do
        [[ "$seen" == *" $code "* ]] && ceremony_die "Duplicate guardian $code."
        seen+=" $code "
        [[ " $META_CODENAMES " == *" $code "* ]] || ceremony_die "Guardian $code is not in this ceremony."
    done
    if [[ -n "$GUARDIAN_PASS_FILE" ]]; then
        [[ -f "$GUARDIAN_PASS_FILE" ]] || ceremony_die "Guardian passphrase file not found."
        ceremony_require_passphrase_file_mode "$GUARDIAN_PASS_FILE"
        mapfile -t passlines < "$GUARDIAN_PASS_FILE"
        if (( ${#passlines[@]} != ${#codes[@]} )); then
            ceremony_die "The guardian passphrase file must have one line per listed guardian."
        fi
    fi
    WORK=$(mktemp -d)
    chmod 700 "$WORK"
    ceremony_require_mode_700 "$WORK"
    for i in "${!codes[@]}"; do
        code=${codes[i]}
        sealed=$(ceremony_first_file "$RECOVER_DIR/shards/$code/secured" '*_secured_share.txt') \
            || ceremony_die "Could not select one sealed share for $code."
        if [[ -n "$GUARDIAN_PASS_FILE" ]]; then
            pass=${passlines[i]%$'\r'}
        else
            comm=$(ceremony_first_file "$RECOVER_DIR/shards/$code/communication" '*_communication.txt') \
                || ceremony_die "Could not select one communication sheet for $code."
            pass=$(ceremony_sheet_passphrase "$comm") || ceremony_die "Communication sheet for $code has no passphrase line."
        fi
        ceremony_check_passphrase "$pass" || ceremony_die "Passphrase for $code is not valid."
        passfile="$WORK/pass.$i"
        ceremony_passfile "$passfile" "$pass"
        ceremony_decrypt_sealed "$sealed" "$WORK/share.$i" "$passfile" \
            || ceremony_die "Could not decrypt the sealed share for $code."
        part=$(cat -- "$WORK/share.$i"; printf x)
        part=${part%x}
        part=${part%$'\n'}
        tokens+=("$part")
    done
    if ! pass=$(ssss_combine_text "${tokens[@]}"); then
        ceremony_die "Could not combine the shares."
    fi
    ceremony_passfile "$WORK/key.pass" "$pass"
    payload=$(ceremony_first_file "$RECOVER_DIR/payload/secured" '*_secured_private_key.txt') \
        || ceremony_die "Could not select one sealed private key."
    ceremony_decrypt_sealed "$payload" "$WORK/recovered.pem" "$WORK/key.pass" \
        || ceremony_die "Could not decrypt the private key."
    ceremony_assert_rsa_4096 "$WORK/recovered.pem" || ceremony_die "Recovered key is not a 4096-bit RSA private key."
    fp=$(ceremony_fingerprint_private "$WORK/recovered.pem") || ceremony_die "Could not fingerprint the recovered key."
    [[ "$fp" == "$META_FINGERPRINT" ]] || ceremony_die "Recovered key fingerprint does not match the ceremony."
    filefp=""
    while IFS= read -r line || [[ -n "$line" ]]; do
        if [[ "$line" =~ ^[0-9a-f]{64}$ ]]; then
            filefp=$line
            break
        fi
    done < "$RECOVER_DIR/public/fingerprint.txt"
    [[ "$filefp" == "$fp" ]] || ceremony_die "fingerprint.txt does not match the recovered key."
    outdir=$(dirname -- "$RECOVER_OUT")
    mkdir -p -- "$outdir"
    stage=$(mktemp "$outdir/.recovered.XXXXXX")
    cp -- "$WORK/recovered.pem" "$stage"
    chmod 600 "$stage"
    mv -- "$stage" "$RECOVER_OUT"
    ceremony_require_mode_600 "$RECOVER_OUT"
    RECOVER_PUBLISHED=1
    if [[ -n "$META_KEY_TYPE" ]]; then
        printf 'key_type=%s\n' "$META_KEY_TYPE"
    fi
    printf 'fingerprint_sha256=%s\n' "$fp"
    printf 'fingerprint_match=yes\n'
    printf 'recovered_private_key=%s\n' "$RECOVER_OUT"
}

apply_env() {
    if (( ! NONINTERACTIVE )) && [[ "${CEREMONY_NONINTERACTIVE:-}" == "1" ]]; then
        NONINTERACTIVE=1
    fi
    [[ -n "$NAME" ]] || NAME=${CEREMONY_NAME:-}
    [[ -n "$OUT" ]] || OUT=${CEREMONY_OUT:-}
    [[ -n "$THRESHOLD" ]] || THRESHOLD=${CEREMONY_THRESHOLD:-}
    [[ -n "$SHARES" ]] || SHARES=${CEREMONY_SHARES:-}
    [[ -n "$KEY_PASS_FILE" ]] || KEY_PASS_FILE=${CEREMONY_KEY_PASSPHRASE_FILE:-}
    [[ -n "$GUARDIAN_PASS_FILE" ]] || GUARDIAN_PASS_FILE=${CEREMONY_GUARDIAN_PASSPHRASE_FILE:-}
    [[ -n "$IMPORT" ]] || IMPORT=${CEREMONY_IMPORT_PEM:-}
    [[ -n "$KEY_TYPE" ]] || KEY_TYPE=${CEREMONY_TYPE:-}
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --noninteractive) NONINTERACTIVE=1; shift ;;
            --name)
                [[ $# -ge 2 ]] || ceremony_die "--name needs a value."
                NAME=$2; shift 2 ;;
            --out)
                [[ $# -ge 2 ]] || ceremony_die "--out needs a value."
                OUT=$2; shift 2 ;;
            --threshold)
                [[ $# -ge 2 ]] || ceremony_die "--threshold needs a value."
                THRESHOLD=$2; shift 2 ;;
            --shares)
                [[ $# -ge 2 ]] || ceremony_die "--shares needs a value."
                SHARES=$2; shift 2 ;;
            --key-passphrase-file)
                [[ $# -ge 2 ]] || ceremony_die "--key-passphrase-file needs a value."
                KEY_PASS_FILE=$2; shift 2 ;;
            --guardian-passphrase-file)
                [[ $# -ge 2 ]] || ceremony_die "--guardian-passphrase-file needs a value."
                GUARDIAN_PASS_FILE=$2; shift 2 ;;
            --import)
                [[ $# -ge 2 ]] || ceremony_die "--import needs a value."
                IMPORT=$2; shift 2 ;;
            --type)
                [[ $# -ge 2 ]] || ceremony_die "--type needs a value."
                KEY_TYPE=$2; shift 2 ;;
            --dir)
                [[ $# -ge 2 ]] || ceremony_die "--dir needs a value."
                RECOVER_DIR=$2; shift 2 ;;
            --guardians)
                [[ $# -ge 2 ]] || ceremony_die "--guardians needs a value."
                GUARDIANS=$2; shift 2 ;;
            recover) COMMAND=recover; shift ;;
            help|-h|--help) COMMAND=help; shift ;;
            *) ceremony_die "Unknown argument: $1" ;;
        esac
    done
}

parse_args "$@"
apply_env
case "$COMMAND" in
    help) usage; exit 0 ;;
    recover)
        if [[ -z "$RECOVER_OUT" ]]; then
            RECOVER_OUT=$OUT
        fi
        ceremony_recover
        ;;
    run) ceremony_run ;;
    *) ceremony_die "Unknown command." ;;
esac
