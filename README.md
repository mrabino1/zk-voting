# zk-voting

Zero-knowledge voting. This repository is just getting started.

## Branches

- `test/unstable` is the default development line. Day-to-day work happens here.
- `master` is production only. Promote to it when a build is ready to ship.

## Host actions

`system_actions.sh` is the operator menu for this repo, adapted from the DealPunchList (`dealpunchlist-node`) system-actions pattern.

```bash
./system_actions.sh            # interactive menu
./system_actions.sh status
./system_actions.sh deploy-dev     # pull test/unstable, install, build, restart
./system_actions.sh deploy-prod   # pull master (confirms first)
```

The script skips install/build/restart until a `package.json`, PM2 ecosystem, systemd unit, or Compose file exists.
