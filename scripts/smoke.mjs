/**
 * Interaction smoke test — exercise every control the UI exposes, including a
 * real file upload, and fail on any console error, page error, or shader
 * failure.
 *
 *   node scripts/smoke.mjs <url>
 */
import puppeteer from 'puppeteer-core';

const CHROME = 'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe';
const URL = process.argv[2] ?? 'http://127.0.0.1:5173/';
const OUT = 'C:\\\\Users\\\\mj345\\\\AppData\\\\Local\\\\Temp\\\\opencode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const errors = [];
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  // NOTE: no --autoplay-policy override. The other harnesses pass it and it
  // hides the real browser behaviour, which is exactly how the upload bug and
  // the bundled-track failure slipped through.
  args: ['--no-sandbox', '--hide-scrollbars', '--use-angle=d3d11', '--ignore-gpu-blocklist'],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[bar')) console.log('      [event]', t);
  if (/Shader Error|VALIDATE_STATUS|not compiled|ERROR:\s*\d+:\d+/.test(t)) errors.push('SHADER: ' + t.slice(0, 400));
  else if (m.type() === 'error' && !/favicon/.test(t)) errors.push('console: ' + t.slice(0, 200));
});
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 300)));

const step = async (name, fn) => {
  const before = errors.length;
  await fn();
  const added = errors.length - before;
  console.log(`${added || 'ok  '}  ${name}${added ? ` (+${added} errors)` : ''}`);
};

await page.goto(URL, { waitUntil: 'networkidle0' });
await sleep(3000);

await step('engine boots', async () => {
  if (!(await page.evaluate(() => !!window.__lab))) errors.push('engine did not boot');
});

await step('no cards or boxes behind the controls', async () => {
  const boxed = await page.evaluate(() => {
    const sel = ['.seg', '.src', '.play', '.bar', '.round-btn'];
    return sel.flatMap((s) => [...document.querySelectorAll(s)])
      .filter((el) => {
        const bg = getComputedStyle(el).backgroundColor;
        const m = bg.match(/rgba?\(([^)]+)\)/);
        if (!m) return false;
        const p = m[1].split(',').map((v) => parseFloat(v));
        return (p[3] ?? 1) > 0.92 && p[0] > 235 && p[1] > 235 && p[2] > 235;
      }).length;
  });
  if (boxed) errors.push(`${boxed} control elements are painted as opaque cards`);
});

await step('the bundled track is actually served', async () => {
  // Range request, because that is what a media element makes and a static
  // host that ignores it is a common cause of "the browser cannot play this".
  const head = await page.evaluate(async () => {
    const res = await fetch('zen-tones.mp3', { headers: { Range: 'bytes=0-1023' } });
    return { status: res.status, type: res.headers.get('content-type'), ranges: res.headers.get('accept-ranges'), len: (await res.arrayBuffer()).byteLength };
  });
  if (head.status !== 200 && head.status !== 206) errors.push(`zen-tones.mp3 fetch returned ${head.status}`);
  if (!/mpeg|audio/.test(head.type || '')) errors.push(`zen-tones.mp3 served as "${head.type}"`);
  if (!head.len) errors.push('zen-tones.mp3 returned no bytes');
});

await step('frequency mode: slider present, silent, ends at the measured band', async () => {
  const ok = await page.evaluate(() => ({
    slider: !!document.querySelector('.freq-slider'),
    tag: document.querySelector('.freq-slider') ? document.querySelector('.freq-slider').getAttribute('min') : null,
    max: document.querySelector('.freq-slider') ? document.querySelector('.freq-slider').getAttribute('max') : null,
    tagText: document.querySelector('.tag')?.textContent ?? '',
  }));
  if (!ok.slider) errors.push('frequency mode has no slider');
  if (ok.tagText.trim() !== 'silent') errors.push(`frequency mode not marked silent ("${ok.tagText}")`);
  // the dead range is off the slider: 224 – 836 is where the water visibly
  // reacts (measured by scripts/visibleband.mjs)
  if (ok.tag !== '224' || ok.max !== '836') {
    errors.push(`slider range is ${ok.tag}–${ok.max}, expected 224–836`);
  }
});

