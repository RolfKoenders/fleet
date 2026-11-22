// The docs pages: the side menu behind the Menu button on a phone, and the search field, which reads
// search.json next to the pages (nothing is loaded from another origin).
(() => {
  const base = document.body.dataset.base ?? "";
  const nav = document.querySelector(".nav");
  addEventListener("scroll", () => nav.classList.toggle("scrolled", scrollY > 8), { passive: true });

  const side = document.getElementById("doc-side");
  const btn = document.querySelector(".doc-menu-btn");
  btn.addEventListener("click", () => {
    const open = side.classList.toggle("open");
    btn.setAttribute("aria-expanded", String(open));
  });

  const field = document.getElementById("doc-search");
  const results = document.getElementById("doc-results");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let entries = null;
  const load = fetch(base + "search.json")
    .then((r) => r.json())
    .then((e) => (entries = e));
  field.addEventListener("focus", load);

  const show = (list) => {
    results.innerHTML = list.map((e) => `<a href="${base}${e.page}/${e.anchor ? "#" + e.anchor : ""}"><b>${esc(e.heading)}</b><span>${esc(e.title)}</span></a>`).join("");
    results.hidden = list.length === 0;
  };

  field.addEventListener("input", async () => {
    const q = field.value.trim().toLowerCase();
    if (q === "") return show([]);
    await load;
    show(entries.filter((e) => `${e.heading} ${e.text}`.toLowerCase().includes(q)).slice(0, 8));
  });

  addEventListener("keydown", (e) => {
    const inField = document.activeElement === field;
    if (e.key === "/" && !inField && !/INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement?.tagName ?? "")) {
      e.preventDefault();
      field.focus();
    } else if (e.key === "Escape" && inField) {
      field.value = "";
      show([]);
    }
  });
})();
