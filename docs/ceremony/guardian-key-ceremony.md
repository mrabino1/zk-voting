# Guardian key ceremony

This is offline tooling for a guardian key ceremony. It creates a 4096-bit RSA key, encrypts the private key with a passphrase, and splits that passphrase into shares. One sealed share goes to each guardian.

This private key is a ceremony and backup key. It is not wired into contracts or the application. Nothing in this guide submits a key, starts a service, or connects to a network. Record the public key and its fingerprint yourself, including on the L2 if that is where the ceremony is published.

Run the ceremony on an offline, air-gapped machine. Disconnect the network first.

## Generate a 4096-bit key

```bash
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

`private.pem` is the secret. `public.pem` is safe to record.

You can generate the key by hand with those commands, or let `scripts/ceremony/guardian_key_ceremony.sh` generate it. The script can also import an existing unencrypted PEM. An encrypted PEM is refused. Decrypt it on the offline machine before you import it.

## Encrypt the private key

Encrypt the PEM before it leaves the offline machine. Two forms prompt for a passphrase and write an encrypted PEM:

```bash
openssl pkey -aes256 -in private.pem -out private.encrypted.pem
openssl pkey -aes-256-cbc -in private.pem -out private.encrypted.pem
```

Type the passphrase when openssl asks. Do not put it on the command line.

The ceremony script uses a third form, the same one printed in the recovery file:

```bash
openssl enc -aes-256-cbc -pbkdf2 -iter 10000 -a -salt -in private.pem -out private.b64
```

That command also prompts. The script stores the armored ciphertext between `BEGIN CIPHERTEXT` and `END CIPHERTEXT` markers, with a short banner around it. The banner is not part of the ciphertext.

The passphrase for this encryption is the secret that gets split. The PEM is not the share secret.

## Fingerprint

The fingerprint is the SHA-256 hash of the public key in DER form:

```bash
openssl pkey -in public.pem -pubin -outform DER | openssl dgst -sha256
```

Record that hash with `public.pem`. Check it again after any recovery.

## Verify the key

Confirm the size. Both commands should report 4096 bits.

```bash
openssl pkey -in private.pem -noout -text
openssl pkey -in public.pem -pubin -noout -text
```

Confirm the public key matches the private key. These two hashes must be the same:

```bash
openssl pkey -in private.pem -pubout -outform DER | openssl dgst -sha256
openssl pkey -in public.pem -pubin -outform DER | openssl dgst -sha256
```

## Handling rules

- Keep the machine offline until the private key, the passphrases, and the decrypted shares are gone.
- Never commit a private key, a passphrase, a share token, or a communication sheet. `*.pem` and `*.key` are ignored by git, and so is a directory named `guardian-ceremony-out`. Do not rely on ignore rules for the rest of the ceremony files.
- Never email or message a plaintext share.
- One sealed share per guardian. Hand the paper communication sheet over in person. Hand the sealed share file over in a separate physical transfer. Do not leave the sheet and the sealed share stored together after that.
- Recover only on an offline machine.
- Destroy working copies when you are done:

```bash
shred -u private.pem
```

`shred -u` overwrites the file and unlinks it. That is meaningful on a hard disk. On a solid-state drive, wear leveling can keep the old blocks, so shred does not prove the data is gone. Prefer a live system you can discard, or wipe the whole disk after the ceremony. If `shred` is not installed, deleting the file is not erasure.

## What is split

`scripts/ceremony/ssss.sh` implements Shamir sharing that is secrets.js compatible:

- The field is GF(256), reduction constant 29 (polynomial 0x11d).
- Each share byte is 8 bits.
- The secret is UTF-8 text, encoded as UTF-16BE. A 1 bit is prefixed, and the bit string is padded with zeros out to a multiple of 1024 bits. That pad is a minimum width, not a maximum.
- A token is `8`, two hex digits of the share id (`01` through `ff`), and the hex share data.

A 4096-bit RSA PEM is text. It can be one secret. Do not hex-encode it or base64-encode it first, or the secret would be different and a secrets.js user of the same PEM text would not match. The format does not reject a PEM of that size.

This shell code loops once per byte per share. A multi-kilobyte PEM is slow, and each token is large. The ceremony therefore does not put the PEM in the shares. It encrypts the PEM and splits the passphrase. The encrypted PEM stays in `payload/secured/`. Both choices use the same share format. Call `ssss.sh` directly if you do want to split a PEM file.

The driver accepts a ceremony passphrase of 16 to 1024 characters, one line. Generate it with:

```bash
openssl rand -base64 48
```

That line is a command. It is not a passphrase. Paste the command's output when the script asks, and type it a second time to confirm. The script never takes a passphrase as a command-line argument.

## Split and recombine

From the repository root, with the passphrase in a mode 600 file and no extra newline (or with a newline you are willing to treat as part of the secret):

```bash
bash scripts/ceremony/ssss.sh split -t 3 -n 5 -f key-passphrase.txt > shares.txt
bash scripts/ceremony/ssss.sh combine share-1.txt share-2.txt share-3.txt
```

`combine` prints a header, a blank line, and then the secret. On a terminal with no file arguments, enter tokens and finish with a line that says `done`.

Any 3 of the 5 shares reconstruct the passphrase. Fewer than 3 do not. Decrypt the private key with the reconstructed passphrase, then compare hashes with the original private key:

```bash
openssl dgst -sha256 private.pem
openssl dgst -sha256 recovered.pem
```

The digests match when the round trip is intact. Compare the public-key fingerprint as well.

`bash scripts/ceremony/ssss.sh selftest` checks a fixed vector and five random round trips. `bash scripts/ceremony/roundtrip.sh` generates a throwaway 4096-bit key, splits and recombines a passphrase, runs the full ceremony, recovers the key from two different guardian subsets, checks the hashes, and rejects a below-threshold recovery. Both commands are the checks in [`.github/workflows/guardian-key-ceremony.yml`](../../.github/workflows/guardian-key-ceremony.yml), which runs on pull requests. The same job is in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml). They write only under a temporary directory (`roundtrip.sh`) or only to the terminal (`selftest`).

## Ceremony driver

`scripts/ceremony/guardian_key_ceremony.sh` walks through the ceremony:

1. An OPSEC warning and a check that openssl, iconv, od, tr, and the other required commands are installed.
2. A ceremony name.
3. A new 4096-bit RSA key, or an imported unencrypted PEM.
4. `public.pem` and the SHA-256 fingerprint, for you to record on the L2. The script does not publish them.
5. A key passphrase, entered twice. A suggested generator is `openssl rand -base64 48`. That passphrase encrypts the private key.
6. A threshold and a guardian count, from 2 to 26. Guardians are named with NATO phonetic codenames: ALFA, BRAVO, CHARLIE, and so on through ZULU.
7. A share check (`ssss_secret_matches`) before any ceremony directory is written. If the check fails, the script stops and writes nothing.
8. For each guardian: a sealed share (the share token encrypted with that guardian's passphrase), an unsecured notes file (instructions and roster only), and a communication sheet (the guardian passphrase, for paper).
9. A roster of placeholder contacts. The script does not ask for a real name or a real contact.
10. `DISTRIBUTION.txt` and `RECOVERY.txt`.

Interactive run:

```bash
bash scripts/ceremony/guardian_key_ceremony.sh
```

The default output directory is `guardian-ceremony-out/` in the current directory. Do not commit it.

Non-interactive run, for a test or a scripted rehearsal. Put each passphrase in a file. Do not pass the passphrase itself:

```bash
bash scripts/ceremony/guardian_key_ceremony.sh --noninteractive \
  --name CEREMONY \
  --out /path/to/output \
  --threshold 3 \
  --shares 5 \
  --key-passphrase-file /path/to/key-passphrase.txt \
  --guardian-passphrase-file /path/to/guardian-passphrases.txt
```

`--import /path/to/private.pem` uses an existing key instead of generating one. The guardian passphrase file has one line per guardian, ALFA first. One trailing newline on the key passphrase file is removed.

Flags may be omitted when the matching environment variable is set: `CEREMONY_NONINTERACTIVE`, `CEREMONY_NAME`, `CEREMONY_OUT`, `CEREMONY_THRESHOLD`, `CEREMONY_SHARES`, `CEREMONY_KEY_PASSPHRASE_FILE`, `CEREMONY_GUARDIAN_PASSPHRASE_FILE`, `CEREMONY_IMPORT_PEM`.

Recovery, on an offline machine, after at least the threshold number of sheets and sealed shares are in the ceremony directory:

```bash
bash scripts/ceremony/guardian_key_ceremony.sh recover \
  --dir /path/to/ceremony \
  --out /path/to/private.pem \
  --guardians ALFA,BRAVO,CHARLIE
```

The command reads passphrases from the communication sheets, decrypts those shares, reconstructs the key passphrase, decrypts the private key, and writes the PEM only if the fingerprint matches. The manual steps are in `RECOVERY.txt`.
