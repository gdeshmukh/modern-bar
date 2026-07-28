# modern-bar — build/packaging helpers
#
# The repo doubles as the live extension via a symlink, so day-to-day there is
# nothing to build except the compiled GSettings schema. `pack` produces the
# zip extensions.gnome.org wants: core files and schemas/ are included
# automatically; everything else must be named — which is also what keeps the
# dev-only files (tools/, CLAUDE.md, test_gnome.sh) out of the upload.

UUID = modernbar@gdesh.com
ZIP  = $(UUID).shell-extension.zip

.PHONY: schemas pack install clean

# Compile the schema in place — needed for the symlink dev setup after any
# .gschema.xml change (`pack` runs its own compile inside the zip).
schemas:
	glib-compile-schemas --strict schemas/

pack: schemas
	gnome-extensions pack --force \
		--extra-source=lib \
		--extra-source=icons \
		.

install: pack
	gnome-extensions install --force $(ZIP)

clean:
	rm -f $(ZIP)
