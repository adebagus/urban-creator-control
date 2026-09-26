# Urban Creator CONTROL

A CNC sender application for GRBL and grblHAL-based controllers, built by [Urban Creator](https://urbancreator.id) — makers of the UC-100, UC-200, and UC-ESP32 CNC controller boards.

Urban Creator CONTROL is a fork of [OpenBuilds CONTROL](https://github.com/OpenBuilds/OpenBuilds-CONTROL), rebranded and extended for our own hardware line and user base. It is not affiliated with or endorsed by OpenBuilds.

## Status

This is a work in progress, actively used and refined based on real-world shop use. Current version: **v2.0.0**. Contributions, issue reports, and feedback are welcome.

## What's different from upstream

Since forking, we've made a number of changes beyond rebranding:

- **Job recovery** — the app remembers where a job was interrupted (connection loss, alarm, power cut, manual stop), tracked by original source line number rather than internal queue position. A "Start from Line" dialog (available from the ribbon or by right-clicking a line in the GCODE editor) lets you resume safely from any line, with a live preview of the machine state (spindle, feed, position) it will restore before the first move.
- **Safer Stop Jog** — the jog-cancel button now performs a full stop (not just a jog-cancel byte) when a job is actively running, closing a gap where the machine could keep moving after the UI reported it as stopped.
- **grblHAL settings enumeration** — for grblHAL controllers that support it, setting names, units, and descriptions are fetched live from the controller (`$ES`) instead of relying on a hardcoded list, so custom or newer firmware settings are no longer shown as "unknown."
- **Security hardening** — closed several XSS sinks, added Socket.IO origin validation, and removed a hardcoded signing-key leak from CI logs.
- **mm-mode by default** — new installs now start in millimeters instead of inches.
- Various UI/UX fixes: quit confirmation while a job is running, corrected job history logging after a stop/reconnect, and other stale-state fixes inherited from the original codebase.

See the commit history for the full detail — most changes were built and validated incrementally with automated tests and mutation testing, then confirmed on physical hardware (Urban Creator UC-100/UC-200 boards running GRBL Mythos and grblHAL) before being merged.

## Requirements

- Windows 10/11 (primary target; other platforms inherited from upstream Electron packaging are untested by us)
- A GRBL or grblHAL-based CNC controller

## Building from source

```bash
npm install
npm run run-local      # run in dev mode
npx electron-builder --win nsis   # build a Windows installer
```

## Known limitations

- The Electron runtime is currently on an older version (inherited from upstream); an upgrade is planned but not yet completed.
- Built installers are not currently code-signed, so Windows SmartScreen may show an "unrecognized publisher" warning on first run.

## License

This project is licensed under the **GNU General Public License, version 3** (GPL-3.0), the same license as the [LICENSE](./LICENSE) file inherited from OpenBuilds CONTROL. See [LICENSE](./LICENSE) for the full text. As a derivative work, modified versions must remain available under the same terms.

## Credits

- Original project: [OpenBuilds CONTROL](https://github.com/OpenBuilds/OpenBuilds-CONTROL) by the OpenBuilds team.
- Urban Creator CONTROL fork and modifications: [Urban Creator](https://urbancreator.id) ([@adebagus](https://github.com/adebagus)).

## Links

- Website: https://urbancreator.id
- Forum / community: https://forum.urbancreator.id
