# Videos of your tests

[Back to the README](../README.md)

`npx playwright test --video` makes a video of the run with narration, captions, a moving cursor and a camera that follows the action. Use `narrate` when you want to explain what's happening:

```ts
test('keeps the schedule after a reload', async ({ page, narrate }) => {
  await narrate('Choose the timezone and save the schedule.');
  await page.getByLabel('Timezone').fill('Europe/Oslo');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.reload();
  await expect(page.getByLabel('Timezone')).toHaveValue('Europe/Oslo');
  await narrate('The timezone stays selected after a reload.');
});
```

`narrate` does nothing in other runs, and tests without it still get a video, with captions made from what they click, type and assert. It is one video however many tests run, in the order they are written and with a chapter for each, in `test-results/video.mp4`, and a clip of each test in the test's folder. It needs `ffmpeg`.

- **`--video`** is for your team: each test's title, a caption for each action and assertion, the error of a test that failed, and how many passed.
- **`--demo`** is for everyone else: only the page and what `narrate` said, without test names or results. Tests that failed are left out, and the run says which.

The video is assembled after the tests. It holds real page frames while the voice speaks and the cursor moves, so the tests don't wait for narration. A test recording does wait a moment after each action for the browser to show the result, otherwise a fast test would move on before its result was painted: TodoMVC's filter test takes 0.6 s with `--video` and 0.14 s without. Rendering then takes about half as long as the video lasts on 6 cores. The timing you see in a video is not the test's, so it says nothing about how fast your app is.

The voice comes from your system by default: `say` on macOS, Windows' speech engine, or `espeak-ng` on Linux. Without one, the video has captions only. `npx playwright install-voice` downloads Kokoro, a free and much more natural voice that runs on your machine (about 500 MB, outside the project), and runs use it from then on. Sentences are kept between runs, so reruns do not read them again (`FLASHWRIGHT_VOICE_CACHE` sets the folder, for CI).

```ts
export default defineConfig({
  narratedVideo: {
    mode: 'on',        // 'off' (default), 'on' like --video, 'demo' like --demo
    zoom: true,        // the camera; --no-video-zoom turns it off
    captions: true,    // --no-video-captions; the subtitle track stays, off unless a player asks for it
    voice: 'auto',     // 'auto', 'system', 'kokoro', false (--no-video-voice), or a function that returns the audio, for a paid voice
    voiceName: 'Samantha',
  },
});
```

Captions show the text that tests type, including passwords, and the page shows what your app shows, so use test data you are happy to share. Recording replaces the `video` option, turns off the screenshots of `trace` and gives each test a new context, and a test cannot use `page.screencast` itself in that run. `summary.json` in [agent mode](agents.md#agent-mode) has the video's path.
