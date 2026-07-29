// modern-bar — stylesheet generator
//
// St has no CSS variables, so every circuit palette must restate every
// accent-bearing rule. Two palettes were maintainable by hand; seven are not.
// This script is now the SOURCE OF TRUTH for stylesheet.css:
//
//     gjs -m build/gen-stylesheet.js        (or: make stylesheet)
//
// It writes:
//   - stylesheet.css            (committed build artifact — DO NOT hand-edit)
//   - tools/palette-preview.html (dev-only eyeball page, git-excluded)
// and it FAILS the build if any palette's text roles drop below the contrast
// floors, so "themed" can never quietly become "unreadable".
//
// ── The system ─────────────────────────────────────────────────────────────
// One shared background for every palette: #04070d, the blueish deep black of
// the Legacy grid (and of the kitty day terminal — the seamless-panel rule).
// Palettes change only the CIRCUIT color on top of that void, per the canon
// circuitry-color table (tron.fandom.com/wiki/Program):
//
//   tron      blue-white — neutral programs, fights for the Users
//   iso       white      — the ISOs and the Users
//   clu       gold       — the system administrator himself
//   rinzler   orange     — programs repurposed to serve Clu
//   sark      red        — loyal to the MCP (and Dillinger's grid in Ares)
//   military  teal green — the military programs of the '82 system
//   utility   violet     — data pushers and system utilities of '82
//
// Each palette is a five-step glow ladder + an alert color:
//   rest    dim, LOW-CHROMA tint — circuits idling. Most text sits here.
//   bright  pale variant — solid fills on SMALL surfaces, meter fills, sliders
//   deep    full saturation — hover/active/checked, headers, today-circle.
//           The "power-up": color earns full energy only when touched/on.
//   fore    near-white with a breath of the hue — popup values, primary text
//   alert   the OPPOSING faction's color, so warnings read as an intrusion:
//           cool palettes flare ember orange, warm palettes flare cold blue.
// Large areas never get solid deep — washes are alpha steps of deep/bright
// (design rule: accent intensity scales inversely with area).

import GLib from 'gi://GLib';
import System from 'system';

const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const ROOT = GLib.path_get_dirname(HERE);

// ── Palette data ────────────────────────────────────────────────────────────
// `label`/`lore` are what prefs shows (also exported for prefs.js via
// `gjs -m build/gen-stylesheet.js --list`, keeping one source of truth).
const BG = '#04070d';           // the shared void — every palette, every surface
const EMBER = '#ff8a4d';        // alert on cool palettes (the repurposed flare)
// Alert on warm palettes (the intrusion blue). Was #3d94e0 (the kitty night
// alert); lifted after the OKLCH audit — it sat 0.10 L dimmer than ember, so
// warnings hit softer on warm palettes than cool ones. #51aafa matches ember's
// punch (L 0.72 vs 0.75; the residue is blue's sRGB gamut ceiling, not taste).
const COLD = '#51aafa';

const PALETTES = [
    {
        name: 'tron', label: 'Tron', lore: 'Blue — fights for the Users',
        rest: '#9fe8f0', bright: '#9dfaff', deep: '#2ff0ff', fore: '#dff2f7',
        alert: EMBER,
    },
    {
        // Achromatic by design: it can only power up by LIGHTNESS, and the
        // white-hot flare IS the ISO identity — its outsized rest→deep jump is
        // accepted, not an error. bright was #eef4f6, dropped to the bright-role
        // median so a meter fill stops being a near-twin of a checked toggle.
        name: 'iso', label: 'ISO', lore: 'White — the ISOs and the Users',
        rest: '#c9d6db', bright: '#dce3e6', deep: '#ffffff', fore: '#f7fbfc',
        alert: EMBER,
    },
    {
        name: 'clu', label: 'Clu', lore: 'Gold — the system administrator',
        rest: '#e0c184', bright: '#ffdf80', deep: '#ffc233', fore: '#fff3d6',
        alert: COLD,
    },
    {
        // deep was #ff7f3f: only 14.6° of OKLCH hue from sark's red (confusable
        // under deuteranopia) and it HOVERED DARKER than rest instead of
        // flaring. #ff9a43 re-spaces the warm trio (25.6°/28.7° gaps), matches
        // rinzler's own rest/bright hue, and lands the power-up at exactly
        // tron's constant-lightness chroma-flare. bright lifted to role median.
        name: 'rinzler', label: 'Rinzler', lore: 'Orange — repurposed to serve Clu',
        rest: '#e5a983', bright: '#ffbe95', deep: '#ff9a43', fore: '#ffe8da',
        alert: COLD,
    },
    {
        // deep was #ff5540 (OKLab L 0.68 — brake-light-in-fog on this void; red
        // at that chroma is gamut-capped, but it can come up). #ff705f keeps the
        // menace while igniting on hover instead of darkening; the remaining
        // −0.13 L vs the deep-role median is sRGB physics, not a design choice.
        name: 'sark', label: 'Sark', lore: 'Red — loyal to the MCP',
        rest: '#eaa0a0', bright: '#ffb8af', deep: '#ff705f', fore: '#ffe6e2',
        alert: COLD,
    },
    {
        name: 'military', label: 'Military', lore: 'Teal green — the tank drivers of ’82',
        rest: '#9fe0c0', bright: '#8dfad2', deep: '#3ff5b0', fore: '#ddf7ec',
        alert: EMBER,
    },
    {
        // deep was #a37cff (same L-sag as sark — hover darkened); #ac8efd
        // ignites instead. bright lifted so a meter fill separates from idle
        // text (was dE 0.045 from rest — barely "lit").
        name: 'utility', label: 'Utility', lore: 'Violet — data pushers and system utilities',
        rest: '#c0aee8', bright: '#d2c1ff', deep: '#ac8efd', fore: '#ece5fb',
        alert: EMBER,
    },
];

