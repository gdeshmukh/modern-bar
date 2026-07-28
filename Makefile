# modern-bar — build/packaging helpers
#
# The repo doubles as the live extension via a symlink, so day-to-day there is
# nothing to build except the compiled GSettings schema. `pack` produces the
# zip extensions.gnome.org wants: core files and schemas/ are included
# automatically; everything else must be named — which is also what keeps the
# dev-only files (tools/, CLAUDE.md, test_gnome.sh) out of the upload.

UUID = modernbar@gdesh.com
ZIP  = $(UUID).shell-extension.zip

.PHONY: schemas stylesheet pack install clean

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

# stylesheet is a dependency so an edited palette table can never ship stale.
pack: schemas stylesheet
	gnome-extensions pack --force \
		--extra-source=lib \
		--extra-source=icons \
		.

install: pack
	gnome-extensions install --force $(ZIP)

clean:
	rm -f $(ZIP)
