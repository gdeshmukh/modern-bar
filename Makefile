# Build, package, and install the extension.

UUID = modernbar@gdesh.com
ZIP  = $(UUID).shell-extension.zip

.PHONY: schemas stylesheet pot pack install clean

# The live symlink needs compiled schemas; packaged installs compile the XML.
schemas:
	glib-compile-schemas --strict schemas/

# Regenerate committed CSS and validate palette contrast.
stylesheet:
	gjs -m build/gen-stylesheet.js

# Extract translatable preferences strings; requires gettext.
pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ \
		--package-name="Modern Bar" --package-version="0.4.0" \
		--msgid-bugs-address="https://github.com/gdeshmukh/modern-bar/issues" \
		--copyright-holder="Gaurav Deshmukh" \
		--output=po/modernbar.pot prefs.js
	sed -i 's/charset=CHARSET/charset=UTF-8/' po/modernbar.pot

# Rebuild CSS before packaging; --podir compiles translations without the .pot.
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