// ── Color helpers ───────────────────────────────────────────────────────────
function channels(hex) {
    const h = hex.replace('#', '');
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}

function rgba(hex, a) {
    const [r, g, b] = channels(hex);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// WCAG relative luminance / contrast ratio.
function luminance(hex) {
    const [r, g, b] = channels(hex).map(v => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

// Panel/popup text is small (≈10pt), so the floors are strict. `bright` and
// `alert` also appear as text (fills are washes, but meter fills and alert
// values render solid), so they get floors too.
const FLOORS = {rest: 6, bright: 6, deep: 4.5, fore: 10, alert: 4};

// The schema's <choices> and this roster must agree, IN ORDER. Drift is a
// silent visual failure: extension.js applies the unknown class, the shared
// void stays, and every accent state falls back to the SYSTEM accent — the
// exact Phase-4 bleed bug, with no error anywhere. So the build refuses.
// (Regex-parsing is fine here: the schema is ours and the shape is fixed.)
function checkSchemaRoster() {
    const xmlPath = GLib.build_filenamev(
        [ROOT, 'schemas', 'org.gnome.shell.extensions.modernbar.gschema.xml']);
    const [, bytes] = GLib.file_get_contents(xmlPath);
    const key = /<key name="palette"[\s\S]*?<\/key>/.exec(new TextDecoder().decode(bytes));
    if (!key)
        throw new Error('schema has no `palette` key');
    const schema = [...key[0].matchAll(/<choice value="([^"]+)"/g)].map(m => m[1]);
    const ours = PALETTES.map(p => p.name);
    if (JSON.stringify(schema) !== JSON.stringify(ours)) {
        throw new Error(
            `palette roster drift — schema [${schema}] vs generator [${ours}]`);
    }
}

function validate() {
    const rows = [];
    let failed = false;
    for (const p of PALETTES) {
        const cols = Object.keys(FLOORS).map(role => {
            const c = contrast(p[role], BG);
            const ok = c >= FLOORS[role];
            if (!ok)
                failed = true;
            return `${role} ${c.toFixed(1)}${ok ? '' : ' *** BELOW FLOOR ***'}`;
        });
        rows.push(`  ${p.name.padEnd(9)} ${cols.join('  ')}`);
    }
    print(`contrast vs shared bg ${BG} (floors: ` +
        `${Object.entries(FLOORS).map(([k, v]) => `${k}≥${v}`).join(' ')})`);
    rows.forEach(r => print(r));
    if (failed)
        throw new Error('contrast floor violated — adjust the palette table');
}

// ── stylesheet.css ──────────────────────────────────────────────────────────

function header() {
    return `\
/* ─────────────────────────────────────────────────────────────────────────
 * modern-bar — stylesheet.css
 *
 * ██ GENERATED FILE — do not edit by hand. ██
 * Source of truth: build/gen-stylesheet.js (palette table + rule templates).
 * Regenerate with \`make stylesheet\` (runs gjs -m build/gen-stylesheet.js).
 *
 * A sibling of the "ENCOM/Tron" kitty terminal: flat, frameless, glowing
 * circuits on one shared blueish deep black (${BG}) — the void every canon
 * palette lies on top of. Palette classes (.modern-bar-<name>) swap ONLY the
 * circuit color; the background never changes. See the generator header for
 * the full ladder/role system and the canon color table.
 *
 * Structure of this file:
 *   1. SHARED  — geometry, fonts, the void background (palette-independent)
 *   2. PER PALETTE × (panel block + dropdown block + metric-popup block)
 *
 * The dropdown blocks keep the hard-won Phase-4 rules:
 *   - RECOLOR ONLY: never restate border-radius/padding/size — stock geometry
 *     is correct and leaving it alone is what keeps us upgrade-safe.
 *   - Focus rings carry !important (stock declares them !important; matching
 *     origin+important is the only way to win). They sit inset on the tile
 *     EDGE — any un-restated ring is an accent-bleed bug.
 *   - Never a bare .button/.icon-button/.flat/.message/.popup-menu-content/
 *     StScrollBar rule — those bases are shared with the login screen,
 *     Looking Glass and modal dialogs. Anchor on .quick-settings,
 *     .quick-toggle-menu, .datemenu-popover, .calendar, .message-list.
 *   - QS sub-menus are NOT inside .quick-settings (the overlay is a sibling
 *     of the boxpointer) — anchor sub-menu rules on .quick-toggle-menu bare.
 * ───────────────────────────────────────────────────────────────────────── */
`;
}

function sharedBlock() {
    return `
/* ═══ 1. SHARED — one void, one type system, all palettes ═══════════════════ */

#panel.modern-bar {
    /* The shared void. Solid — identical to the fully-opaque kitty terminal
     * background, so the bar reads seamless with the terminal on the day
     * setup. Flat: no gradient, no border, no box-shadow (St renders shadows
     * as re-blurred offscreen textures every repaint — the panel repaints
     * ~1/sec with clock seconds; a real glow would cost GPU forever). */
    background-color: ${BG};
    border: none;
    box-shadow: none;
    font-family: "JetBrains Mono", monospace;
    font-size: 10.5pt;
}

/* Metrics cluster (left, where Activities was). */
#panel.modern-bar .modern-bar-metrics {
    spacing: 14px;
    padding: 0 10px 0 6px;
}

#panel.modern-bar .modern-bar-metric {
    font-weight: 400;                /* regular — a touch back up from 300 */
    font-feature-settings: "tnum";   /* stop width jitter as digits change */
}

#panel.modern-bar .modern-bar-weather-icon,
#panel.modern-bar .modern-bar-metric-icon {
    icon-size: 15px;
    padding-right: 4px;   /* the only glyph→number gap (labels have no leading space) */
}

/* Every label/clock/indicator inherits the panel font; flat buttons — no
 * rounded pill background/outline in ANY state (state feedback is purely the
 * text/icon powering up to the palette's deep accent, set per palette). */
#panel.modern-bar .panel-button {
    font-family: "JetBrains Mono", monospace;
    font-size: 10.5pt;
    background-color: transparent;
    border-radius: 0;
    border: none;
    box-shadow: none;
    -natural-hpadding: 8px;
    -minimum-hpadding: 6px;
}

#panel.modern-bar .panel-button:hover,
#panel.modern-bar .panel-button:focus,
#panel.modern-bar .panel-button:active,
#panel.modern-bar .panel-button:checked {
    background-color: transparent !important;
    box-shadow: none !important;   /* kill the stock inset-100px white pill */
}

#panel.modern-bar .panel-button:focus {
    outline: none;
}

/* The clock: tabular figures; the stock theme paints its hover/active pill as
 * a box-shadow on the INNER .clock label (with radius 999px) — kill both. */
#panel.modern-bar .clock-display .clock {
    font-feature-settings: "tnum";
    border-radius: 0 !important;
    box-shadow: none !important;
}

/* Popup surfaces all sit on the same void as the panel. */
.modern-bar-popups .quick-settings,
.modern-bar-popups .datemenu-popover,
.modern-bar-popups .modern-bar-popup .popup-menu-content {
    background-color: ${BG};
}

/* Our own metric dropdowns: we own this geometry (they're our widgets — the
 * recolor-only rule is for GNOME's popups, not these). */
.modern-bar-popups .modern-bar-popup .popup-menu-content {
    padding: 14px 16px;
}

.modern-bar-popups .modern-bar-popup .modern-bar-popup-content {
    font-family: "JetBrains Mono", monospace;
    font-size: 10pt;
    min-width: 180px;
}

/* ── Typeface for the GNOME dropdowns ───────────────────────────────────────
 * The panel and our own metric popups have always been JetBrains Mono; Quick
 * Settings and the calendar were left in the system face, which is why they
 * read as a different product bolted underneath the bar.
 *
 * This is the ONE place the recolor-only rule is deliberately widened, and only
 * to font-family. No font-size, no weight, no geometry: size is what stock uses
 * to compute tile and cell metrics, so changing it is how you get clipping
 * after a shell upgrade. Family alone still shifts text WIDTH, which is the
 * live risk here — JetBrains Mono is wider than Cantarell, so a long
 * title/subtitle pair ("Power Mode" / "Balanced") is the thing to check first
 * if a label starts ellipsising.
 *
 * Scoped to the three dropdown roots, never a bare .popup-menu-content: that
 * base is shared with the login screen, Looking Glass and modal dialogs. */
.modern-bar-popups .quick-settings,
.modern-bar-popups .quick-toggle-menu,
.modern-bar-popups .datemenu-popover {
    font-family: "JetBrains Mono", monospace;
}

/* Tile width — the SECOND deliberate geometry exception, and a direct
 * consequence of the first: stock sets min-width AND max-width 12em on tiles,
 * sized for Cantarell. JetBrains Mono is wider, and the longest stock title
 * ("Do Not Disturb") measures 12.14em uncapped (tools/qsprobe.js) — so under
 * stock's cap it ellipsised on the live pane ("Do Not Distu…"). 13em fits it
 * with headroom; min = max keeps stock's uniform-tile mechanism intact, and
 * the pane only grows ~2em total. Long DYNAMIC content (SSID subtitles etc.)
 * still ellipsises, which is correct — this is sized for the fixed titles. */
.modern-bar-popups .quick-settings .quick-toggle,
.modern-bar-popups .quick-settings .quick-toggle-has-menu {
    min-width: 13em;
    max-width: 13em;
}

/* The inner half of a has-menu pill must stay free-width inside its parent
 * (stock sets it auto; restated here only because the rule above raises the
 * bare .quick-toggle bound that stock's auto would otherwise inherit from). */
.modern-bar-popups .quick-settings .quick-toggle-has-menu .quick-toggle {
    min-width: auto;
    max-width: auto;
}

.modern-bar-popups .modern-bar-popup .modern-bar-popup-header {
    font-size: 8.5pt;
    font-weight: bold;
    padding-bottom: 10px;
}

.modern-bar-popups .modern-bar-popup .modern-bar-popup-row {
    padding-bottom: 9px;
}

.modern-bar-popups .modern-bar-popup .modern-bar-popup-value {
    font-weight: bold;
    font-feature-settings: "tnum";
    padding-left: 12px;
}

/* Meter geometry. The fill's WIDTH is set in JS (St has no percentage
 * widths); keep the trough/fill heights in sync. */
.modern-bar-popups .modern-bar-popup .modern-bar-popup-meter {
    height: 3px;
    margin-top: 5px;
}

.modern-bar-popups .modern-bar-popup .modern-bar-popup-meter-fill {
    height: 3px;
}

.modern-bar-popups .modern-bar-popup .modern-bar-popup-icon {
    icon-size: 14px;
    padding-right: 8px;
}

/* Tail slot: a marked SECOND value after the main one (currently the forecast
 * rows' chance of rain). Smaller than the value it trails and set at the
 * resting weight, so it reads as an annotation rather than a competing figure —
 * the whole point is that it can't be mistaken for a third temperature. */
.modern-bar-popups .modern-bar-popup .modern-bar-popup-tail-icon {
    icon-size: 11px;
    padding-left: 12px;
    padding-right: 3px;
}

.modern-bar-popups .modern-bar-popup .modern-bar-popup-tail {
    font-size: 8.5pt;
    font-feature-settings: "tnum";
}

.modern-bar-popups .modern-bar-popup .modern-bar-popup-rowtop {
    padding-bottom: 3px;
}

.modern-bar-popups .modern-bar-popup .modern-bar-popup-caption {
    font-size: 8.5pt;
    padding-bottom: 8px;
}

.modern-bar-popups .modern-bar-popup .modern-bar-popup-separator {
    height: 1px;
    margin: 2px 0 9px 0;
}
`;
}

// ── Per-palette: the panel ──────────────────────────────────────────────────
function panelBlock(p) {
    const P = `#panel.modern-bar.modern-bar-${p.name}`;
    return `
/* ── ${p.name}: panel ── */

${P} {
    color: ${p.rest};
}

/* Optional under-line (UNDERGLOW=false in extension.js by default). */
${P}.modern-bar-underglow {
    border-bottom: 2px solid ${p.deep};
}

${P} .modern-bar-metric,
${P} .modern-bar-weather-icon,
${P} .modern-bar-metric-icon,
${P} .panel-status-indicators-box .system-status-icon,
${P} .panel-button {
    color: ${p.rest};
}

/* Power-up on hover: text/icon jump from resting dim to the deep accent. The
 * label and icon are children that don't inherit the box's hover color, so
 * they carry their own classes targeted directly. */
${P} .modern-bar-metric:hover .modern-bar-metric-label,
${P} .modern-bar-metric:hover .modern-bar-weather-icon,
${P} .modern-bar-metric:hover .modern-bar-metric-icon,
${P} .panel-button:hover .system-status-icon,
${P} .panel-button:focus .system-status-icon,
${P} .panel-button:checked .system-status-icon {
    color: ${p.deep};
}

${P} .panel-button:hover,
${P} .panel-button:focus,
${P} .panel-button:active,
${P} .panel-button:checked {
    color: ${p.deep};
}

${P} .clock-display:hover .clock,
${P} .clock-display:focus .clock,
${P} .clock-display:active .clock,
${P} .clock-display:checked .clock {
    color: ${p.deep} !important;
}

/* Alert — the opposing faction's color, and the ONLY place it appears. Must
 * WIN over the hover rule above (same specificity, defined after), so an
 * over-threshold metric never loses its alert by being pointed at. */
${P} .modern-bar-alert,
${P} .modern-bar-metric:hover .modern-bar-metric-label.modern-bar-alert {
    color: ${p.alert};
}
`;
}

// ── Per-palette: Quick Settings + calendar dropdowns ───────────────────────
function dropdownBlock(p) {
    const R = `.modern-bar-popups.modern-bar-${p.name}`;
    return `
/* ── ${p.name}: Quick Settings + calendar dropdowns (recolor only) ── */

${R} .quick-settings,
${R} .datemenu-popover {
    border: 1px solid ${rgba(p.deep, 0.20)};
    color: ${p.rest};
}

/* Raised "card" surfaces: QS sub-menus and the calendar's info cards. */
${R} .quick-toggle-menu,
${R} .datemenu-popover .events-button,
${R} .datemenu-popover .world-clocks-button,
${R} .datemenu-popover .weather-button,
${R} .message-list .message {
    background-color: ${rgba(p.deep, 0.05)};
    border: 1px solid ${rgba(p.deep, 0.12)};
    color: ${p.rest};
}

${R} .quick-toggle-menu:hover,
${R} .datemenu-popover .events-button:hover,
${R} .datemenu-popover .world-clocks-button:hover,
${R} .datemenu-popover .weather-button:hover,
${R} .message-list .message:hover {
    background-color: ${rgba(p.deep, 0.10)};
}

${R} .quick-toggle-menu:active,
${R} .datemenu-popover .events-button:active,
${R} .datemenu-popover .world-clocks-button:active,
${R} .datemenu-popover .weather-button:active,
${R} .message-list .message:active {
    background-color: ${rgba(p.deep, 0.16)};
}

/* Stacked notifications sit progressively deeper. */
${R} .message-list .message:second-in-stack {
    background-color: ${rgba(p.deep, 0.035)};
}
${R} .message-list .message:lower-in-stack {
    background-color: ${rgba(p.deep, 0.02)};
}

/* Interactive tiles — FILAMENT treatment.
 *
 * Rest carries NO fill and NO edge: an off toggle is the void with a label on
 * it. That is the whole idea — the previous pass washed every tile in
 * rgba(deep, 0.07), so ten pill tiles meant ten tinted slabs and the grid never
 * returned to the void. Design rule 8 says accent intensity scales inversely
 * with area; a resting wash is the largest-area accent in the whole theme.
 *
 * Feedback arrives only on interaction, and state is drawn as an EDGE, never a
 * slab (see the :checked block). This matches how the panel buttons already
 * behave (design rule 3: no highlight box in any state, the text powers up).
 *
 * Edges are inset box-shadows, never borders. A border would add to the box
 * and shift stock's centred content by its width — inset shadows draw inside
 * the existing geometry, which is what keeps this recolor-only.
 *
 * The calendar day cells are painted the surface grey by stock, so they're
 * neutralised in the calendar rules further down. */
${R} .quick-settings .quick-toggle,
${R} .quick-settings .icon-button,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button,
${R} .calendar .calendar-month-header .pager-button,
${R} .message-list-controls .message-list-clear-button,
${R} .message-list .message-close-button,
${R} .message-list .message-expand-button,
${R} .message-list .message-collapse-button {
    background-color: transparent;
    box-shadow: none;
    color: ${rgba(p.rest, 0.82)};
}

/* Hover is the only place a resting tile gains a fill, and it is deliberately
 * faint — enough to confirm the pointer is on a control (the tiles have no
 * resting edge to highlight), not enough to read as a slab. */
${R} .quick-settings .quick-toggle:hover,
${R} .quick-settings .icon-button:hover,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:hover,
${R} .calendar .calendar-month-header .pager-button:hover,
${R} .message-list-controls .message-list-clear-button:hover,
${R} .message-list .message-close-button:hover,
${R} .message-list .message-expand-button:hover,
${R} .message-list .message-collapse-button:hover {
    background-color: ${rgba(p.deep, 0.06)};
    color: ${p.deep};
}

${R} .quick-settings .quick-toggle:active,
${R} .quick-settings .icon-button:active,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:active,
${R} .calendar .calendar-month-header .pager-button:active,
${R} .message-list-controls .message-list-clear-button:active,
${R} .message-list .message-close-button:active,
${R} .message-list .message-expand-button:active,
${R} .message-list .message-collapse-button:active {
    background-color: ${rgba(p.deep, 0.11)};
    color: ${p.deep};
}

${R} .quick-settings .quick-toggle:insensitive,
${R} .quick-settings .icon-button:insensitive,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:insensitive,
${R} .message-list-controls .message-list-clear-button:insensitive,
${R} .datemenu-popover .events-button:insensitive {
    background-color: transparent;
    box-shadow: none;
    color: ${rgba(p.rest, 0.34)};
}

/* The "on" state — every one of these derives from -st-accent-color in stock,
 * so ALL must be restated or the missed ones keep the system accent.
 *
 * FILAMENT: no fill, state is a 2px lit ring on the pill edge plus deep text.
 * Full-saturation accent is fine here precisely because a hairline is a tiny
 * area (design rule 8) — the same colour across a 12em x 3.27em fill is the
 * wall of neon that rule exists to prevent. The ring reads as a circuit
 * carrying current, which is the thing being aimed at.
 *
 * ⚠ THE 4% WASH IS LOAD-BEARING, NOT DESIGN. St only PAINTS an inset
 * box-shadow when the node has a paintable background (or border): a fully
 * transparent background resolves the shadow but renders nothing. Found the
 * hard way on the first live test — every checked ring in the pane was
 * invisible, and the one ring that DID show was a focus ring, whose stock
 * rules happen to also set a background. Verified by pixel-probe
 * (tools/qspaint.js, 2026-07-29): four identical ring declarations, and only
 * the node with a background painted one. rgba(deep, 0.04) over the #04070d
 * void shifts each channel by ~2/255 — invisible, but it satisfies the paint
 * precondition. A border can't do this job: St borders add to the box and
 * would shift stock's centred content. DO NOT "clean up" the wash to
 * transparent; the ring goes with it.
 *
 * Text stays the DEEP accent, not the pale variant: pale sits a few points off
 * the resting colour and stops reading as a change at all. */
${R} .quick-settings .quick-toggle:checked,
${R} .quick-settings .quick-toggle:focus:checked,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:checked,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:checked:focus {
    background-color: ${rgba(p.deep, 0.04)};
    box-shadow: inset 0 0 0 2px ${rgba(p.deep, 0.85)};
    color: ${p.deep};
}

/* Hovering an already-on tile: the ring goes full strength and the faintest
 * wash appears, so on+hover is still distinguishable from on. */
${R} .quick-settings .quick-toggle:hover:checked,
${R} .quick-settings .quick-toggle:focus:hover:checked,
${R} .quick-settings .quick-toggle:active:checked,
${R} .quick-settings .quick-toggle:active:hover:checked,
${R} .quick-settings .quick-toggle:active:focus:checked,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:checked:hover,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:checked:focus:hover,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:checked:active,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:checked:active:hover,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:checked:active:focus {
    background-color: ${rgba(p.deep, 0.08)};
    box-shadow: inset 0 0 0 2px ${p.deep};
    color: ${p.deep};
}

/* SMALL indicators only — solid fill earns its place because the area is tiny
 * (a switch, a 1.6em header icon, the brightness pips). */
${R} .quick-settings .keyboard-brightness-level .button:checked,
${R} .quick-toggle-menu .header .icon.active,
${R} .quick-toggle-menu .toggle-switch:checked,
${R} .quick-toggle-menu .toggle-switch:checked:hover {
    background-color: ${p.bright};
    color: ${BG};
}

/* Child labels/icons don't repaint from the parent in every state. */
${R} .quick-settings .quick-toggle:checked .quick-toggle-title,
${R} .quick-settings .quick-toggle:checked .quick-toggle-icon {
    color: ${p.deep};
}
${R} .quick-settings .quick-toggle:checked .quick-toggle-subtitle {
    color: ${rgba(p.rest, 0.75)};
}

/* On but unavailable: the ring survives so state is still readable, dimmed to
 * match the text. (3% wash: same paint precondition as the checked block.) */
${R} .quick-settings .quick-toggle:insensitive:checked {
    background-color: ${rgba(p.deep, 0.03)};
    box-shadow: inset 0 0 0 2px ${rgba(p.deep, 0.28)};
    color: ${rgba(p.rest, 0.40)};
}

/* A has-menu pill is TWO actors in one rounded parent — ring the PARENT once
 * (per-half rings drew three stacked lines with the separator). Stock never
 * paints the parent AT ALL (it fills the halves), so without our wash the
 * parent has no background and the ring is skipped — this was exactly the
 * "Wired has no ring while Dark Style does" live bug. */
${R} .quick-settings .quick-toggle-has-menu:checked {
    background-color: ${rgba(p.deep, 0.04)};
    box-shadow: inset 0 0 0 2px ${rgba(p.deep, 0.85)};
}

${R} .quick-settings .quick-toggle-has-menu:checked .quick-toggle,
${R} .quick-settings .quick-toggle-has-menu:checked .quick-toggle-menu-button {
    box-shadow: none;
}

/* The divider between a has-menu pill's two halves. Dim at rest — with no tile
 * edges to relate to it would otherwise be the only line on an off tile. */
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-separator {
    background-color: ${rgba(p.rest, 0.16)};
}
${R} .quick-settings .quick-toggle-has-menu:checked .quick-toggle-separator {
    background-color: ${rgba(p.deep, 0.55)};
}

/* Sliders — the fill is an St-specific property, the handle is plain color.
 * Handle rests at the pale fill color and brightens to fore on hover. */
${R} .quick-settings .slider,
${R} .quick-toggle-menu .slider {
    color: ${p.bright};
    -barlevel-background-color: ${rgba(p.deep, 0.15)};
    -barlevel-active-background-color: ${p.bright};
}

${R} .quick-settings .slider:hover,
${R} .quick-toggle-menu .slider:hover {
    color: ${p.fore};
}

/* QS sub-menu internals. */
${R} .quick-toggle-menu .header .icon {
    background-color: ${rgba(p.deep, 0.12)};
    color: ${p.rest};
}

${R} .quick-toggle-menu .popup-menu-item {
    color: ${p.rest};
}

${R} .quick-toggle-menu .popup-menu-item:hover,
${R} .quick-toggle-menu .popup-menu-item:selected,
${R} .quick-toggle-menu .popup-menu-item:checked {
    background-color: ${rgba(p.deep, 0.14)};
    color: ${p.deep};
}

${R} .quick-toggle-menu .popup-menu-item:active {
    background-color: ${rgba(p.deep, 0.20)};
    color: ${p.deep};
}

${R} .quick-toggle-menu .popup-menu-item:insensitive,
${R} .quick-toggle-menu .device-subtitle {
    color: ${rgba(p.rest, 0.38)};
}

/* Calendar: month grid. Stock paints days/headings/month-label the SURFACE
 * grey, so they must go transparent or the grid tiles grey. */
${R} .calendar .calendar-day,
${R} .calendar .calendar-day-heading {
    background-color: transparent;
    color: ${p.rest};
}

${R} .calendar .calendar-month-header .calendar-month-label {
    background-color: transparent;
    color: ${p.fore} !important;
}

${R} .calendar .calendar-day:hover,
${R} .calendar .calendar-day-heading:hover {
    background-color: ${rgba(p.deep, 0.14)};
    color: ${p.deep};
}

${R} .calendar .calendar-day:selected,
${R} .calendar .calendar-day:active {
    background-color: ${rgba(p.deep, 0.22)};
    color: ${p.deep};
}

/* Today: the one solid DEEP surface in the dropdown (small area, and the user
 * liked it) — stock forces the text color !important, so we must too. */
${R} .calendar .calendar-day.calendar-today,
${R} .calendar .calendar-day.calendar-today:hover,
${R} .calendar .calendar-day.calendar-today:focus,
${R} .calendar .calendar-day.calendar-today:active,
${R} .calendar .calendar-day.calendar-today:selected {
    background-color: ${p.deep};
    color: ${BG} !important;
}

${R} .calendar .calendar-day.calendar-today:insensitive {
    background-color: ${rgba(p.deep, 0.45)};
    color: ${rgba(BG, 0.7)} !important;
}

${R} .calendar .calendar-day.calendar-weekend {
    color: ${rgba(p.rest, 0.62)};
}

${R} .calendar .calendar-day.calendar-other-month,
${R} .calendar .calendar-day.calendar-other-month.calendar-weekend {
    color: ${rgba(p.rest, 0.32)};
}

${R} .calendar .calendar-week-number {
    background-color: ${rgba(p.deep, 0.10)};
    color: ${rgba(p.rest, 0.55)};
}

/* Date header + secondary text. The today-button's RESTING state is
 * :insensitive (it only becomes reactive once you select another day). */
${R} .datemenu-today-button,
${R} .datemenu-today-button:insensitive {
    background-color: transparent;
    color: ${p.fore};
}

${R} .datemenu-today-button .day-label {
    color: ${p.rest};
}

${R} .datemenu-popover .events-title,
${R} .datemenu-popover .event-time,
${R} .datemenu-popover .event-placeholder,
${R} .datemenu-popover .world-clocks-header,
${R} .datemenu-popover .world-clocks-timezone,
${R} .datemenu-popover .weather-header,
${R} .message-list .message .message-header {
    color: ${rgba(p.rest, 0.58)};
}

${R} .datemenu-popover .world-clocks-header.no-world-clocks,
${R} .datemenu-popover .weather-header.no-location {
    color: ${p.fore};
}

${R} .datemenu-popover .event-summary,
${R} .datemenu-popover .world-clocks-city,
${R} .datemenu-popover .world-clocks-time,
${R} .datemenu-popover .weather-forecast-temp,
${R} .message-list .message .message-title {
    color: ${p.fore};
}

/* Notifications column. */
${R} .message-list:ltr {
    border-right-color: ${rgba(p.deep, 0.12)};
}
${R} .message-list:rtl {
    border-left-color: ${rgba(p.deep, 0.12)};
}

${R} .message-list .message-list-placeholder {
    color: ${rgba(p.rest, 0.40)};
}

${R} .message-list .url-highlighter {
    link-color: ${p.deep};
}

/* Overlay scrollbar — scoped so it can't touch scrollbars elsewhere. */
${R} .datemenu-popover StScrollBar > .vhandle,
${R} .datemenu-popover StScrollBar > .hhandle {
    background-color: ${rgba(p.deep, 0.25)};
}
${R} .datemenu-popover StScrollBar > .vhandle:hover,
${R} .datemenu-popover StScrollBar > .hhandle:hover {
    background-color: ${rgba(p.deep, 0.40)};
}

/* Focus rings — stock declares all of these inset+!important on the tile
 * EDGE; any one left un-restated is exactly the accent edge-bleed bug. */
${R} .quick-settings .quick-toggle:focus,
${R} .quick-settings .quick-toggle:focus:checked,
${R} .quick-settings .icon-button:focus,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:focus,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:checked:focus,
${R} .quick-settings .quick-slider .slider-bin:focus,
${R} .quick-toggle-menu:focus,
${R} .quick-toggle-menu .popup-menu-item:focus,
${R} .calendar:focus,
${R} .calendar .calendar-day:focus,
${R} .calendar .calendar-day.calendar-today:focus,
${R} .calendar .calendar-day-heading:focus,
${R} .calendar .calendar-month-header .pager-button:focus,
${R} .calendar .calendar-month-header .calendar-month-label:focus,
${R} .datemenu-today-button:focus,
${R} .datemenu-popover .events-button:focus,
${R} .datemenu-popover .world-clocks-button:focus,
${R} .datemenu-popover .weather-button:focus,
${R} .message-list .message:focus,
${R} .message-list .message-close-button:focus,
${R} .message-list .message-expand-button:focus,
${R} .message-list .message-collapse-button:focus,
${R} .message-list-controls .message-list-clear-button:focus {
    box-shadow: inset 0 0 0 2px ${rgba(p.deep, 0.80)} !important;
}

/* Paint-wash for focus rings on VOID-RESTING controls. Same St precondition
 * as the checked block: an inset shadow is only painted over a paintable
 * background, and filament leaves these controls fully transparent at rest —
 * so a keyboard-focus ring on them would silently not render, which is an
 * accessibility failure ("focus rings must stay unmistakable", design rules).
 * Deliberately EXCLUDES the nodes that already have real backgrounds — the
 * cards (events/world-clocks/weather/message, .quick-toggle-menu) and the
 * calendar today-circle — where this wash would REPLACE a stronger fill. */
${R} .quick-settings .quick-toggle:focus,
${R} .quick-settings .icon-button:focus,
${R} .quick-settings .quick-toggle-has-menu .quick-toggle-menu-button:focus,
${R} .quick-settings .quick-slider .slider-bin:focus,
${R} .quick-toggle-menu .popup-menu-item:focus,
${R} .calendar:focus,
${R} .calendar .calendar-day:focus,
${R} .calendar .calendar-day-heading:focus,
${R} .calendar .calendar-month-header .pager-button:focus,
${R} .calendar .calendar-month-header .calendar-month-label:focus,
${R} .datemenu-today-button:focus,
${R} .message-list .message-close-button:focus,
${R} .message-list .message-expand-button:focus,
${R} .message-list .message-collapse-button:focus,
${R} .message-list-controls .message-list-clear-button:focus {
    background-color: ${rgba(p.deep, 0.04)};
}
`;
}

// ── Per-palette: our own metric dropdowns ───────────────────────────────────
function metricPopupBlock(p) {
    const R = `.modern-bar-popups.modern-bar-${p.name} .modern-bar-popup`;
    return `
/* ── ${p.name}: metric dropdowns (our widgets) ── */

${R} .popup-menu-content {
    border: 1px solid ${rgba(p.deep, 0.20)};
}

${R} .modern-bar-popup-content {
    color: ${p.rest};
}

${R} .modern-bar-popup-header {
    color: ${p.deep};
}

${R} .modern-bar-popup-name {
    color: ${p.rest};
}

${R} .modern-bar-popup-value {
    color: ${p.fore};
}

${R} .modern-bar-popup-meter {
    background-color: ${rgba(p.deep, 0.14)};
}

${R} .modern-bar-popup-meter-fill {
    background-color: ${p.bright};
}

${R} .modern-bar-popup-meter-alert {
    background-color: ${p.alert};
}

${R} .modern-bar-popup-value.modern-bar-alert {
    color: ${p.alert};
}

${R} .modern-bar-popup-icon {
    color: ${p.rest};
}

/* Tail (chance of rain): deliberately DIMMER than the value it trails. It is
 * supplementary — a row without it is the normal case, and it must not pull the
 * eye off the temperatures. */
${R} .modern-bar-popup-tail-icon,
${R} .modern-bar-popup-tail {
    color: ${rgba(p.rest, 0.65)};
}

${R} .modern-bar-popup-caption {
    color: ${rgba(p.rest, 0.50)};
}

${R} .modern-bar-popup-separator {
    background-color: ${rgba(p.deep, 0.15)};
}
`;
}

// ── palette-preview.html (dev-only eyeball page) ────────────────────────────
// One row per faction: a mock panel strip, a mock metric popup, and the raw
// ladder. Not pixel-faithful to St — it exists to judge HUES side by side
// without a logout. Real ground truth is tools/theme-probe.js.
function previewHtml() {
    const rows = PALETTES.map(p => `
  <section class="row">
    <header>
      <h2 style="color:${p.deep}">${p.label}</h2>
      <p class="lore">${p.lore} · alert ${p.alert === COLD ? 'cold blue' : 'ember'}</p>
    </header>
    <div class="panel">
      <span style="color:${p.rest}">▣ 12%</span>
      <span style="color:${p.rest}">▤ 38%</span>
      <span style="color:${p.deep}">☀ 72°F</span>
      <span style="color:${p.alert}">◍ 91%</span>
      <span class="clock" style="color:${p.rest}">10:58:24 AM</span>
      <span style="color:${p.rest}">▂▄▆</span>
    </div>
    <div class="cards">
      <div class="popup" style="border-color:${rgba(p.deep, 0.20)}">
        <div class="hdr" style="color:${p.deep}">WORKDAY</div>
        <div class="line"><span style="color:${p.rest}">09:00 – 17:00</span>
          <b style="color:${p.fore}">38%</b></div>
        <div class="trough" style="background:${rgba(p.deep, 0.14)}">
          <div class="fill" style="width:38%;background:${p.bright}"></div></div>
        <div class="cap" style="color:${rgba(p.rest, 0.5)}">4h 58m left</div>
        <div class="line"><span style="color:${p.rest}">Memory</span>
          <b style="color:${p.alert}">93%</b></div>
        <div class="trough" style="background:${rgba(p.deep, 0.14)}">
          <div class="fill" style="width:93%;background:${p.alert}"></div></div>
      </div>
      <div class="popup" style="border-color:${rgba(p.deep, 0.20)}">
        <div class="tile" style="background:${rgba(p.bright, 0.13)};
          box-shadow:inset 0 0 0 2px ${rgba(p.bright, 0.45)};color:${p.deep}">Wi-Fi · on</div>
        <div class="tile" style="background:${rgba(p.deep, 0.07)};color:${p.rest}">Bluetooth</div>
        <div class="today" style="background:${p.deep};color:${BG}">28</div>
      </div>
      <div class="ladder">${['rest', 'bright', 'deep', 'fore', 'alert'].map(r =>
        `<div><i style="background:${p[r]}"></i><span>${r} ${p[r]}</span></div>`).join('')}
      </div>
    </div>
  </section>`).join('\n');

    return `<!-- GENERATED by build/gen-stylesheet.js — regenerate, don't edit -->
<meta charset="utf-8">
<title>modern-bar circuit palettes</title>
<style>
  body { background:${BG}; color:#dff2f7; font-family:"JetBrains Mono",monospace;
         margin:0; padding:28px 32px; }
  h1 { font-size:13px; font-weight:700; letter-spacing:.2em; margin:0 0 4px; }
  .sub { font-size:10px; opacity:.45; margin:0 0 26px; }
  .row { margin-bottom:26px; }
  .row header { display:flex; align-items:baseline; gap:12px; }
  h2 { font-size:12px; letter-spacing:.15em; text-transform:uppercase; margin:0; }
  .lore { font-size:10px; opacity:.55; margin:0; }
  .panel { background:${BG}; border:1px solid rgba(255,255,255,.06);
           padding:6px 14px; margin:8px 0; font-size:12px;
           display:flex; gap:18px; align-items:center; }
  .clock { margin-left:auto; }
  .cards { display:flex; gap:14px; align-items:flex-start; }
  .popup { background:${BG}; border:1px solid; padding:12px 14px; width:210px;
           font-size:11px; }
  .hdr { font-size:9px; font-weight:700; letter-spacing:.12em; margin-bottom:8px; }
  .line { display:flex; justify-content:space-between; margin-top:6px; }
  .trough { height:3px; margin-top:4px; } .fill { height:3px; }
  .cap { font-size:9px; margin-top:4px; }
  .tile { border-radius:999px; padding:7px 12px; margin-bottom:8px; font-size:10.5px; }
  .today { width:26px; height:26px; border-radius:50%; display:flex;
           align-items:center; justify-content:center; font-size:11px;
           font-weight:700; margin-top:10px; }
  .ladder { font-size:10px; }
  .ladder div { display:flex; align-items:center; gap:8px; margin-bottom:5px; }
  .ladder i { width:26px; height:13px; display:inline-block; }
  .ladder span { opacity:.6; }
</style>
<h1>MODERN-BAR · CIRCUIT PALETTES</h1>
<p class="sub">one shared void ${BG} · seven canon circuit colors · alerts are the opposing faction</p>
${rows}
`;
}

// ── Emit ────────────────────────────────────────────────────────────────────

// `--list` prints the palette roster as JSON (name/label/lore) — prefs.js and
// probes are hand-written against the schema, but this keeps a scriptable
// cross-check that all three agree (workflow/CI use).
if (ARGV.includes('--list')) {
    print(JSON.stringify(PALETTES.map(({name, label, lore}) => ({name, label, lore}))));
    System.exit(0);
}

checkSchemaRoster();
validate();

let css = header() + sharedBlock();
css += `
/* ═══ 2. CIRCUIT PALETTES ═══════════════════════════════════════════════════
 * One block per canon palette, generated from the same template — selector
 * sets are IDENTICAL across palettes by construction. The palette class goes
 * on BOTH #panel and Main.uiGroup (popups are siblings of panelBox, so one
 * node can never cover both — see extension.js). */
`;
for (const p of PALETTES)
    css += panelBlock(p) + dropdownBlock(p) + metricPopupBlock(p);

const sheetPath = GLib.build_filenamev([ROOT, 'stylesheet.css']);
GLib.file_set_contents(sheetPath, css);
print(`wrote ${sheetPath} (${css.split('\n').length} lines, ${PALETTES.length} palettes)`);

const previewPath = GLib.build_filenamev([ROOT, 'tools', 'palette-preview.html']);
GLib.file_set_contents(previewPath, previewHtml());
print(`wrote ${previewPath}`);
