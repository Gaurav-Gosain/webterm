# capture

Generates the figures in `docs/images` that show the terminal: the preset
gallery, the framed btop session, the kitty graphics placement and the light
frame. `../banner/` generates the header separately.

```sh
npm run build
node capture.mjs            # every shot
node capture.mjs kitty tabs # named shots only
```

`WEBTERM_CAPTURE_DEBUG=1` traces both directions of the pty bridge, which is
how you find out why a program refused to draw. `WEBTERM_CHROMIUM` overrides
the browser path.

## What is real in these images

All of it, which is the constraint the script is built around.

`fixture.html` imports the built bundle from `dist`, so an asset cannot show a
feature that only exists in `src`. Every terminal is a real `WebTerm`. Every
character on screen is the output of a real program run on a real pty, either
bridged live or recorded a moment earlier and replayed; nothing is typed out by
hand into a mock. The image in the graphics shot is the byte stream `kitten
icat` transmitted after webterm answered its `a=q` capability probe, and the
shot fails rather than saves if the overlay ends up with no placement in it.

The pty comes from util-linux `script`, because node has no pty in core and this
package has no native dependency. The bridge is bidirectional: the program's
output goes to the browser and the terminal's replies go back into the pty,
which is the only reason a capability probe gets answered at all.

## The one thing handed in from outside

`kitten icat` is passed `--use-window-size`. webterm answers neither `CSI 14 t`
nor `CSI 16 t`, so icat cannot discover the cell geometry and refuses to send
anything without it. That is a real gap, written up in
[../../docs/limits.md](../../docs/limits.md), and the README says so where it
mentions icat. Everything after the geometry is genuine.

## Reproducibility

The banner is byte-identical between runs. These are not: they contain a clock,
live CPU and memory figures, and file mtimes. What is stable is the layout, the
sizes and what is being demonstrated.

Every process the script starts, the file server and the browser and each pty,
is closed in a `finally`, on the failure path as well as the success path.