await step('transport is present in BOTH driver modes', async () => {
  const before = await page.evaluate(() => document.querySelectorAll('.play').length);
  await page.evaluate(() => {
    [...document.querySelectorAll('.seg-btn')].find((b) => /tone/i.test(b.textContent || ''))?.click();
  });
  await sleep(400);
  const after = await page.evaluate(() => document.querySelectorAll('.play').length);
  if (before !== 1) errors.push(`frequency mode has ${before} transport buttons, expected 1`);
  if (after !== 1) errors.push(`tone mode has ${after} transport buttons, expected 1`);
});

await step('tone mode: NO slider, sources in a ROW', async () => {
  const s = await page.evaluate(() => {
    const srcs = document.querySelector('.srcs');
    const kids = [...(srcs?.children ?? [])];
    const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y }; };
    return {
      sliders: document.querySelectorAll('.freq-slider').length,
      n: kids.length,
      dir: srcs ? getComputedStyle(srcs).flexDirection : '',
      row: kids.length > 1 ? Math.abs(r(kids[0]).y - r(kids[1]).y) < 4 && r(kids[1]).x > r(kids[0]).x : false,
    };
  });
  if (s.sliders !== 0) errors.push(`tone mode still shows ${s.sliders} slider(s) — it must not`);
  if (s.n !== 3) errors.push(`expected 3 sources, found ${s.n}`);
  if (!s.row) errors.push(`sources are not laid out in a row (flex-direction: ${s.dir})`);
});

await step('vertical colour bar on the RIGHT, black included, no eyedropper', async () => {
  const s = await page.evaluate(() => {
    const bar = document.querySelector('.bar');
    const rail = document.querySelector('.rail-right');
    const b = bar.getBoundingClientRect();
    const r = rail.getBoundingClientRect();
    return {
      vertical: b.height > b.width * 3,
      onRight: r.x > window.innerWidth * 0.6,
      gradient: getComputedStyle(bar).backgroundImage,
      eyedrop: document.querySelectorAll('.eyedrop').length,
      cursorBottom: getComputedStyle(bar.querySelector('.bar-cursor')).bottom,
    };
  });
  if (!s.vertical) errors.push('colour bar is not vertical');
  if (!s.onRight) errors.push('colour bar is not on the right-hand side');
  if (!/rgb\(10, 10, 12\)|#0a0a0c/.test(s.gradient)) errors.push('black is missing from the spectrum bar');
  if (s.eyedrop !== 0) errors.push(`eyedropper is still present (${s.eyedrop})`);
  if (s.cursorBottom === 'auto') errors.push('bar cursor is not anchored bottom/top');
});

// THE regression test for "I click yellow and blue gets selected". The picker
// used to run mirrored to the gradient, so clicking the yellow you could see
// selected ~280°. This clicks the exact gradient position of hue 60° and
// asserts the result is actually yellow.
await step('clicking a colour on the bar selects THAT colour', async () => {
  const bar = await page.$('.bar');
  const b = await bar.boundingBox();
  const clickAt = async (t) => page.mouse.click(b.x + b.width / 2, b.y + b.height * (1 - t));
  const hex = async () => page.evaluate(() => document.querySelector('.bar-hex')?.textContent?.trim() ?? '');
  // hex reads as #rrggbb: after stripping '#', channels live at slices 0-2,
  // 2-4, 4-6. (An earlier version sliced at [1,3,5] as if '#' were still
  // present, which shifted every decoded channel by one hex digit and made the
  // CORRECT picker read as "click yellow get olive".)
  const rgbOf = (h) => {
    const s = h.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  };

  // debug: what is actually under the click point, and what gradient is live?
  const ctx = await page.evaluate(([cx, cy]) => {
    const el = document.elementFromPoint(cx, cy);
    const barEl = document.querySelector('.bar');
    return {
      under: el ? `${el.tagName}.${el.className}` : 'nothing',
      gradient: (getComputedStyle(barEl).backgroundImage || '').slice(0, 160),
      stopCount: ((getComputedStyle(barEl).backgroundImage || '').match(/rgb|hsl/g) ?? []).length,
    };
  }, [b.x + b.width / 2, b.y + b.height * (1 - 6 / 31)]);
  console.log('      [ctx]', JSON.stringify(ctx));

  // hue 60° is stop 6 of 31 → t = 6/31
  await clickAt(6 / 31);
  for (let i = 0; i < 6; i++) {
    const dbg = await page.evaluate(() => ({
      hex: document.querySelector('.bar-hex')?.textContent ?? '(null)',
      nhex: document.querySelectorAll('.bar-hex').length,
      cursorBg: document.querySelector('.bar-cursor')?.style.background ?? '(null)',
    }));
    console.log(`      [sample ${i}] ${dbg.hex}  x${dbg.nhex}  cursor=${dbg.cursorBg}`);
    if (i < 5) await sleep(200);
  }
  const yellow = rgbOf(await hex());
  const yellowish = yellow[0] > 190 && yellow[1] > 160 && yellow[2] < 80;
  if (!yellowish) {
    // dump what the picker actually did: the cursor inherits posOf and the
    // pigment straight from React state, so a correct cursor + a wrong hex
    // means something else is writing pigment afterwards
    const dbg = await page.evaluate(() => {
      const cur = document.querySelector('.bar-cursor');
      return {
        cursorBottom: cur.style.bottom,
        cursorBg: cur.style.background,
        hex: document.querySelector('.bar-hex')?.textContent?.trim(),
      };
    });
    errors.push(`clicking yellow got #? R${yellow[0]} G${yellow[1]} B${yellow[2]} — picker is still mirrored [cursor=${JSON.stringify(dbg)}]`);
  }

  // hue 240° (blue) is stop 21 of 31 → t = 21/31
  await clickAt(21 / 31); await sleep(700);
  const blue = rgbOf(await hex());
  const blueish = blue[2] > 190 && blue[0] < 90;
  if (!blueish) {
    // second read AFTER a long settle, so a slow React flush cannot masquerade
    await sleep(900);
    const blue2 = rgbOf(await hex());
    if (!blueish2(blue2)) errors.push(`clicking blue got R${blue[0]} G${blue[1]} B${blue[2]} / settle R${blue2[0]} G${blue2[1]} B${blue2[2]}`);
    function blueish2(v) { return v[2] > 190 && v[0] < 90; }
  }

  // cursor must sit centred on the position it was clicked at — with
  // bottom: pos% and translateY(+50%), the cursor's CENTRE is exactly on the
  // position, so compare centres, not raw box tops (which the transform moves)
  const cursor = await page.evaluate(() => {
    const bar = document.querySelector('.bar').getBoundingClientRect();
    const cur = document.querySelector('.bar-cursor').getBoundingClientRect();
    return (bar.bottom - (cur.top + cur.height / 2)) / bar.height;
  });
  if (Math.abs(cursor - 21 / 31) > 0.03) errors.push(`cursor centre sits at ${cursor.toFixed(3)}, clicked ${(21 / 31).toFixed(3)}`);

  // the drag test covers black → hue → white
  await page.mouse.move(b.x + b.width / 2, b.y + b.height - 4);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + 4, { steps: 18 });
  await page.mouse.up();
  await sleep(300);
  // channel slices run 0-2/2-4/4-6 AFTER the '#' is stripped (the last drag
  // lands in the pale magenta→white blend, so only luminance is checked)
  const lum = (h) => {
    const v = [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16));
    return (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255;
  };
  const mid = lum(await page.evaluate(() => document.querySelector('.bar-hex')?.textContent?.trim() ?? ''));
  if (mid < 0.25 || mid > 0.75) errors.push(`mid-drag colour is off (${mid.toFixed(2)})`);
});

