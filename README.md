# Print Proofer

Snap a photo or a screenshot of anything you're about to print or post (a flyer, business card, menu, sign or ad) and get every mistake flagged before it goes out:

- **Spelling and typos**, including wrong homophones (their/there, its/it's)
- **Grammar and punctuation**, including apostrophe misuse ("Taco's")
- **Consistency**: the same name, price, phone number or time written two different ways
- **Facts it can check**: a weekday that doesn't match the date, a phone number with a missing digit, a broken email or web address
- **Layout**: text cut off or too close to the edge, uneven spacing

Each problem is shown as *wrong → right* with a one-line reason. Problems are highlighted on the text as printed, and a fully corrected version is ready to copy.

It's an installable web app (PWA) that works on Android. The proofreading is done by Claude (`claude-opus-5-5`) through the Anthropic API, using your own API key.

## Put it on your Android phone

1. Host it (see below) and open the link in **Chrome** on your phone.
2. Tap **⋮ → Add to Home screen → Install**. It now opens like a normal app.
3. Tap **⚙︎** and paste your Anthropic API key (create one at https://platform.claude.com/settings/keys).
4. Use **Take photo** or **Upload / screenshot**. Or, from your Gallery or Photos app, tap **Share → Print Proofer** to send a screenshot straight in.

Optional: under Settings → *Always-on notes*, list names and spellings you use often (your business name, phone number, website). The checker treats them as correct and flags anything that doesn't match.

## Hosting (free, on GitHub Pages)

1. Merge this code into the `main` branch.
2. In the repo on GitHub, go to **Settings → Pages → Source** and pick **GitHub Actions**.
3. Every push to `main` deploys to `https://<your-username>.github.io/print-proofer/`.

GitHub Pages on a **private** repo requires a paid GitHub plan. Other options are to make the repo public (your API key is never in the code; it stays on your phone) or to deploy the `dist/` folder to Netlify, Vercel or Cloudflare Pages.

## Cost

Each check is one Claude API call, billed to your Anthropic account. A typical one-page flyer costs a few cents.

## Privacy

- Your API key is stored only in your phone's browser storage and is sent only to Anthropic.
- Images go straight from your phone to the Anthropic API. There is no other server.
- The 15 most recent results (text only, no images) are kept on the phone under *Recent checks*. Tap **Clear** to remove them.

## Development

```bash
npm install
npm run dev      # local dev server (use --host to open it from your phone on the same Wi-Fi)
npm run build    # type-check and build to dist/
```

| File | What it does |
|---|---|
| `src/proof.ts` | The Claude API call, the proofreading prompt and the result schema |
| `src/main.ts` | UI: image capture and resize, results, history, settings |
| `public/sw.js` | Service worker: offline shell and the Android share-sheet target |
| `public/manifest.webmanifest` | App name, icons, install and share settings |
