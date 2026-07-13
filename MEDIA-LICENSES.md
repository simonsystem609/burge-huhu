# Media licenses

The [MIT license](LICENSE) at the root of this repo covers the source code
only. Image assets under `public/` are licensed individually, as follows.

## Hungarian card deck — `public/cards_img/*.png`

Cropped from two historical photo/engraving sources, one CC BY-SA 4.0 and one
public domain. Full source, author, and modification details:
[`public/cards_img/CREDIT.txt`](public/cards_img/CREDIT.txt).

## Royal Game of Ur board — `public/ur/board-source.png`

Original artwork created by the project author (ecsedyadam), 2026.
Licensed under the MIT License (same terms as the code — see [LICENSE](LICENSE)).

## PWA icons — `public/icons/*.png`

`apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `maskable-512.png`. Procedurally
generated (no external image inputs) by [`scripts/make-icons.js`](scripts/make-icons.js) —
a dark-felt background, a drawn white playing card, and a drawn red heart pip, composited
by a small from-scratch PNG encoder. Original project asset; licensed MIT, same as the code.

## Not shipped, not deployed

`promptimages/download.png` (an annotated development screenshot) and `deepseek.md` (a
stale handoff note for an earlier development pass) are tracked in the repo for history
but are not copied into the Docker image or referenced by any served page. The screenshot
incidentally shows the Hungarian card deck art credited above; no separate license applies
beyond that. Neither file is required for the app to run.
