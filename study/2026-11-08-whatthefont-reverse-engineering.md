# WhatTheFont, reverse engineered

Date: 2026-11-08. Question: how does WhatTheFont identify a font from an image, and how can our checker do the same thing? This study covers the technique, the open source equivalents, and a design for our tool. No fonts were downloaded for this study. No accounts were created.

## 1. What WhatTheFont does, end to end

WhatTheFont is Monotype's font finder, on the MyFonts site and as an iOS and Android app. The current version works like this.

1. Upload. The user uploads a PNG or JPG (up to 5 MB, at least 50 by 50 pixels), pastes an image URL, or takes a photo. The text must be horizontal, in Latin letters, and clearly visible.
2. Find the text. The tool detects text in the image on its own and boxes each line. The user clicks the line they care about, or drags the crop box to a single line. One image can hold more than one font, and each line is matched on its own.
3. Match. A deep learning model (a neural network, a program that learns patterns from examples) reads the cropped line and ranks the fonts in the MyFonts catalog by how likely each one is.
4. Results. The tool returns a ranked list of font names with a preview of each one, set in the same text. Each result links to the font on MyFonts, where it can be bought and licensed.

That is the whole public flow. The matching step is server side. Monotype has never published the model weights, the training code, or the exact network layout. What follows in section 3 is what Monotype and its engineers have said in public.