await step('dragging the bar covers the whole spectrum', async () => {
  const bar = await page.$('.bar');
  const b = await bar.boundingBox();
  const hex = async () => page.evaluate(() => document.querySelector('.bar-hex')?.textContent?.trim() ?? '');
  const lum = (h) => {
    const v = [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16));
    return (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255;
  };
  await page.mouse.click(b.x + b.width / 2, b.y + 2); await sleep(250);
  const top = lum(await hex());
  await page.mouse.click(b.x + b.width / 2, b.y + b.height - 2); await sleep(250);
  const bottom = lum(await hex());
  if (bottom > 0.22) errors.push(`bottom of the bar is not black (luminance ${bottom.toFixed(2)})`);
  if (top < 0.78) errors.push(`top of the bar is not white (luminance ${top.toFixed(2)})`);
  if (Math.abs(top - bottom) < 0.5) errors.push('the two ends of the bar are the same colour');
});

await step('bundled track plays audibly from a real click', async () => {
  // Tone auto-starts Zen the moment it is entered (music-app behaviour), so
  // the track may already be running — and a click on the ACTIVE Zen button
  // is a stop gesture. Only click when nothing is playing.
  const already = await page.evaluate(() => {
    const p = window.__audioProbe;
    return !!p && p.kind === 'preset';
  });
  if (!already) await page.click('.src');
  await sleep(6500);
  const p = await page.evaluate(() => window.__audioProbe);
  if (!p || p.kind !== 'preset') {
    // dump WHY: the banner, the element's own state, and what React believes
    const why = await page.evaluate(() => ({
      err: document.querySelector('.ink-error')?.textContent ?? null,
      toneOn: [...document.querySelectorAll('.seg-btn')].find((b) => /tone/i.test(b.textContent || ''))?.classList.contains('on'),
      srcOn: document.querySelector('.src.on')?.textContent ?? null,
      audio: (() => { const a = document.querySelector('audio'); return a ? { paused: a.paused, src: a.currentSrc.split('/').pop(), err: a.error?.code ?? null, t: +a.currentTime.toFixed(1) } : null; })(),
      mode: window.__lab ? 'engine-alive' : 'engine-dead',
    }));
    console.log('      [why]', JSON.stringify(why));
    errors.push(`bundled track did not start (${JSON.stringify(p)})`);
  }
  else console.log(`      Zen Tones: centroid=${p.freq.toFixed(0)}Hz level=${p.level.toFixed(3)}`);
  if (!p || !(p.freq > 60)) errors.push('bundled track never reaches the analyser — it would be silent');
});

