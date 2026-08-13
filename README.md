# Modern Bar

A Tron-style theme for the GNOME Shell top panel: neon circuit colors on a
flat deep-black background, plus a compact metrics cluster where the
Activities button used to be.

- **Seven circuit palettes** — Tron (blue), ISO (white), Clu (gold),
  Rinzler (orange), Sark (red), Military (teal green), Utility (violet).
  Every palette shares the same near-black background; only the circuit
  color changes.
- **Themed dropdowns** — Quick Settings and the clock/calendar menu are
  recolored to match. Colors only: no layout or geometry changes, and a
  single switch turns it off if you prefer stock Adwaita popups.
- **Metrics cluster** (left side, each with a click-open detail dropdown):
  - **CPU %** — sampled from `/proc/stat`; dropdown adds memory and load
    average.
  - **Workday %** — how far through your working hours you are; hides
    outside them.
  - **Weather** — current temperature via Open-Meteo (no account, no API
    key); dropdown shows details and a 7-day outlook.
  - **Claude usage** *(off by default)* — your Claude account's 5-hour
    usage window, for people who run [Claude Code](https://claude.com/claude-code)
    and want the number on the panel instead of in a terminal.
  - **Codex usage** *(off by default)* — the shortest account quota window
    OpenAI reports. If the account has both a short and weekly window, the
    dropdown shows both; if OpenAI reports only a weekly window, that is the
    panel value.
- **Mouse-away dismissal** — Quick Settings and the calendar close when the
  pointer leaves them, like the metric dropdowns. Click-outside, Escape and
  keyboard navigation are untouched, and it's a preference if you'd rather
  keep stock behavior.

The Activities button is hidden to make room (the Super key still opens the
Overview). Everything is restored when the extension is disabled.

## Compatibility

GNOME Shell **50** on Wayland or X11. Settings live in GSettings, so the
panel is fully scriptable, e.g.:

```bash
gsettings set org.gnome.shell.extensions.modernbar palette clu
```

## Install

From [extensions.gnome.org](https://extensions.gnome.org) (pending review),
or from source:

```bash
git clone https://github.com/gdeshmukh/modern-bar.git
cd modern-bar
make install     # packs and installs the extension zip
```

Then log out and back in (Wayland), and enable it:

```bash
gnome-extensions enable modernbar@gdesh.com
```

## Privacy & network access

- **Weather / location search** talk to the free
  [Open-Meteo](https://open-meteo.com) APIs. Only coordinates (and, when you
  search by name, the place name you typed) are sent. Coordinates are also
  editable directly, so you never have to use the geocoder at all.
- **Claude usage** is opt-in and off by default. When enabled, it reads the
  OAuth token Claude Code already stores in `~/.claude/.credentials.json`
  and sends it to Anthropic's own usage endpoint — the same number the
  Claude app shows. The token is read fresh per request, never stored or
  logged by the extension, and never sent anywhere except Anthropic. While
  the metric is off, the credential file is not opened and no request is made.
- **Codex usage** is also opt-in and off by default. When enabled, it reads
  the ChatGPT access token and account ID Codex stores in `~/.codex/auth.json`
  and sends them only to ChatGPT's account-usage endpoint. The extension
  caches only the resulting percentage and update time. While the metric is
  off, the credential file is not opened and no request is made.
- No telemetry, no analytics, nothing else leaves the machine.

## Translations

Strings are gettext-wrapped and the template lives in `po/modernbar.pot`.
Translations are welcome — add a `po/<lang>.po` and open a PR.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).

Claude and the Claude logo are trademarks of Anthropic, PBC. This extension
is an independent project and is not affiliated with or endorsed by
Anthropic. Weather data by [Open-Meteo.com](https://open-meteo.com)
(CC BY 4.0).
