// Record the same test in both modes, then make a silent side-by-side README preview.
// Run from the repository root: node bench/media/narrated-video/render.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('docs/media', { recursive: true });
for (const mode of ['video', 'demo']) {
  const output = `workbench/narrated-${mode}`;
  execFileSync(process.execPath, [
    'packages/playwright/cli.js', 'test',
    '--config=bench/media/narrated-video/playwright.config.ts',
    `--${mode}`, `--output=${output}`,
  ], { stdio: 'inherit', env: { ...process.env, FLASHWRIGHT_SESSION: '0' } });
  copyFileSync(`${output}/video.mp4`, `docs/media/narrated-${mode}.mp4`);
}

const common = ['-hide_banner', '-loglevel', 'error', '-y'];
execFileSync('ffmpeg', [...common,
  '-i', 'docs/media/narrated-video.mp4', '-i', 'docs/media/narrated-demo.mp4',
  '-filter_complex', '[0:v]scale=640:-2,setsar=1,tpad=stop_mode=clone:stop_duration=60[left];[1:v]scale=640:-2,setsar=1,tpad=stop_mode=clone:stop_duration=60[right];[left][right]hstack=inputs=2[v]',
  '-map', '[v]', '-t', '22', '-an', '-c:v', 'libx264', '-crf', '23', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', 'workbench/narrated-comparison.mp4',
], { stdio: 'inherit' });
execFileSync('ffmpeg', [...common, '-i', 'workbench/narrated-comparison.mp4',
  '-filter_complex', 'fps=6,scale=1000:-2,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer',
  '-loop', '0', 'docs/media/narrated-comparison.gif',
], { stdio: 'inherit' });