await step('tone transport: Pause flips to Play and back', async () => {
  await page.click('.play');
  await sleep(1200);
  let label = await page.evaluate(() => ({
    aria: document.querySelector('.play')?.getAttribute('aria-label'),
    text: document.querySelector('.play')?.textContent?.trim(),
  }));
  if (label.aria !== 'Play' || label.text !== 'Play') errors.push(`pause did not flip the button (${JSON.stringify(label)})`);
  await page.click('.play');
  await sleep(2500);
  label = await page.evaluate(() => ({
    aria: document.querySelector('.play')?.getAttribute('aria-label'),
    text: document.querySelector('.play')?.textContent?.trim(),
    probe: window.__audioProbe,
  }));
  if (label.aria !== 'Pause' || label.text !== 'Pause') errors.push(`resume did not flip the button (${JSON.stringify(label)})`);
  if (!label.probe || label.probe.level <= 0) errors.push('session did not continue');
  else console.log(`      resumed level=${label.probe.level.toFixed(3)}`);
});

await step('frequency transport starts/stops the silent drive, not audio', async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('.seg-btn')].find((b) => /frequency/i.test(b.textContent || ''))?.click();
  });
  await sleep(900);
  // The drive level is the thing this button owns, so assert on it directly —
  // dyeStats.mass counts PIGMENT, and no pigment has been dropped yet here.
  await page.click('.play');
  await sleep(2200);
  const paused = await page.evaluate(() => ({
    label: document.querySelector('.play')?.getAttribute('aria-label'),
    level: window.__lab.drive.level,
  }));
  if (paused.label !== 'Play') errors.push(`frequency Play/Pause did not flip (got "${paused.label}")`);
  // below the tone-mode floor (0.3) proves the silent drive stopped entirely
  if (paused.level > 0.3) errors.push(`pause did not stop the drive (level ${paused.level.toFixed(2)})`);
  await page.click('.play');
  await sleep(2600);
  const resumed = await page.evaluate(() => ({
    label: document.querySelector('.play')?.getAttribute('aria-label'),
    level: window.__lab.drive.level,
    slots: window.__lab.figure.slots.length,
  }));
  if (resumed.label !== 'Pause') errors.push(`frequency resume did not flip (got "${resumed.label}")`);
  if (resumed.level < 0.4) errors.push(`play did not bring the drive back (level ${resumed.level.toFixed(2)})`);
  if (resumed.slots === 0) errors.push('no modes are lit after the drive came back');
  console.log(`      freq drive: paused level=${paused.level.toFixed(2)} → resumed ${resumed.level.toFixed(2)} (${resumed.slots} modes)`);
});