Sources: Monotype's help page on using WhatTheFont (https://support.monotype.com/en/articles/7861298-using-whatthefont), MyFonts' WhatTheFont page via IONOS (https://www.ionos.ca/digitalguide/websites/web-design/web-app-of-the-week-whatthefont/).

## 2. The old version, and why it changed

WhatTheFont launched in 2009. The first version worked very differently.

The user had to pick out key letters by hand. The system then matched the vector outlines of those letters (the mathematical curves that define each letter shape) against every font in the database, one by one. Monotype's research director Sampo Kaasila called this "brute force". It was slow, it needed clean images and manual work, and it was weak on connected or italic letters, where letters join or slant and cannot be cut apart cleanly.

In 2017 Monotype rebuilt the backend as WhatTheFont2. The new version uses a neural network and removes almost all manual steps. The network finds the text itself, and it can identify a font from a very short sample. The designer of the new version, Seah Chickering-Burchesky, writes that the neural network "looks at an image, detects the text, and is able to identify the font used from even a very short sample".

Sources: https://www.seahcb.com/work/whatthefont, https://www.fastcompany.com/90149756/this-app-uses-machine-learning-to-identify-esoteric-fonts.

## 3. The model, as far as Monotype has described it

Monotype has said the following in public, in its own article on AI in the creative industry and in interviews.

- The network is 50 layers deep. (A layer is one processing step; deeper networks can learn finer details, such as the difference between two similar sans serifs.)
- It was trained on 250 images per font, for 133,000 fonts, a total of 33 million images.
- The team built a data augmentation and distortion pipeline. (Augmentation means making extra training copies by changing each image a little, so the model learns to cope with real world mess.) The pipeline simulated shaky hands, strange perspective, and other photographic interference.
- Accuracy is over 90 percent, according to Kaasila. Errors come mostly from poor quality photos and from text with only a handful of characters.
- The new version is much better than the old one at connected and italic fonts, and at finding more than one font in a single image.

What Monotype has not said: the exact network family, the input image size, the loss function, the training time, or how the final ranking score is computed. Any write-up that gives precise internals (one SEO article claims "217 invariant features per glyph" hashed into a "128-bit signature") does not match any primary source and should not be trusted. The primary sources agree on the deep learning account above and disagree with that article.

Sources: https://www.monotype.com/resources/expertise/ai-creative-industry, https://www.fastcompany.com/90149756/this-app-uses-machine-learning-to-identify-esoteric-fonts, https://hyperallergic.com/shazam-for-typefaces-whatthefont/.

## 4. What WhatTheFont cannot do

- It can only name fonts in the MyFonts catalog. At launch that was about 133,000 fonts. The catalog is now over 300,000 fonts, and the tool draws on more than 230,000 styles. A font outside the catalog will never be named. The tool returns the closest lookalike instead, with no flag that says "this is not the real font".
- It needs Latin text. Japanese, Chinese, and other non-Latin scripts are not supported.
- Short text hurts. A single letter or two gives the model little to work with. The "October 2025" title (13 characters) is a good sample. The "EL FASHER" label (9 characters plus a space) is usable. A two-letter label would be weak.
- Low resolution, blur, heavy compression, and perspective distortion hurt. Our reference frames are YouTube screenshots, which carry compression artifacts and a 4 percent vertical stretch from the player. Expect lower confidence than on a clean photo.
- It does not prove identity. It ranks by visual similarity. A close result can be a different font that looks nearly the same at small sizes.

## 5. DeepFont, the paper behind the idea

The academic version of this problem is called Visual Font Recognition. The key paper is DeepFont, by Wang and others at Adobe Research and the University of Illinois, published at ACM Multimedia 2015.

Paper: https://arxiv.org/abs/1507.03196, full text at https://ar5iv.labs.arxiv.org/html/1507.03196.

### The dataset

The team built the AdobeVFR dataset, the first large font recognition dataset with both synthetic and real images.

- 2,383 font classes.
- 2,383,000 synthetic training images (1,000 rendered examples per font), plus 238,300 synthetic validation images.
- 4,384 real world test images with labels checked by experts, covering 617 of the classes. Each was cropped tight and scaled to 105 pixels tall.
- 197,396 unlabeled real world images, used for training without labels.

### The core problem: synthetic and real images look different

It is easy to render unlimited training images from font files. It is hard to collect labeled photos of real text. But a model trained only on clean renders fails on photos, because real text has different spacing, stretched aspect ratios, blur, noise, perspective, cluttered backgrounds, and compression. The paper calls this the domain mismatch.

DeepFont attacks it in two ways.

First, augmentation. Before training, each synthetic image is changed in six ways: Gaussian noise, Gaussian blur, a random affine warp (a slant or perspective change), a shading gradient, variable character spacing (drawn from a bell curve with mean 10 pixels and spread 40, clipped to 0 to 50), and variable aspect ratio (the image is squeezed in width by a random factor between 5/6 and 7/6). The last two matter most, because designers stretch and re-space text freely.

Second, a split network. The network is an 8 layer convolutional network (a network that scans an image for local patterns such as edges and curves). It is split into two parts. The lower part (the first 2 layers) learns features shared by both synthetic and real images. It is trained without labels, using a Stacked Convolutional Auto-Encoder (an auto-encoder is a network trained to copy its input, which forces it to learn the important visual structure). The upper part (the remaining 6 layers) is the classifier, trained with labels on synthetic images only. The idea is that the lower layers learn what text looks like in general, and the upper layers learn which font a shape belongs to.

### Testing

At test time, each image is scaled to 105 pixels tall, squeezed to three different widths, and five 105 by 105 patches are cut from each version. That gives 15 patches. Each patch goes through the network, and the 15 answers are averaged. (The network's output is a probability for each font class; averaging steadies the result.)

### Results

Top-5 accuracy over 80 percent on the real world test set. Top-5 means the correct font is in the model's top five guesses. The team also compressed the model to about one sixth of its size with almost no accuracy loss, by forcing weight matrices to be low rank during training. Training took about one day on a workstation with one GTX680 graphics card.

### Why this paper matters to us

DeepFont is the public recipe for the whole approach. WhatTheFont's own model is private, but it solves the same problem with the same ingredients: a large rendered training set, heavy augmentation, and a convolutional network. The paper also proves two facts we will use: you do not need character segmentation (cutting the text into single letters first), and you do not need to know what the text says. The network reads the shapes, not the words.

## 6. Open source routes

There is no public copy of WhatTheFont's model or of Adobe's DeepFont weights. The open routes fall into three groups: small neural reimplementations, template matching (render and compare), and new on-device matchers.

### A. Neural reimplementations of DeepFont

artset/WhatTheFont (https://github.com/artset/WhatTheFont). A TensorFlow reimplementation of DeepFont, with a modified DeepFont model and an autoencoder. Input is 96 by 96 pixel patches. It covers 150 font classes, not 2,383, and it uses its own trained weights. Status: a student project, last updated 2023. It works as a demo of the method. It is not a drop-in font identifier for our catalog, because it only knows 150 fonts and would need retraining to know more. License: check the repo before use.

robinreni96/Font_Recognition-DeepFont (https://github.com/robinreni96/Font_Recognition-DeepFont). A Keras reimplementation of DeepFont. It builds a custom synthetic dataset with a text image generator instead of using the AdobeVFR data, which is large and hard to obtain. Status: prototype quality, several forks exist, none is a maintained product. Good as a reference for the training pipeline, not as a tool to run as is.

Verdict on this group: the code exists, but no public project ships a trained model that knows thousands of fonts. Retraining on our own catalog is the real work, and it needs a GPU and days, not minutes.

### B. Template matching: render the candidates and compare shapes

This is the oldest approach and the simplest to build. It needs no training and no GPU. It works like this: take the cropped text from the reference frame, read the text string from the scene file (we already know what the label says), render the same string in each candidate font at the same size, and compare the shapes pixel by pixel. The best match wins.

fontident (https://pypi.org/project/fontident/0.1.0/, version 0.1.0, September 2026). A Python library, command line tool, web API, and web app. Its offline mode binarizes the image (turns it into pure black and white pixels), splits it into single letters, renders each candidate font from a local catalog, and compares glyph shapes with normalized cross-correlation (a score from minus 1 to 1 that measures how well two images line up, ignoring overall brightness). If the offline score is too low, it can fall back to WhatTheFont or Adobe online. It also reads exact font names from document files (Word, PDF) when they are embedded. Status: very new, version 0.1.0. License: not confirmed from the listing; check before use. This is the closest public match to what our checker needs, and its offline matcher is the design to copy.

Intellifont (https://github.com/magic-emperor/Intellifont, Apache 2.0). A font similarity engine for Node.js, written in Rust. Pipeline: binarize, deskew (straighten tilted text), extract text regions, compute pixel metrics (density, symmetry, stroke width, serifs), then compare 64 by 64 thumbnails against 2,042 fonts. It claims 92 percent top-1 accuracy on clean text images and 95 percent on font files. It runs fully offline and ships as an npm package (intellifont-engine). Status: actively presented as a product; the accuracy claims are the author's own, not independently checked. License is Apache 2.0, which is permissive.

fontfinderAI (https://github.com/puvy123/fontfinderAI). A full stack web app that finds the closest Google Font from an image. It scores candidates on category, weight, width, style, geometry, and OCR compatibility, each with a fixed weight. Status: new (September 2026). Its scoring is mostly metadata and rough geometry, not fine glyph shape matching, so it is weaker evidence than fontident or Intellifont. Useful as a reference for the Google Fonts matching path.

### C. On-device neural matchers

typeye (https://typeye.com/, launched November 2026). A font finder that runs entirely in the browser on WebGPU, with a WebAssembly fallback. It ships a 1.4 MB matcher and the full Google Fonts catalog: 2,004 families, 102,726 faces. The flow is the same as ours would be: split the glyphs, normalize height and weight, compare shapes against the catalog, rank the results, then re-render the user's own word in each shortlisted font and score again. Reported accuracy: 93 percent top-5 on rendered text; on photos, top-1 goes from 26 percent to 44 percent after the re-rank step. Images never leave the tab. Identification is free and unlimited; paid plans add support. The catalog is open license only. Commercial fonts such as Helvetica or Gotham are not in it, and the site says so plainly. This is the most modern open route, and the most honest about its limits. It is a product, not a code library, so reusing its model inside our checker would need its permission or its API.

### WhatFontIs, for completeness

WhatFontIs (https://es.whatfontis.com/) is the largest commercial alternative. It matches glyph shapes against more than 1,200,000 fonts, free and commercial, and returns an exact match or more than 60 similar fonts. It separates letters automatically and has a manual editor for connected scripts. Free plan is 5 identifications a day; PRO is unlimited. It is not open source. It is useful as a second opinion when the real font is commercial and no open font matches well.

## 7. Design: font identification for our checker

### The concrete use

A reference frame holds text we need to copy. In the Seg4 opening, that is the "October 2025" title (13 characters, cap height 133 pixels) and the "SUDAN" and "EL FASHER" labels (5 and 9 characters). Today the scene guesses Montserrat Bold for the title and Anton for EL FASHER, from width and cap height ratios. The checker should name the real font instead.

### What we already have

The checker already finds text boxes. src/checker/text.py has ink_box (finds the box of the ink inside a rectangle, using Otsu thresholding, which picks the brightness cut that best splits ink from ground), box_iou, box_shift, and crop_ssim_2x. The stage runner in src/checker/stages.py has stages S0 to S7 plus S8 layout, which runs only when the config asks for it and is informational, not a gate. A font stage fits the same pattern: a new stage that runs after the text boxes are known, informational first, and only becomes a gate after calibration.

The engine already renders text from font files. assets/fonts/ holds Montserrat-Bold.ttf and Anton-Regular.ttf, verified by reading their name tables with fontTools. Scenes declare fonts with family, weight, and a file path. The renderer loads them in the browser.

### Recommended build: template matching first

Build the simple thing first. It needs no training, no GPU, and no new model. It runs on the machine we already have, in the Python virtual environment the checker already uses (Pillow and fontTools are already there).

Inputs per label:
- The cropped text from the reference frame, from the existing ink_box.
- The text string, read from the scene file. We know what the label says, so there is no OCR step.
- The measured cap height and box width, which set the render size.

Method, per candidate font:
1. Render the same string with Pillow at the measured cap height.
2. Binarize both the reference crop and the render (Otsu, as text.py already does).
3. Normalize both to the same box: same height, same baseline, same letter spacing. This step matters most. The real video may stretch or squeeze the text, and our scene already uses letter spacing (minus 6 pixels on the title). Search over a small range of horizontal scale and spacing values and keep the best score, or the matcher will punish the right font for the wrong spacing.
4. Score with normalized cross-correlation per glyph, averaged across the string, or with SSIM on the bitmaps (the checker already has ssim_frame). Report both the best score and the margin over the second best.

Ranking and confidence:
- Report the top 5 candidates with scores.
- Call it a match only when the best score is at least 0.85 and the margin over second place is at least 0.10. These numbers are a starting point, not a law. Calibrate them first (see below).
- Below that bar, report "closest lookalike, not confirmed", and send the crop to WhatTheFont or WhatFontIs in the browser for the commercial case.

Font library and legality:
- Start with Google Fonts. As of November 2026 it has 1,959 families. Nearly all are under the SIL Open Font License 1.1, a few under the Apache License. Both let us download, use, and embed the fonts freely, including in commercial work. We may not sell a font file on its own.
- Download from the Google Fonts repository (https://github.com/google/fonts) or the Google Fonts API, record the sha256 of each file in assets/fonts/README.md, exactly as the two fonts there are already recorded. Never take a font from a random download site. If the identified font is commercial (not on Google Fonts), do not download a copy. Buy a license, or use the closest open lookalike and say so in the report.
- Start the library small, about 50 families: the grotesques, condensed faces, and display faces most likely in news graphics. Grow it only when a label fails to match. A full 1,959 family scan is possible but slow; with 64 by 64 thumbnails in the Intellifont style it stays fast.

Where it plugs in:
- New module src/checker/font.py, with one function per step (crop, render, normalize, score, rank) so each step can be tested alone.
- New stage in stages.py, informational first, like S8. It reads the reference frame and the scene file, and writes a font report JSON next to the other check outputs.
- A command line entry, for example `python -m checker.font --ref <frame.png> --scene <scene.json>`, so it can run on its own without a full check.
- The scene author then swaps the font file in assets/fonts/ and re-renders. The checker never edits a scene on its own.

### Calibration before trusting it

Before the font stage judges anything, measure it on known answers.
1. Render ten labels in ten known Google Fonts, clean and at the same sizes as the Seg4 labels.
2. Run the matcher and record top-1 accuracy.
3. Repeat after recompressing the renders the way YouTube does (re-encode at low bitrate, add the 4 percent vertical stretch). Record top-1 accuracy again. This is the number that matters for our frames.
4. Only then set the match bar and the margin bar from the measured scores.

### Later: a small neural model

Build this only if template matching proves too slow or too weak on compressed frames. The recipe is DeepFont, scoped down: train a small convolutional network on synthetic renders of the Google Fonts library only (about 200 classes, not 2,383), with the same augmentation DeepFont used (noise, blur, warp, shading, spacing, aspect ratio) plus a YouTube compression step. That is a real training job: it needs a GPU, a day or more, and a careful dataset build. Do not start it until the template matcher has measured numbers that show it is not enough. A cheaper middle step is to use typeye's re-rank idea inside the template matcher: score the top 20 candidates, re-render the exact label text in each, and score again. That fixes most spacing and weight mistakes without any training.

## 8. Honest limits of template matching

- It can only name fonts already in the library. A font it has never seen will never win. The answer it gives is "the closest font in this library", not "the font".
- It is sensitive to spacing, weight, and stretch. A condensed font at the wrong letter spacing can score below a wrong font at the right spacing. The search over spacing and scale in section 7 is not optional.
- It is sensitive to image quality. YouTube compression blurs edges and adds block artifacts. Scores on our frames will be lower than on clean renders, and the calibration step must measure how much lower.
- It cannot tell two near identical fonts apart at small sizes. At 27 pixels tall, several grotesques differ by a few pixels per letter. When the top two scores are within the margin, the honest answer is a tie, not a guess.
- It does not replace WhatTheFont for commercial fonts. If the real font is a licensed face such as Gotham, the open library has no copy. The matcher will return the closest open lookalike, and the report must say that plainly.

## 9. The one line version

WhatTheFont is a 50 layer neural network trained on 33 million rendered images that ranks fonts by visual similarity. The open version of the same idea is simpler: render each candidate font, compare the letter shapes pixel by pixel, and rank them. For our checker, that simple version is the right first build, because our labels are short, we already know the text, and our font library is free and legal.

## Sources

- Monotype, "AI in the creative industry" (50 layer network, 33 million images, distortion pipeline): https://www.monotype.com/resources/expertise/ai-creative-industry
- Fast Company, "This App Uses Machine Learning To Identify Esoteric Fonts" (250 images per font, 133,000 fonts, 90 percent accuracy): https://www.fastcompany.com/90149756/this-app-uses-machine-learning-to-identify-esoteric-fonts
- Seah Chickering-Burchesky, "WhatTheFont" (v1 manual letters and vector outlines, v2 deep learning): https://www.seahcb.com/work/whatthefont
- Monotype help, "Using WhatTheFont" (upload, select text, identify, sync): https://support.monotype.com/en/articles/7861298-using-whatthefont
- Hyperallergic, "The Shazam for Typefaces Will Tell You If That's Helvetica or Futura" (90 percent, MyFonts database limit): https://hyperallergic.com/shazam-for-typefaces-whatthefont/
- Wang and others, "DeepFont: Identify Your Font from An Image", ACM Multimedia 2015 (AdobeVFR dataset, CNN split, SCAE, 80 percent top-5): https://arxiv.org/abs/1507.03196 and https://ar5iv.labs.arxiv.org/html/1507.03196
- artset/WhatTheFont, TensorFlow DeepFont reimplementation, 150 classes: https://github.com/artset/WhatTheFont
- robinreni96/Font_Recognition-DeepFont, Keras DeepFont reimplementation: https://github.com/robinreni96/Font_Recognition-DeepFont
- fontident, PyPI 0.1.0 (offline glyph template matching with normalized cross-correlation): https://pypi.org/project/fontident/0.1.0/
- Intellifont, Apache 2.0 (Rust and Node, 64 by 64 thumbnails, 2,042 fonts): https://github.com/magic-emperor/Intellifont
- typeye, on-device Google Fonts matcher, 2,004 families, 93 percent top-5 on rendered text: https://typeye.com/
- fontfinderAI, Google Fonts matching web app: https://github.com/puvy123/fontfinderAI
- WhatFontIs, 1.2 million fonts, free and commercial: https://es.whatfontis.com/
- Google Fonts, 1,959 families as of November 2026, SIL Open Font License: https://en.wikipedia.org/wiki/Google_Fonts
