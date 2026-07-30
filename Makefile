# modern-bar — build/packaging helpers
#
# The repo doubles as the live extension via a symlink, so day-to-day there is
# nothing to build except the compiled GSettings schema. `pack` produces the
# zip extensions.gnome.org wants: core files and schemas/ are included
# automatically; everything else must be named — which is also what keeps the
# dev-only files (tools/, CLAUDE.md, test_gnome.sh) out of the upload.

UUID = modernbar@gdesh.com
ZIP  = $(UUID).shell-extension.zip

.PHONY: schemas stylesheet pot pack install clean

# Compile the schema in place — needed for the symlink dev setup after any
# .gschema.xml change. (The packed zip ships only the .xml — correct for
# GNOME 44+: the installer runs glib-compile-schemas itself at install time.)
schemas:
	glib-compile-schemas --strict schemas/

# Regenerate stylesheet.css (a COMMITTED build artifact — never hand-edit it)
# and tools/palette-preview.html from the palette table in the generator.
# Validates contrast floors; fails loudly if a palette goes unreadable.
stylesheet:
	gjs -m build/gen-stylesheet.js

# Regenerate the translation template after user-visible string changes.
# All translatable strings live in prefs.js (the shell-side popups are not
# gettext-wrapped yet). Needs the gettext package installed.
pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
		--package-name="Modern Bar" --package-version="0.4.0" \
		--msgid-bugs-address="https://github.com/gdeshmukh/modern-bar/issues" \
		--copyright-holder="Gaurav Deshmukh" \
		--output=po/modernbar.pot prefs.js
	sed -i 's/charset=CHARSET/charset=UTF-8/' po/modernbar.pot

# stylesheet is a dependency so an edited palette table can never ship stale.
# --podir compiles any po/<lang>.po into locale/ inside the zip (the .pot
# template itself is never packed — e.g.o. forbids shipping .po/.pot files).
pack: schemas stylesheet
	gnome-extensions pack --force \
		--extra-source=lib \
		--extra-source=icons \
		--extra-source=LICENSE \
		--podir=po \
		.

install: pack
	gnome-extensions install --force $(ZIP)

clean:
	rm -f $(ZIP)