await step('uploading a file plays (the old "browser refused" bug)', async () => {
  // must be in TONE mode: the render loop only polls the audio there, and in
  // frequency mode __audioProbe is legitimately null
  await page.evaluate(() => {
    [...document.querySelectorAll('.seg-btn')].find((b) => /tone/i.test(b.textContent || ''))?.click();
  });
  await sleep(300);
  const input = await page.$('input[type=file]');
  if (!input) { errors.push('no file input'); return; }
  await input.uploadFile(`${OUT}\\upload-test.mp3`);
  await sleep(5000);
  const s = await page.evaluate(() => ({
    err: document.querySelector('.ink-error')?.textContent ?? null,
    probe: window.__audioProbe,
    src: document.querySelector('.src.on')?.textContent ?? '',
    el: (() => { const a = document.querySelector('audio'); return a ? { paused: a.paused, err: a.error?.code ?? null } : null; })(),
  }));
  if (s.err) errors.push(`upload reported an error: ${s.err}`);
  if (s.el?.err) errors.push(`media element error code ${s.el.err}`);
  if (!s.probe || s.probe.kind !== 'file') errors.push(`uploaded file is not driving (${JSON.stringify(s.probe)})`);
  else console.log(`      file playing: centroid=${s.probe.freq.toFixed(0)}Hz`);
});

await step('back to frequency mode stops audio', async () => {
  await page.evaluate(() => {
    [...document.querySelectorAll('.seg-btn')].find((b) => /frequency/i.test(b.textContent || ''))?.click();
  });
  await sleep(600);
  const k = await page.evaluate(() => window.__audioProbe);
  if (k && k.kind) errors.push('leaving tone mode left audio running');
});

await step('the figure changes with the slider', async () => {
  const seen = [];
  // sweep points lie inside the MEASURED visible band (224–836 Hz); below it
  // and above it the drive clamps and the figure correctly stops changing
  for (const hz of [230, 320, 430, 560, 720]) {
    await page.evaluate((f) => { window.__lab.forcedDrive = { freq: f, level: 0.85 }; }, hz);
    await sleep(1400);
    seen.push(await page.evaluate(() => window.__lab.figure.slots.map((s) => `m${s.m}@${s.kR.toFixed(1)}`).join(',')));
  }
  const distinct = new Set(seen).size;
  if (distinct < 4) errors.push(`figure did not reorganise with frequency (${distinct}/5 distinct)`);
  else console.log(`      ${distinct}/5 distinct figures across the slider`);
  await page.evaluate(() => { window.__lab.forcedDrive = null; });
});

await step('drop ink by clicking the water', async () => {
  await page.mouse.click(640, 400);
  await sleep(1600);
  const mass = await page.evaluate(() => window.__lab.dyeStats().mass);
  if (!(mass > 0)) errors.push(`clicking the water deposited no pigment (mass ${mass})`);
});

await step('drag a stroke', async () => {
  await page.mouse.move(560, 380);
  await page.mouse.down();
  for (let i = 0; i <= 12; i++) await page.mouse.move(560 + i * 14, 380 + Math.sin(i / 2) * 28);
  await page.mouse.up();
  await sleep(2500);
  if (!(await page.evaluate(() => window.__lab.dyeStats().mass) > 0)) errors.push('drag deposited no pigment');
});

await sleep(2000);
await page.screenshot({ path: OUT + '\\smoke-ui.png' });

await step('clear', async () => {
  await page.click('.rail-utils button[aria-label="Clear pigment"]');
  await sleep(1200);
  if ((await page.evaluate(() => window.__lab.dyeStats().mass)) > 0.02) errors.push('clear left pigment behind');
});

await step('save (capture path)', async () => {
  const u = await page.evaluate(() => window.__lab.capture().slice(0, 22));
  if (!u.startsWith('data:image/png')) errors.push('capture did not return a PNG data URL');
});

await step('no microphone control anywhere', async () => {
  const n = await page.evaluate(() => document.querySelectorAll('[aria-label*="icrophone" i]').length);
  if (n !== 0) errors.push(`microphone control still present (${n})`);
});

await step('?demo=1 scripted sequence', async () => {
  const p2 = await browser.newPage();
  const demoErrs = [];
  p2.on('pageerror', (e) => demoErrs.push(String(e).slice(0, 200)));
  p2.on('console', (m) => { if (m.type() === 'error') demoErrs.push(m.text().slice(0, 200)); });
  await p2.goto(URL + '?demo=1&drive=432&level=0.85', { waitUntil: 'networkidle0' });
  await sleep(9000);
  if (!(await p2.evaluate(() => !!window.__lab))) demoErrs.push('demo mode did not boot');
  for (const e of demoErrs) errors.push('demo: ' + e);
  await p2.close();
});

console.log('\n' + (errors.length ? 'ERRORS:\n  ' + errors.join('\n  ') : 'ERRORS: none'));
await browser.close();
process.exit(errors.length ? 1 : 0);