# Optional README artwork: ChatGPT Go prompts

These images are **decorative only**. The README works without them and does not reference them until a team member adds one. Architecture diagrams and metric charts stay source-controlled (Mermaid, and `make_charts.py` SVGs), never generated images.

If you add an image, save it as `docs/assets/readme/hero.png` and insert it directly under the README title:

```html
<img src="docs/assets/readme/hero.png" alt="" width="100%">
```

Use an empty `alt=""` because the image is decorative.

Rules for every image:
- no text, letters, numbers, logos or user-interface chrome;
- no medical devices, people, syringes or hospital scenes;
- no charts that could be mistaken for results.

---

## 1. Hero banner (16:5)

```
Wide 16:5 banner for a digital-health research project about glucose forecasting. Abstract and minimal: a single smooth,
luminous signal line flowing left to right across a deep navy field, with dots evenly spaced along the left half (past readings),
then continuing to the right as one confident line surrounded by soft, translucent widening bands that suggest uncertainty about
the future. A thin, subtle horizontal threshold line crosses the right side. Refined palette: deep navy background (#0f1f33),
teal signal (#14a3a3), soft white highlights, one restrained warm accent (#e0a33a) where the line nears the threshold.
Generous negative space on the left third for a title to be overlaid later. Precise, calm, scientific, premium editorial
style; subtle grain; no text, no letters, no numbers, no axes, no logos, no medical equipment, no people, no hearts, no DNA.
```

## 2. Section divider (16:2, optional)

```
Very wide 16:2 decorative strip: a fine teal line on a near-white background (#f7f9fa) that gently rises and settles,
with a faint navy shadow line slightly offset beneath it, suggesting a model tracking a measured signal. Minimal, crisp,
lots of white space, hairline weight, editorial scientific style. No text, numbers, axes, grid, icons or logos.
```

## 3. Social preview card (2:1, optional; for the GitHub repository settings, not the README)

```
2:1 social card: deep navy background (#0f1f33) with one elegant teal signal curve, dotted on the left and a soft
translucent band on the right, and a thin warm amber threshold line. Clean, centred composition with empty space at the top
for a title added later in an editor. Premium digital-health aesthetic, restrained, precise. No text, letters, numbers,
logos, devices or people.
```

After generating, check the image at full size for stray glyphs or pseudo-text, and regenerate if any appear.
