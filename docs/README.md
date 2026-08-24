# Submission artefacts

`pitch-deck.html` — the 12-slide pitch deck. Open it in a browser and print to PDF
(Ctrl/Cmd-P → Save as PDF); it carries print styles that render one slide per
landscape page, so the exported PDF is the submission copy.

Every figure on it is reproducible from the repository at a fixed seed:

    npx tsx scripts/build-snapshot.mts    # the national and per-district artefacts
    npx tsx scripts/eval-censoring.mts    # the forecast-bias figures
    npx tsx scripts/demo-district.mts DST-22-BASTAR

Where a slide quotes a district figure it quotes the shipped artefact in
`src/data/districts/`, not a script run, because that is what the deployed site
serves and therefore what a reader can check.
