# Placing fields on the page

Positions are percent of the page, measured from its **top-left** corner:
`x` and `y` are where the box starts (0–100), `width` is 1–50 and `height` is 1–20.

## Presets

| Preset | x | y | width | height | Where |
|---|---|---|---|---|---|
| `signature_bottom_left` | 15 | 85 | 25 | 8 | bottom left |
| `signature_bottom_center` | 37.5 | 85 | 25 | 8 | bottom centre |
| `signature_bottom_right` | 55 | 85 | 25 | 8 | bottom right |
| `date_after_signature` | 55 | 93 | 20 | 5 | under `signature_bottom_right` |
| `signature_footer` | 60 | 90 | 30 | 6 | in the footer, right |

Presets are only positions: any field type can use any preset.

## Putting a field on a signature line

1. Find the page and the line. Look at the PDF, or, if `pdftotext` (from Poppler) is
   installed, list every word with its box:

   ```bash
   pdftotext -bbox-layout -f 2 -l 2 letter.pdf -
   ```

   The output gives the page `width` and `height` in points, and `xMin yMin xMax yMax`
   for each word, also measured from the top-left.

2. Convert to percent: `x = xMin / width * 100`, `y = yMin / height * 100`.

3. `pdftotext` lists words, not drawn lines, so find the line through the label next to it.
   A signature sits **above** its line, so the box should **end** on the line:
   - Label **under** the line (a small "Signature" caption): the line is just above the
     label. Put the bottom of the box at the label's top, a little higher: `y = label y - height - 1`.
   - Label **left of** the line ("Signature: ________"): start the box just after the label,
     `x = label xMax / width * 100`, with its bottom on the label's baseline:
     `y = label yMax / height * 100 - height`.
   - Label **above** the line ("Client signature" with the line below it): put the box
     under the label, `y = label yMax / height * 100`.

   Typical sizes, in percent:
   - `signature_date` or `signature`: width 25–30, height 6–8
   - `signed_datetime` or `date`: width 18–22, height 4–5

4. Keep `x + width` and `y + height` at most 100, so the box stays on the page.

Example: on a Letter page (612 × 792 points) a caption "Signature" under the line has
`xMin 72` and `yMin 619.5`. That gives `x = 72 / 612 * 100 = 11.8` and
`619.5 / 792 * 100 = 78.2`, so with `height 7`, `y = 78.2 - 7 - 1 = 70.2`:
`{ "x": 11.8, "y": 70.2, "width": 30, "height": 7 }`.

When unsure, prefer a preset and tell the user where it will appear.
After a send, the user can see exactly where each field landed by opening the envelope
in their dashboard. They should not open the signer's link.
