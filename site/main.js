// The landing page. Terminal frames come from frames.js, which site/export.ts renders from the real TUI.
(() => {
  const F = window.FLEET_FRAMES;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const BOLD = 1, DIM = 2, ITALIC = 4, UNDERLINE = 8, REVERSE = 16;
  const TEXT = 0xe6edf3, INK = 0x0d1117;
  const hex = (n) => "#" + n.toString(16).padStart(6, "0");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

  /** One frame as HTML. `decorate` may add classes to a run, from its text and style. */
  function html(frame, decorate) {
    return frame.lines.map((i) => F.rows[i].map(([text, fg, bg, attr]) => {
      let f = fg, b = bg;
      if (attr & REVERSE) { f = bg === -1 ? INK : bg; b = fg === -1 ? TEXT : fg; }
      const style = (f !== -1 ? `color:${hex(f)};` : "") + (b !== -1 ? `background:${hex(b)};` : "");
      const cls = [attr & BOLD && "b", attr & DIM && "d", attr & ITALIC && "i", attr & UNDERLINE && "u", decorate?.(text, attr)].filter(Boolean).join(" ");
      return `<span${cls ? ` class="${cls}"` : ""}${style ? ` style="${style}"` : ""}>${esc(text)}</span>`;
    }).join("")).join("\n");
  }

  // Hero: the boot animation, then the status dots breathe.
  const boot = document.getElementById("boot");
  let bootTimer;
  function playBoot() {
    clearInterval(bootTimer);
    const last = F.boot.length - 1;
    const rest = () => (boot.innerHTML = html(F.boot[last], (t) => (t === "●" ? "led" : "")));
    if (still) return rest();
    let i = 0;
    bootTimer = setInterval(() => {
      if (i >= last) { clearInterval(bootTimer); return rest(); }
      boot.innerHTML = html(F.boot[i++], (_, a) => (a & BOLD ? "glow" : ""));
    }, 33);
  }
  boot.addEventListener("click", playBoot);
  document.fonts.ready.then(playBoot);

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

  // Reveal sections as they scroll in.
  const io = new IntersectionObserver((es) => es.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { threshold: 0.12 });
  document.querySelectorAll(".section-head, .fan, .window, .feat, .steps li, .commands, .cta > *").forEach((el, i) => {
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
    svg.innerHTML = `<defs><linearGradient id="wire" x1="0" x2="1"><stop offset="0" stop-color="#3fb950"/><stop offset="1" stop-color="#3fb950" stop-opacity=".25"/></linearGradient></defs>`;
    paths = hosts.map((h) => {
      const b = h.getBoundingClientRect();
      const x1 = b.left - box.left, y1 = b.top + b.height / 2 - box.top, mx = (x0 + x1) / 2;
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", `M${x0} ${y0} C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`);
      svg.appendChild(p);
      return p;
    });
  }
  function packet(path, ms) {
    return new Promise((done) => {
      const c = document.createElementNS(NS, "circle");
      c.setAttribute("r", "4");
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
        paths.forEach((p) => p.classList.add("live"));
        await Promise.all(hosts.map(async (h, i) => {
          if (wide() && !still) await packet(paths[i], 900 + i * 120);
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
      paths.forEach((p) => p.classList.remove("live"));
      for (const h of hosts) { h.classList.add("synced"); await wait(160); }
      if (still) return;
      await wait(4500);
    }
  }
  wire();
  addEventListener("resize", wire);
  document.fonts.ready.then(wire);
  new IntersectionObserver((es) => es[0].isIntersecting && runFan(), { threshold: 0.4 }).observe(fan);

  // The bridge window: real screens, the push played at the bridge's own frame rate.
  const term = document.getElementById("term");
  const wrap = term.parentElement;
  const caption = document.getElementById("caption");
  const CAPTIONS = {
    push: "Review what will be published, type push to confirm, then watch it land on each host in turn. edge has no ssh, so it catches up on its own timer.",
    home: "Every host at a glance: pending changes, conflicts, tool versions, and which ones are unreachable.",
    matrix: "Which skill bundles and MCP servers each host gets, from the defaults or its own host file.",
    conflicts: "What stopped an apply, and the exact fix. Fleet never overwrites what it did not write.",
    palette: "ctrl-k jumps anywhere: a host, a server, a screen, or an action like doctor.",
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
  let pushTimer;
  function show(screen) {
    clearTimeout(pushTimer);
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.screen === screen)));
    caption.textContent = CAPTIONS[screen];
    if (screen !== "push") { current = F.screens[screen]; fit(current); term.innerHTML = html(current); return; }
    let i = still ? F.push.length - 1 : 0;
    const tick = () => {
      current = F.push[i];
      fit(current);
      term.innerHTML = html(current);
      if (still) return;
      const end = i === F.push.length - 1;
      i = end ? 0 : i + 1;
      pushTimer = setTimeout(tick, end ? 3000 : 33);
    };
    tick();
  }
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.screen)));
  addEventListener("resize", () => current && fit(current));
  document.fonts.ready.then(() => { measure(); show("push"); });
})();
