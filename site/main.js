// The landing page. Terminal frames come from frames.js, which npm run site:frames records from the real bridge.
(() => {
  const F = window.FLEET_FRAMES;
  // With reduce motion on, the terminal playback still runs: it is text changing in place, not movement. What does
  // move (the slide-in on scroll, the pulsing dots, smooth scrolling) is turned off in style.css, so there is no
  // fade to wait for either.
  const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const BOLD = 1, DIM = 2, ITALIC = 4, UNDERLINE = 8, REVERSE = 16;
  const TEXT = 0xe6edf3, INK = 0x0d1117;
  const hex = (n) => "#" + n.toString(16).padStart(6, "0");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  // Latin and the box drawing and block ranges are in the terminal font; anything else may come from a fallback
  // font with other metrics, so each such character gets a cell of its own, one ch wide.
  const RISKY = /[^\u0000-\u024f\u2500-\u259f]/gu;
  const cells = (s) => esc(s).replace(RISKY, (ch) => `<i class="c">${ch}</i>`);

  /** One frame as HTML. `decorate` may add classes to a run, from its text and style. */
  function html(frame, decorate) {
    return frame.lines.map((i) => F.rows[i].map(([text, fg, bg, attr]) => {
      let f = fg, b = bg;
      if (attr & REVERSE) { f = bg === -1 ? INK : bg; b = fg === -1 ? TEXT : fg; }
      const style = (f !== -1 ? `color:${hex(f)};` : "") + (b !== -1 ? `background:${hex(b)};` : "");
      const cls = [attr & BOLD && "b", attr & DIM && "d", attr & ITALIC && "i", attr & UNDERLINE && "u", decorate?.(text, attr)].filter(Boolean).join(" ");
      return `<span${cls ? ` class="${cls}"` : ""}${style ? ` style="${style}"` : ""}>${cells(text)}</span>`;
    }).join("")).join("\n");
  }

  /**
   * Plays `count` frames at 30 a second, by the clock rather than by counting timer ticks, so a busy or
   * throttled page drops frames instead of slowing down or catching up in a burst. `draw(i)` shows frame i.
   */
  function player(count, draw, { hold = 0, loop = false, done } = {}) {
    let raf = 0, start = 0, offset = 0, playing = false, last = -1;
    const step = (now) => {
      const t = offset + now - start;
      const i = Math.min(count - 1, Math.floor(t / 33));
      if (i !== last) { last = i; draw(i); }
      if (i < count - 1 || t < count * 33 + hold) { raf = requestAnimationFrame(step); return; }
      playing = false;
      if (loop) { offset = 0; last = -1; play(); } else done?.();
    };
    function play() {
      if (playing) return;
      playing = true;
      start = performance.now();
      raf = requestAnimationFrame(step);
    }
    function pause() {
      if (!playing) return;
      playing = false;
      cancelAnimationFrame(raf);
      offset += performance.now() - start;
    }
    function reset() { pause(); offset = 0; last = -1; }
    function restart() { reset(); play(); }
    return { play, pause, reset, restart };
  }

  /** Calls `on` while `el` is at least `share` on screen, and `off` when it leaves. */
  function whileVisible(el, share, on, off) {
    new IntersectionObserver((es) => (es[0].isIntersecting ? on() : off()), { threshold: share }).observe(el);
  }

  // Hero: the boot animation, a beat after the page settles, then the status dots breathe.
  const boot = document.getElementById("boot");
  const bootRest = () => (boot.innerHTML = html(F.boot[F.boot.length - 1], (t) => (t === "●" ? "led" : "")));
  const bootPlayer = player(F.boot.length, (i) => {
    if (i === F.boot.length - 1) return bootRest();
    boot.innerHTML = html(F.boot[i], (_, a) => (a & BOLD ? "glow" : ""));
  });
  boot.addEventListener("click", () => bootPlayer.restart());
  document.fonts.ready.then(() => setTimeout(bootPlayer.play, 450));

  // Nav border once scrolled.
  const nav = document.querySelector(".nav");
  addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });

  // Copy buttons.
  document.querySelectorAll(".cmd").forEach((el) => {
    const btn = el.querySelector(".copy");
    btn?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(el.dataset.copy); } catch { return; }
      btn.textContent = "copied";
      btn.classList.add("done");
      setTimeout(() => { btn.textContent = "copy"; btn.classList.remove("done"); }, 1600);
    });
  });

  // Reveal sections as they scroll in. REVEAL_MS is how long the fade takes (style.css .reveal), with its delay.
  const REVEAL_MS = 950;
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { threshold: 0.12 });
  document.querySelectorAll(".section-head, .fan, .window, .feat, .widget, .steps li, .commands, .cta > *").forEach((el, i) => {
    el.classList.add("reveal");
    el.style.transitionDelay = `${(i % 3) * 70}ms`;
    io.observe(el);
  });

  // Feature cards: a glow that follows the pointer.
  document.querySelectorAll(".feat").forEach((el) => el.addEventListener("pointermove", (e) => {
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  }));

  // How it works: wires from the repo to each host, and packets that carry each part of the config.
  const fan = document.getElementById("fan");
  const svg = fan.querySelector(".wires");
  const repo = fan.querySelector(".repo");
  const hosts = [...fan.querySelectorAll(".host")];
  const items = [...fan.querySelectorAll(".tree li[data-k]")];
  const LABELS = ["AGENTS.md", "skills", "mcp", "settings", "secrets"];
  const NS = "http://www.w3.org/2000/svg";
  let paths = [];
  function wire() {
    const box = fan.getBoundingClientRect();
    const r = repo.getBoundingClientRect();
    const x0 = r.right - box.left, y0 = r.top + r.height / 2 - box.top;
    svg.setAttribute("viewBox", `0 0 ${box.width} ${box.height}`);
    // The gradient is in page units: one sized to its path would vanish on the straight middle wire, whose box
    // has no height. The same goes for a CSS filter, so the glow is a wide faint path behind each wire.
    const x1 = hosts[0].getBoundingClientRect().left - box.left;
    svg.innerHTML = `<defs><linearGradient id="wire" gradientUnits="userSpaceOnUse" x1="${x0}" x2="${x1}"><stop offset="0" stop-color="#3fb950"/><stop offset="1" stop-color="#3fb950" stop-opacity=".55"/></linearGradient></defs>`;
    paths = hosts.map((h) => {
      const b = h.getBoundingClientRect();
      const x1 = b.left - box.left, y1 = b.top + b.height / 2 - box.top, mx = (x0 + x1) / 2;
      const d = `M${x0} ${y0} C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`;
      const halo = document.createElementNS(NS, "path");
      halo.setAttribute("d", d);
      halo.setAttribute("class", "halo");
      svg.appendChild(halo);
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
      return p;
    });
  }
  function packet(path, ms) {
    return new Promise((done) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("r", "5");
      c.setAttribute("class", "packet");
      svg.appendChild(c);
      const len = path.getTotalLength();
      const t0 = performance.now();
      let over = false;
      const finish = () => { if (!over) { over = true; c.remove(); done(); } };
      // Frames stop in a background tab; the timer makes sure the packet still arrives.
      setTimeout(finish, ms + 150);
      const step = (now) => {
        if (over) return;
        const k = Math.min(1, (now - t0) / ms);
        const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        const pt = path.getPointAtLength(e * len);
        c.setAttribute("cx", pt.x);
        c.setAttribute("cy", pt.y);
        if (k < 1) requestAnimationFrame(step); else finish();
      };
      requestAnimationFrame(step);
    });
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let fanRunning = false;
  async function runFan() {
    if (fanRunning) return;
    fanRunning = true;
    const wide = () => getComputedStyle(svg).display !== "none";
    for (;;) {
      hosts.forEach((h) => { h.classList.remove("synced"); h.querySelector(".chips").innerHTML = ""; });
      await wait(700);
      for (const [k, li] of items.entries()) {
        li.classList.add("lit");
        svg.classList.add("live");
        await Promise.all(hosts.map(async (h, i) => {
          if (wide()) await packet(paths[i], 1300 + i * 150);
          else await wait(500);
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = LABELS[k];
          h.querySelector(".chips").appendChild(chip);
          h.classList.add("hit");
          setTimeout(() => h.classList.remove("hit"), 300);
        }));
        li.classList.remove("lit");
        await wait(120);
      }
      svg.classList.remove("live");
      for (const h of hosts) { h.classList.add("synced"); await wait(160); }
      await wait(4500);
    }
  }
  wire();
  addEventListener("resize", wire);
  document.fonts.ready.then(wire);
  // Starts once the section has faded in, so the first packets are not drawn half transparent.
  new IntersectionObserver((es) => es[0].isIntersecting && setTimeout(runFan, calm ? 0 : REVEAL_MS), { threshold: 0.4 }).observe(fan);

  // The blocks in the feature cards: the same recorded text as the bridge window, as it is, without a clock.
  const block = (id, frame) => { document.getElementById(id).innerHTML = html(frame); };
  block("review", F.review);
  block("context-bars", F.contextBars);

  // The bridge window: real screens, and a push played frame by frame.
  const term = document.getElementById("term");
  const wrap = term.parentElement;
  const caption = document.getElementById("caption");
  const CAPTIONS = {
    home: "Every host at a glance. Cards from the last run start out marked seen 2h ago, then go live as each host answers. box times out, so it turns unreachable.",
    matrix: "Which skill bundles and MCP servers each host gets, from the defaults or its own host file.",
    conflicts: "What stopped an apply, and the exact fix. Fleet never overwrites what it did not write.",
    push: "Review what will be published, type push to confirm, then watch it land on each host in turn. edge has no ssh, so it catches up on its own timer.",
    context: "What each agent loads before its first prompt, in estimated tokens, with every host on one scale. The selection moves down the hosts and the list below shows each one's largest items. box has an older fleet, and edge has no ssh to ask.",
    palette: "ctrl-k jumps anywhere: a host, a server, a screen, or an action like doctor.",
    help: "? lists every key in the bridge. esc closes it and takes you back.",
  };
  let ratio = 0.6;
  function measure() {
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;font:100px var(--mono);white-space:pre";
    probe.textContent = "─".repeat(50);
    document.body.appendChild(probe);
    ratio = probe.getBoundingClientRect().width / 5000;
    probe.remove();
  }
  let current = null;
  function fit(frame) {
    const w = wrap.clientWidth - 24;
    term.style.fontSize = `${Math.min(15, w / (frame.cols * ratio))}px`;
  }
  const paint = (frame) => { current = frame; fit(frame); term.innerHTML = html(frame); };
  // Home and context play once and hold on the last frame; the push loops; the other screens are stills.
  const clips = {
    home: { frames: F.homeFill },
    push: { frames: F.push, opts: { hold: 3500, loop: true } },
    context: { frames: F.context },
  };
  for (const c of Object.values(clips)) c.player = player(c.frames.length, (i) => paint(c.frames[i]), c.opts);

  // A clip plays only while the window is on screen, and the first time not before it has faded in.
  let screenNow = "home", visible = false, fadedAt = null, wake;
  const lag = () => Math.max(0, fadedAt - performance.now());
  function engage() {
    clearTimeout(wake);
    const clip = clips[screenNow];
    if (clip && visible) wake = setTimeout(clip.player.play, lag());
  }
  function show(screen) {
    screenNow = screen;
    for (const c of Object.values(clips)) c.player.reset();
    // Tabs and chips show the same selection, whichever of tab, chip or key chose it.
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.screen === screen)));
    document.querySelectorAll(".keys button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.screen === screen)));
    caption.textContent = CAPTIONS[screen];
    paint(clips[screen] ? clips[screen].frames[0] : F.screens[screen]);
    engage();
  }
  whileVisible(term, 0.35, () => {
    visible = true;
    fadedAt ??= performance.now() + (calm ? 0 : REVEAL_MS);
    engage();
  }, () => {
    visible = false;
    clearTimeout(wake);
    clips[screenNow]?.player.pause();
  });
  document.querySelectorAll(".tabs button, .keys button").forEach((b) => b.addEventListener("click", () => show(b.dataset.screen)));
  // The hero's link still scrolls to the window; it also picks the clip it names.
  document.querySelectorAll("[data-play]").forEach((a) => a.addEventListener("click", () => show(a.dataset.play)));
  addEventListener("resize", () => current && fit(current));

  // The bridge's keys, while the terminal, a tab or a key chip has focus: clicking a tab or chip moves focus onto
  // it, and the keys should keep working after that. Only keys it handles are claimed: tab, arrows, space, page
  // keys and every browser shortcut are left alone, so focus can move on and the page still scrolls.
  const KEYS = { 1: "home", 2: "matrix", 3: "conflicts", c: "conflicts", 7: "push", P: "push", 8: "context", ":": "palette", "?": "help" };
  // The bridge has these screens; the page has no recording of them yet.
  const MISSING = new Set(["4", "5", "6"]);
  const bar = document.querySelector(".window-bar");
  let nudge;
  function flash() {
    bar.classList.add("nudge");
    clearTimeout(nudge);
    nudge = setTimeout(() => bar.classList.remove("nudge"), 450);
  }
  function onKey(e) {
    if (e.altKey || e.metaKey || e.isComposing) return;
    let screen;
    if (e.ctrlKey) screen = e.key === "k" ? "palette" : undefined;
    else if (e.key === "Escape") {
      if (screenNow === "home") document.activeElement.blur(); else show("home");
      e.preventDefault();
      return;
    } else if (MISSING.has(e.key)) { e.preventDefault(); if (!e.repeat) flash(); return; }
    else screen = KEYS[e.key];
    if (!screen) return;
    e.preventDefault();
    if (!e.repeat) show(screen);
  }
  for (const el of [bar.closest(".window"), document.getElementById("keys")]) el.addEventListener("keydown", onKey);
  document.fonts.ready.then(() => { measure(); show("home"); });
})();
