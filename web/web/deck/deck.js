// Slide deck: arrow keys, Page Up/Down, Home, and End move between slides; the URL hash follows the slide.
const slides = Array.from(document.querySelectorAll(".slide"));

function current() {
  const mid = window.innerHeight / 3;
  let best = 0;
  slides.forEach((slide, i) => {
    if (slide.getBoundingClientRect().top <= mid) best = i;
  });
  return best;
}

function go(i) {
  const n = Math.max(0, Math.min(slides.length - 1, i));
  slides[n].scrollIntoView({ block: "start" });
  history.replaceState(null, "", `#${slides[n].id}`);
}

document.addEventListener("keydown", (event) => {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const tag = event.target instanceof Element ? event.target.tagName : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const step = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[event.key];
  if (step) {
    event.preventDefault();
    go(current() + (event.shiftKey && event.key === " " ? -1 : step));
  } else if (event.key === "Home") {
    event.preventDefault();
    go(0);
  } else if (event.key === "End") {
    event.preventDefault();
    go(slides.length - 1);
  }
});
